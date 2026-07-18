#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openWardenDb } from '@warden/db';
import { RealUpstream, TokenManager } from '@warden/upstream';
import { Reconciler } from './reconciler.js';
import { createWardenMcpServer } from './server.js';
import { WardenService, type WardenMode } from './service.js';

/**
 * warden-mcp entrypoint: stdio MCP server for the agent, RealUpstream to
 * agent-cards, reconciler loop in the background. Configuration via env
 * (SPEC §6). Logs go to stderr; stdout belongs to the MCP transport.
 */
async function main(): Promise<void> {
  const mode: WardenMode = process.env['WARDEN_MODE'] === 'live' ? 'live' : 'test';
  const dbPath = process.env['WARDEN_DB_PATH'] ?? './warden.db';
  const credentialsPath =
    process.env['WARDEN_CREDENTIALS_PATH'] ?? join(homedir(), '.warden', 'credentials.json');

  const db = openWardenDb(dbPath);
  const upstream = new RealUpstream({
    url: process.env['AGENTCARD_MCP_URL'],
    tokenManager: new TokenManager({ credentialsPath }),
  });
  const reconciler = new Reconciler({ repo: db.repo, upstream });
  const service = new WardenService({
    repo: db.repo,
    upstream,
    mode,
    reconcileNow: () => reconciler.runOnce(),
  });

  const server = createWardenMcpServer(service);
  reconciler.start();
  await server.connect(new StdioServerTransport());
  console.error(`[warden-mcp] ready (mode=${mode}, db=${dbPath})`);
}

main().catch((err: unknown) => {
  console.error('[warden-mcp] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
