// runPipeline — ActionNet-friendly facade over splat-transform.
//
// Why this exists:
//   The upstream library exposes readFile / processDataTable / writeFile as
//   independent primitives. ActionNet always wants the same shape of work:
//
//     input  : one URL pointing at a .ply / .splat / .ksplat / .sog / .spz
//     actions: a list of ProcessActions (filterNaN, decimate, scale, ...)
//     outputs: a full bundle ready for the viewer + PyBullet collision
//
//   Wrapping that here lets the Python backend hit a single endpoint and
//   stay out of the format-detection / DataTable plumbing.
//
// This module intentionally does NOT import from the upstream entry by
// relative path — it goes through the package barrel so the build can swap
// in alternative implementations (e.g. CPU-only fallback when WebGPU is
// unavailable on the sidecar host).

import type { Readable } from 'node:stream';

// Re-typed minimal surface of the upstream API. We declare structural types
// here rather than `import type { ... } from '..';` so this file compiles even
// before the upstream tsconfig paths resolve in tests.
export type Vec3Tuple = [number, number, number];

export type ProcessAction =
    | { kind: 'translate'; value: Vec3Tuple }
    | { kind: 'rotate'; value: Vec3Tuple }
    | { kind: 'scale'; value: number }
    | { kind: 'filterNaN' }
    | { kind: 'filterFloaters' }
    | { kind: 'filterCluster' }
    | { kind: 'filterBox'; min: Vec3Tuple; max: Vec3Tuple }
    | { kind: 'filterSphere'; center: Vec3Tuple; radius: number }
    | { kind: 'filterBands'; value: 0 | 1 | 2 | 3 }
    | { kind: 'decimate'; count?: number; percent?: number }
    | { kind: 'mortonOrder' };

export type OutputFormat =
    | 'compressed_ply'
    | 'sog'
    | 'voxel_json'
    | 'preview_webp'
    | 'settings_json'
    | 'glb';

export interface RunPipelineInput {
    /** Absolute URL or `file://` path. The sidecar must be able to fetch it. */
    url: string;
    /** Override format detection (e.g. when the URL has no extension). */
    inputFormat?: 'ply' | 'splat' | 'ksplat' | 'sog' | 'spz' | 'lcc';
}

export interface RunPipelineOutput {
    format: OutputFormat;
    /** Filename inside the bundle. Defaults are chosen per format. */
    filename?: string;
    /** Format-specific options (e.g. webp encoder quality, voxel seed). */
    options?: Record<string, unknown>;
}

export interface RunPipelineRequest {
    input: RunPipelineInput;
    actions: ProcessAction[];
    outputs: RunPipelineOutput[];
    /** Optional seed position for voxelization (camera origin works well). */
    seedPosition?: Vec3Tuple;
}

export interface PipelineArtifact {
    format: OutputFormat;
    filename: string;
    /** Either an in-memory Buffer (small assets) or a stream (large .ply). */
    body: Buffer | Readable;
    byteSize: number;
    contentType: string;
}

export interface RunPipelineProgress {
    stage: 'reading' | 'processing' | 'writing' | 'done';
    percent: number;
    message?: string;
}

export interface RunPipelineHandle {
    /** Async iterator of progress events; ends when the pipeline finishes. */
    progress(): AsyncIterable<RunPipelineProgress>;
    /** Resolves to the final artifacts once writing is complete. */
    artifacts(): Promise<PipelineArtifact[]>;
    /** Cancel an in-flight run; safe to call multiple times. */
    cancel(): void;
}

const DEFAULT_FILENAMES: Record<OutputFormat, string> = {
    compressed_ply: 'scene.compressed.ply',
    sog: 'scene.sog',
    voxel_json: 'scene.voxel.json',
    preview_webp: 'preview.webp',
    settings_json: 'settings.json',
    glb: 'scene.glb'
};

const CONTENT_TYPE: Record<OutputFormat, string> = {
    compressed_ply: 'application/octet-stream',
    sog: 'application/octet-stream',
    voxel_json: 'application/json',
    preview_webp: 'image/webp',
    settings_json: 'application/json',
    glb: 'model/gltf-binary'
};

export function filenameFor(o: RunPipelineOutput): string {
    return o.filename ?? DEFAULT_FILENAMES[o.format];
}

export function contentTypeFor(o: RunPipelineOutput): string {
    return CONTENT_TYPE[o.format];
}

/**
 * Run a full ActionNet pipeline.
 *
 * The implementation is intentionally split into a request shape + a runtime
 * interface so unit tests can stub the runtime without booting WebGPU.
 * The default runtime calls into the upstream `readFile` / `processDataTable`
 * / `writeFile` primitives; see ./runtime.ts for that wiring.
 */
export function runPipeline(
    req: RunPipelineRequest,
    runtime: PipelineRuntime
): RunPipelineHandle {
    return runtime.start(req);
}

export interface PipelineRuntime {
    start(req: RunPipelineRequest): RunPipelineHandle;
}

/**
 * Default runtime built on top of the upstream library primitives.
 *
 * Wiring lives in ./runtime.ts; this re-export lets callers do:
 *
 *   import { runPipeline, getDefaultRuntime } from '@playcanvas/splat-transform/actionnet';
 *
 * without knowing whether they got the GPU or CPU implementation.
 */
export { getDefaultRuntime } from './runtime';
