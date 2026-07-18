#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openWardenDb } from '@warden/db';
import { MockClock, MockUpstream } from '@warden/mock-agentcard';
import { RealUpstream, TokenManager, type UpstreamClient } from '@warden/upstream';
import { z } from 'zod';
import { Reconciler } from './reconciler.js';
import { createWardenMcpServer } from './server.js';
import { WardenService, type WardenMode } from './service.js';

/**
 * warden-mcp entrypoint: stdio MCP server for the agent, agent-cards upstream,
 * reconciler loop in the background. Configuration via env (SPEC §6).
 * Logs go to stderr; stdout belongs to the MCP transport.
 *
 * WARDEN_UPSTREAM=mock swaps in the in-process MockUpstream (no credentials,
 * no network) and registers one extra demo-only tool, mock_simulate_purchase,
 * so a demo agent can play the merchant side of a purchase. Never set in
 * production; it does not exist in real mode.
 */
async function main(): Promise<void> {
  const mode: WardenMode = process.env['WARDEN_MODE'] === 'live' ? 'live' : 'test';
  const dbPath = process.env['WARDEN_DB_PATH'] ?? './warden.db';
  const useMock = process.env['WARDEN_UPSTREAM'] === 'mock';

  const db = openWardenDb(dbPath);
  let upstream: UpstreamClient;
  let mock: MockUpstream | undefined;
  if (useMock) {
    mock = new MockUpstream(new MockClock(new Date().toISOString()));
    upstream = mock;
  } else {
    const credentialsPath =
      process.env['WARDEN_CREDENTIALS_PATH'] ?? join(homedir(), '.warden', 'credentials.json');
    upstream = new RealUpstream({
      url: process.env['AGENTCARD_MCP_URL'],
      tokenManager: new TokenManager({ credentialsPath }),
    });
  }

  const reconciler = new Reconciler({ repo: db.repo, upstream });
  const service = new WardenService({
    repo: db.repo,
    upstream,
    mode,
    reconcileNow: () => reconciler.runOnce(),
  });

  const server = createWardenMcpServer(service);
  if (mock) {
    const simulated = mock;
    server.registerTool(
      'mock_simulate_purchase',
      {
        description:
          'DEMO ONLY (mock upstream): simulate the merchant charging a card at the network. Settles within the card limit, declines otherwise.',
        inputSchema: {
          card_id: z.string().min(1),
          merchant: z.string().min(1),
          amount_cents: z.number().int().positive(),
        },
      },
      async (args) => {
        const txn = simulated.simulatePurchase(args.card_id, {
          merchant: args.merchant,
          amount_cents: args.amount_cents,
        });
        await reconciler.runOnce(); // surface the receipt/decline immediately
        return { content: [{ type: 'text', text: JSON.stringify(txn) }] };
      },
    );
  }

  reconciler.start();
  await server.connect(new StdioServerTransport());
  console.error(
    `[warden-mcp] ready (mode=${mode}, upstream=${useMock ? 'mock' : 'agent-cards'}, db=${dbPath})`,
  );
}

main().catch((err: unknown) => {
  console.error('[warden-mcp] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
