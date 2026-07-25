#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openWardenDb } from '@warden/db';
import { MockClock, MockUpstream } from '@warden/mock-agentcard';
import { RealUpstream, TokenManager, type Rail, type UpstreamClient } from '@warden/upstream';
import { simulateStripePurchase, StripeUpstream, type StripeLike } from '@warden/upstream-stripe';
import Stripe from 'stripe';
import { z } from 'zod';
import { Reconciler } from './reconciler.js';
import { createWardenMcpServer } from './server.js';
import { WardenService, type WardenMode } from './service.js';

/**
 * warden-mcp entrypoint: stdio MCP server for the agent, upstream card rails,
 * reconciler loop in the background. Configuration via env (SPEC §6).
 * Logs go to stderr; stdout belongs to the MCP transport.
 *
 * WARDEN_UPSTREAM=mock swaps the AgentCard rail for the in-process
 * MockUpstream (no credentials, no network) and registers one extra
 * demo-only tool, mock_simulate_purchase, so a demo agent can play the
 * merchant side of a purchase. Never set in production; it does not exist
 * in real mode.
 *
 * The Stripe rail (SPEC §2.8) is wired whenever STRIPE_SECRET_KEY is set,
 * independent of WARDEN_UPSTREAM — Stripe test mode IS the sandbox for that
 * rail, there is no separate in-process mock for it. When wired, a second
 * demo-only tool, stripe_simulate_purchase, drives Stripe's real test-mode
 * authorization API.
 */
async function main(): Promise<void> {
  const mode: WardenMode = process.env['WARDEN_MODE'] === 'live' ? 'live' : 'test';
  const dbPath = process.env['WARDEN_DB_PATH'] ?? './warden.db';
  const useMock = process.env['WARDEN_UPSTREAM'] === 'mock';

  const db = openWardenDb(dbPath);

  let agentcard: UpstreamClient;
  let mock: MockUpstream | undefined;
  if (useMock) {
    mock = new MockUpstream(new MockClock(new Date().toISOString()));
    agentcard = mock;
  } else {
    const credentialsPath =
      process.env['WARDEN_CREDENTIALS_PATH'] ?? join(homedir(), '.warden', 'credentials.json');
    agentcard = new RealUpstream({
      url: process.env['AGENTCARD_MCP_URL'],
      tokenManager: new TokenManager({ credentialsPath }),
    });
  }

  const upstreams: Partial<Record<Rail, UpstreamClient>> & { agentcard: UpstreamClient } = {
    agentcard,
  };
  let stripeClient: StripeLike | undefined;
  const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
  if (stripeSecretKey) {
    if (mode === 'live') {
      throw new Error('rail=stripe is test-mode only in this build; unset WARDEN_MODE=live or STRIPE_SECRET_KEY');
    }
    stripeClient = new Stripe(stripeSecretKey) as unknown as StripeLike;
    upstreams.stripe = new StripeUpstream(stripeClient);
  }

  const reconciler = new Reconciler({ repo: db.repo, upstreams });
  const service = new WardenService({
    repo: db.repo,
    upstreams,
    mode,
    reconcileNow: () => reconciler.runOnce(),
    actorAgentName: process.env['WARDEN_AGENT_NAME'],
    allowLegacyTasks: process.env['WARDEN_ALLOW_LEGACY_TASKS'] === 'true',
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
  if (stripeClient) {
    const stripe = stripeClient;
    server.registerTool(
      'stripe_simulate_purchase',
      {
        description:
          'DEMO ONLY (Stripe test mode): drive a real test-mode authorization against the Stripe Issuing sandbox for a rail=stripe card. Settles within the card limit, declines otherwise.',
        inputSchema: {
          card_id: z.string().min(1),
          merchant: z.string().min(1),
          amount_cents: z.number().int().positive(),
        },
      },
      async (args) => {
        const auth = await simulateStripePurchase(stripe, args.card_id, {
          merchant: args.merchant,
          amount_cents: args.amount_cents,
        });
        await reconciler.runOnce(); // surface the receipt/decline immediately
        return { content: [{ type: 'text', text: JSON.stringify(auth) }] };
      },
    );
  }

  reconciler.start();
  await server.connect(new StdioServerTransport());
  console.error(
    `[warden-mcp] ready (mode=${mode}, agentcard=${useMock ? 'mock' : 'live'}, stripe=${stripeClient ? 'test-mode' : 'not configured'}, db=${dbPath})`,
  );
}

main().catch((err: unknown) => {
  console.error('[warden-mcp] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
