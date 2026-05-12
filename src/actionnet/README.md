# ActionNet sidecar surface

Additive namespace under `src/actionnet/`. None of the upstream files are
modified, so merges with playcanvas/splat-transform stay trivial.

## What it adds

- **`runPipeline.ts`** — high-level facade: `{ input, actions, outputs }` in,
  scene bundle out. Returns a handle with `progress()` (async iterator) and
  `artifacts()` (promise).
- **`runtime.ts`** — default runtime that bridges to the upstream `readFile` /
  `processDataTable` / `writeFile` primitives via `MemoryFileSystem`.
- **`server.ts`** — Node HTTP+SSE sidecar (POST `/jobs`, GET `/jobs/:id/events`,
  GET `/jobs/:id/artifacts/:filename`, GET `/healthz`). Uploads finished
  artifacts to Supabase via signed URLs passed in the job spec.
- **`cli.ts`** — implements `splat-transform serve` (mounted from
  `bin/cli.actionnet.mjs`).
- **`Dockerfile.actionnet`** — image used by actionnet-ai's docker-compose.

## Job spec

```jsonc
{
  "input":  { "url": "https://…/scene.ply" },
  "actions": [
    { "kind": "filterNaN" },
    { "kind": "filterFloaters" },
    { "kind": "decimate", "percent": 80 }
  ],
  "outputs": [
    { "format": "compressed_ply" },
    { "format": "sog" },
    { "format": "voxel_json", "options": { "voxelSize": 0.05 } },
    { "format": "preview_webp" }
  ],
  "seedPosition": [0, 1.5, 2],
  "upload": {
    "signedUrls": {
      "scene.compressed.ply": "https://…supabase…?token=…",
      "scene.sog":             "https://…",
      "scene.voxel.json":      "https://…",
      "preview.webp":          "https://…"
    }
  }
}
```

The actionnet-ai backend (`api/services/splat_service.py`, Phase 2b) mints
signed PUT URLs for the `scenes` bucket and forwards them; the sidecar
uploads each artifact to its matching URL once the pipeline finishes.

## Auth

Set `ACTIONNET_SIDECAR_TOKEN` in the sidecar's environment and forward the
same value as the `X-Sidecar-Token` header on every request from the
actionnet-ai backend. Unset means dev mode (all requests accepted).
