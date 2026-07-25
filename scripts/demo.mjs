#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const dbPath = resolve(process.argv[2] ?? '/private/tmp/warden-vc-demo.db');
const seed = spawnSync(process.execPath, ['scripts/seed-demo.mjs', dbPath], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'inherit'],
});

if (seed.status !== 0) {
  process.exit(seed.status ?? 1);
}

process.env.WARDEN_API_TOKEN = process.env.WARDEN_API_TOKEN ?? 'demo-token';
process.env.WARDEN_OPERATOR_NAME = process.env.WARDEN_OPERATOR_NAME ?? 'Gagan Singh';
process.env.WARDEN_DB_PATH = dbPath;
process.env.WARDEN_MODE = 'test';

const port = process.env.PORT ?? '8787';
console.error('');
console.error('Warden VC demo is ready.');
console.error(`Open http://localhost:${port}/#token=${encodeURIComponent(process.env.WARDEN_API_TOKEN)}`);
console.error('The dataset is reset each time this command starts.');
console.error('');

await import('../packages/api/dist/main.js');
