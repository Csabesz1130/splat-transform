#!/usr/bin/env node
// Thin shim that adds the `serve` subcommand to splat-transform without
// touching the upstream bin/cli.mjs. Usage:
//
//   splat-transform-actionnet serve --port 7400 --host 0.0.0.0
//
// In production we invoke this via npm scripts:
//
//   "actionnet:serve": "node bin/cli.actionnet.mjs serve"
//
// Once upstream lands proper plugin/subcommand support we can fold this back
// into the main CLI.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [, , cmd, ...rest] = process.argv;

if (cmd === 'serve') {
    const { serveCommand } = await import(resolve(__dirname, '..', 'dist', 'actionnet', 'cli.js')).catch(async () => {
        // Dev fallback: ts-node / tsx will resolve the source path.
        return await import(resolve(__dirname, '..', 'src', 'actionnet', 'cli.ts'));
    });
    serveCommand(rest);
} else {
    console.error('Unknown subcommand:', cmd);
    console.error('Available: serve');
    process.exit(2);
}
