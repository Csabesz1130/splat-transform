// `splat-transform serve` subcommand entry.
//
// Wired from bin/cli.actionnet.mjs. We keep the actual command parsing in the
// upstream CLI dispatcher; this module just exports the handler.

import { createSidecarServer } from './server';

export function serveCommand(argv: string[]): void {
    const args = parseArgs(argv);
    const port = Number(args.port ?? process.env.ACTIONNET_SIDECAR_PORT ?? 7400);
    const host = String(args.host ?? '0.0.0.0');
    createSidecarServer({ port, host });
    // eslint-disable-next-line no-console
    console.log(`[splat-transform serve] listening on http://${host}:${port}`);
}

function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
            else { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
        }
    }
    return out;
}
