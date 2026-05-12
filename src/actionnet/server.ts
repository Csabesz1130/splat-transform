// HTTP+SSE server fronting runPipeline().
//
// POST /jobs               { input, actions, outputs, seedPosition,
//                            upload: { signedUrls: { [filename]: url } } }
//                          -> { jobId }
// GET  /jobs/:id/events    Server-Sent Events of RunPipelineProgress;
//                          ends with `event: done\ndata: {...}` once the
//                          worker has uploaded all artifacts.
// GET  /healthz            200 OK for docker-compose readiness probes.
//
// When `upload.signedUrls` is provided, the server PUTs each artifact to its
// corresponding signed URL (Supabase storage) and emits the resulting paths
// in the final event. When omitted, artifacts are kept in memory and the
// caller can download them via GET /jobs/:id/artifacts/:filename.
//
// Auth: the server expects an `X-Sidecar-Token` header matching the env var
// `ACTIONNET_SIDECAR_TOKEN`. Anything else 401s. The actionnet-ai backend
// injects this header from its own secrets store.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { getDefaultRuntime, type PipelineArtifact, type RunPipelineProgress, type RunPipelineRequest } from './runPipeline';

interface UploadSpec {
    signedUrls?: Record<string, string>;
}

interface JobSpec extends RunPipelineRequest {
    upload?: UploadSpec;
}

interface JobRecord {
    id: string;
    state: 'running' | 'done' | 'failed';
    progress: RunPipelineProgress[];
    artifacts?: PipelineArtifact[];
    uploadedPaths?: Record<string, string>;
    error?: string;
    subscribers: Set<ServerResponse>;
}

const jobs = new Map<string, JobRecord>();

function authOk(req: IncomingMessage): boolean {
    const expected = process.env.ACTIONNET_SIDECAR_TOKEN;
    if (!expected) return true; // dev convenience
    const got = req.headers['x-sidecar-token'];
    return typeof got === 'string' && got === expected;
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sse(res: ServerResponse) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
}

function broadcast(job: JobRecord, event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of job.subscribers) r.write(payload);
}

async function uploadArtifact(url: string, art: PipelineArtifact): Promise<void> {
    const body = art.body instanceof Buffer ? art.body : Buffer.from(await readableToBuffer(art.body));
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': art.contentType },
        body
    });
    if (!res.ok) {
        throw new Error(`upload ${art.filename} -> ${res.status}`);
    }
}

async function readableToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function runJob(spec: JobSpec, rec: JobRecord) {
    const handle = getDefaultRuntime().start(spec);
    (async () => {
        for await (const p of handle.progress()) {
            rec.progress.push(p);
            broadcast(rec, 'progress', p);
        }
    })().catch(() => { /* errors surface via .artifacts() */ });
    try {
        const artifacts = await handle.artifacts();
        rec.artifacts = artifacts;
        if (spec.upload?.signedUrls) {
            const uploaded: Record<string, string> = {};
            for (const art of artifacts) {
                const url = spec.upload.signedUrls[art.filename];
                if (!url) continue;
                await uploadArtifact(url, art);
                uploaded[art.filename] = url;
            }
            rec.uploadedPaths = uploaded;
        }
        rec.state = 'done';
        broadcast(rec, 'done', { uploadedPaths: rec.uploadedPaths ?? {} });
    } catch (e) {
        rec.state = 'failed';
        rec.error = String((e as Error).message || e);
        broadcast(rec, 'failed', { error: rec.error });
    } finally {
        for (const r of rec.subscribers) r.end();
        rec.subscribers.clear();
    }
}

export interface ServeOptions {
    port?: number;
    host?: string;
}

export function createSidecarServer(opts: ServeOptions = {}) {
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        if (req.method === 'GET' && url.pathname === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (!authOk(req)) {
            res.writeHead(401);
            res.end('unauthorized');
            return;
        }
        if (req.method === 'POST' && url.pathname === '/jobs') {
            try {
                const spec = JSON.parse(await readBody(req)) as JobSpec;
                const id = randomUUID();
                const rec: JobRecord = { id, state: 'running', progress: [], subscribers: new Set() };
                jobs.set(id, rec);
                runJob(spec, rec);
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jobId: id }));
            } catch (e) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: String((e as Error).message || e) }));
            }
            return;
        }
        const eventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
        if (req.method === 'GET' && eventsMatch) {
            const rec = jobs.get(eventsMatch[1]);
            if (!rec) { res.writeHead(404); res.end(); return; }
            sse(res);
            for (const p of rec.progress) res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
            if (rec.state === 'done') { res.write(`event: done\ndata: ${JSON.stringify({ uploadedPaths: rec.uploadedPaths ?? {} })}\n\n`); res.end(); return; }
            if (rec.state === 'failed') { res.write(`event: failed\ndata: ${JSON.stringify({ error: rec.error })}\n\n`); res.end(); return; }
            rec.subscribers.add(res);
            req.on('close', () => rec.subscribers.delete(res));
            return;
        }
        const artifactMatch = url.pathname.match(/^\/jobs\/([^/]+)\/artifacts\/(.+)$/);
        if (req.method === 'GET' && artifactMatch) {
            const rec = jobs.get(artifactMatch[1]);
            const fname = decodeURIComponent(artifactMatch[2]);
            const art = rec?.artifacts?.find(a => a.filename === fname);
            if (!art) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': art.contentType });
            if (art.body instanceof Buffer) res.end(art.body); else (art.body as Readable).pipe(res);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.listen(opts.port ?? 7400, opts.host ?? '0.0.0.0');
    return server;
}
