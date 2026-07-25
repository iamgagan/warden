#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { openWardenDb } from '@warden/db';
import { createApiApp } from './app.js';

/**
 * warden-api entrypoint. Reads the same SQLite file warden-mcp writes; the
 * dashboard build (apps/web/dist) is served statically when present.
 */
function main(): void {
  const apiToken = process.env['WARDEN_API_TOKEN'];
  if (!apiToken) {
    console.error('WARDEN_API_TOKEN is required (bearer token for the API and dashboard)');
    process.exit(1);
  }
  const mode = process.env['WARDEN_MODE'] === 'live' ? 'live' : 'test';
  const dbPath = process.env['WARDEN_DB_PATH'] ?? './warden.db';
  const port = Number(process.env['PORT'] ?? 8787);

  const db = openWardenDb(dbPath);
  const app = createApiApp({
    repo: db.repo,
    apiToken,
    mode,
    operatorName: process.env['WARDEN_OPERATOR_NAME'],
  });

  const webDist = process.env['WARDEN_WEB_DIST'] ?? join(process.cwd(), 'apps', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use('/*', serveStatic({ root: webDist }));
    app.get('*', serveStatic({ path: join(webDist, 'index.html') }));
    console.error(`[warden-api] serving dashboard from ${webDist}`);
  }

  serve({ fetch: app.fetch, port });
  console.error(`[warden-api] listening on http://localhost:${port} (mode=${mode}, db=${dbPath})`);
}

main();
