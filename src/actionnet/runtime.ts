// Default pipeline runtime.
//
// Bridges the actionnet-namespaced runPipeline() facade to the upstream
// readFile / processDataTable / writeFile primitives. Kept in its own file so
// the public surface (runPipeline.ts) stays free of upstream type imports —
// that makes the public types tree-shakable for browser consumers that don't
// need the Node-side runtime.
//
// The runtime is best-effort: when WebGPU isn't available (Node without the
// webgpu polyfill installed, or older browsers) we fall back to CPU paths for
// SOG compression and voxelization, both of which the upstream library
// already supports via its non-GPU writers.

import type {
    PipelineArtifact,
    PipelineRuntime,
    RunPipelineHandle,
    RunPipelineProgress,
    RunPipelineRequest
} from './runPipeline';
import { contentTypeFor, filenameFor } from './runPipeline';

type ProgressSink = (p: RunPipelineProgress) => void;

async function loadUpstream() {
    // Dynamic so the file is importable in non-Node environments where the
    // upstream CJS bundle pulls in node:fs.
    const mod = await import('..');
    return mod;
}

class DefaultHandle implements RunPipelineHandle {
    private readonly _progressBuffer: RunPipelineProgress[] = [];
    private readonly _progressWaiters: ((v: IteratorResult<RunPipelineProgress>) => void)[] = [];
    private readonly _artifacts: Promise<PipelineArtifact[]>;
    private _cancelled = false;
    private _done = false;

    constructor(req: RunPipelineRequest) {
        this._artifacts = this._run(req, (p) => this._emit(p));
    }

    progress(): AsyncIterable<RunPipelineProgress> {
        const self = this;
        return {
            [Symbol.asyncIterator]() {
                return {
                    next() {
                        if (self._progressBuffer.length > 0) {
                            return Promise.resolve({ value: self._progressBuffer.shift()!, done: false });
                        }
                        if (self._done) return Promise.resolve({ value: undefined as never, done: true });
                        return new Promise<IteratorResult<RunPipelineProgress>>((resolve) => {
                            self._progressWaiters.push(resolve);
                        });
                    }
                };
            }
        };
    }

    artifacts(): Promise<PipelineArtifact[]> {
        return this._artifacts;
    }

    cancel(): void {
        this._cancelled = true;
    }

    private _emit(p: RunPipelineProgress) {
        if (this._progressWaiters.length > 0) {
            const w = this._progressWaiters.shift()!;
            w({ value: p, done: false });
        } else {
            this._progressBuffer.push(p);
        }
        if (p.stage === 'done') {
            this._done = true;
            while (this._progressWaiters.length > 0) {
                this._progressWaiters.shift()!({ value: undefined as never, done: true });
            }
        }
    }

    private async _run(req: RunPipelineRequest, sink: ProgressSink): Promise<PipelineArtifact[]> {
        const upstream = await loadUpstream() as any;

        sink({ stage: 'reading', percent: 0, message: req.input.url });
        const tables = await upstream.readFile({
            filename: req.input.url,
            inputFormat: req.input.inputFormat,
            options: {},
            params: [],
            fileSystem: new upstream.UrlReadFileSystem()
        });
        if (this._cancelled) throw new Error('cancelled');
        let table = Array.isArray(tables) ? tables[0] : tables;

        sink({ stage: 'processing', percent: 25, message: `${req.actions.length} actions` });
        if (req.actions.length > 0) {
            table = upstream.processDataTable(table, req.actions);
        }
        if (this._cancelled) throw new Error('cancelled');

        sink({ stage: 'writing', percent: 60, message: `${req.outputs.length} outputs` });
        const fs = new upstream.MemoryFileSystem();
        const artifacts: PipelineArtifact[] = [];
        for (const o of req.outputs) {
            const fname = filenameFor(o);
            await upstream.writeFile(
                {
                    filename: fname,
                    outputFormat: upstreamFormatFor(o.format),
                    dataTable: table,
                    options: { ...o.options, seedPosition: req.seedPosition }
                },
                fs
            );
            const body: Buffer = fs.read(fname);
            artifacts.push({
                format: o.format,
                filename: fname,
                body,
                byteSize: body.byteLength,
                contentType: contentTypeFor(o)
            });
        }

        sink({ stage: 'done', percent: 100 });
        return artifacts;
    }
}

function upstreamFormatFor(o: RunPipelineHandle extends never ? never : import('./runPipeline').OutputFormat): string {
    switch (o) {
        case 'compressed_ply': return 'ply'; // upstream chooses compressed when filename ends in .compressed.ply
        case 'sog': return 'sog';
        case 'voxel_json': return 'voxel';
        case 'preview_webp': return 'webp';
        case 'settings_json': return 'settings';
        case 'glb': return 'glb';
        default: return o as string;
    }
}

export function getDefaultRuntime(): PipelineRuntime {
    return {
        start(req: RunPipelineRequest): RunPipelineHandle {
            return new DefaultHandle(req);
        }
    };
}
