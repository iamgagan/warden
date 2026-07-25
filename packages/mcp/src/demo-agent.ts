#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { PolicyRulesSchema } from '@warden/core';
import { openWardenDb } from '@warden/db';

/**
 * Mandate-first demo: an operator creates authority in the shared database,
 * then a real MCP client connects as the delegated agent, discovers that
 * authority, spends inside it, and fails outside it.
 *
 *   node packages/mcp/dist/demo-agent.js [db-path] [--fresh]
 *
 * Run warden-api against the same db to watch evidence land live:
 *   WARDEN_API_TOKEN=demo-token WARDEN_DB_PATH=<db-path> node packages/api/dist/main.js
 */

const dbPath =
  process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.db')) ??
  './warden-demo.db';
if (process.argv.includes('--fresh')) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
}

const AGENT_NAME = 'procurement-agent';
const PURPOSE = 'Restock printer paper for the New York office';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = async (line: string, pauseMs = 700): Promise<void> => {
  console.log(line);
  await sleep(pauseMs);
};
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// The operator side. In normal use this is the dashboard's create-and-activate
// form; the demo writes through the same repository lifecycle.
let mandateId: string;
{
  const db = openWardenDb(dbPath);
  const agent = db.repo.getOrCreateAgent(
    AGENT_NAME,
    'Purchases bounded operational supplies',
  );
  if (!db.repo.getActivePolicy(agent.id)) {
    db.repo.setActivePolicy(
      agent.id,
      JSON.stringify(
        PolicyRulesSchema.parse({
          per_task_budget_cents: 10_000,
          per_card_cap_cents: 5000,
          blocked_merchants: ['sketchy-gift-cards.example'],
        }),
      ),
    );
  }
  const mandate = db.repo.activateMandate(
    db.repo.createMandate({
      agentId: agent.id,
      purpose: PURPOSE,
      merchant: 'Staples',
      amountLimitCents: 4000,
      perTransactionLimitCents: 2500,
      maxTransactions: 3,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      rail: 'auto',
      createdBy: 'Demo operator',
    }).id,
    'Demo operator',
  );
  mandateId = mandate.id;
  db.close();
}

// The agent side. Identity is process-bound and cannot be supplied through a
// tool argument. The older self-declared task path remains disabled.
const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('./main.js', import.meta.url).pathname],
  env: {
    ...getDefaultEnvironment(),
    WARDEN_UPSTREAM: 'mock',
    WARDEN_DB_PATH: dbPath,
    WARDEN_AGENT_NAME: AGENT_NAME,
    RECONCILE_INTERVAL_MS: '2000',
    ...(stripeSecretKey ? { STRIPE_SECRET_KEY: stripeSecretKey } : {}),
  },
  stderr: 'ignore',
});
const client = new Client({ name: 'demo-procurement-agent', version: '0.2.0' });
await client.connect(transport);

type ToolResult = Record<string, unknown>;
class ToolError extends Error {
  constructor(readonly payload: ToolResult) {
    super(String(payload['message'] ?? 'tool error'));
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((content) => content.text ?? '')
    .join('');
  const payload = JSON.parse(text) as ToolResult;
  if (result.isError) throw new ToolError(payload);
  return payload;
}

try {
  await say('');
  await say('① Operator approves a spend mandate');
  await say(`  ${AGENT_NAME} · "${PURPOSE}"`);
  await say('  Staples only · $40 total · $25 per purchase · expires in 24 hours');

  await say('');
  await say('② The bound agent connects to Warden and discovers its authority');
  const tools = await client.listTools();
  const hasLegacy = tools.tools.some((tool) => tool.name === 'warden_start_task');
  await say(
    `  MCP connected · ${tools.tools.length} tools · legacy path ${hasLegacy ? 'present but disabled' : 'hidden'}`,
  );
  const discovery = await call('warden_list_my_mandates');
  const mandates = discovery['mandates'] as Array<Record<string, unknown>>;
  const discovered = mandates.find((mandate) => mandate['mandate_id'] === mandateId);
  if (!discovered) throw new Error('the delegated mandate was not discoverable');
  await say(
    `  found ${mandates.length} active mandate${mandates.length === 1 ? '' : 's'} · ${dollars(discovered['amount_available_cents'] as number)} available`,
  );

  const task = await call('warden_start_mandate_task', { mandate_id: mandateId });
  await say(`  authority loaded · exact payee ${task['merchant']} · task ${task['task_id']}`);

  await say('');
  await say('③ Agent found the approved item at Staples for $18.99');
  const precheck = await call('warden_precheck_purchase', {
    task_id: task['task_id'],
    merchant: 'Staples',
    amount_cents: 1899,
    category: 'office_supplies',
  });
  await say(`  precheck: ${String(precheck['decision']).toUpperCase()}`);
  const card = await call('warden_issue_card', {
    task_id: task['task_id'],
    amount_cents: 1899,
    merchant: 'Staples',
    category: 'office_supplies',
    idempotency_key: 'demo-staples-checkout',
  });
  await say(
    `  ${card['card_id']} minted · ${dollars(card['amount_cents'] as number)} · single-use`,
  );

  await say('  Merchant charges the card…');
  const transaction = await call('mock_simulate_purchase', {
    card_id: card['card_id'],
    merchant: 'STAPLES',
    amount_cents: 1899,
  });
  await say(
    `  ${transaction['status']} · ${dollars(transaction['amount_cents'] as number)} at ${transaction['merchant']}`,
  );
  await say('  ✓ settlement evidence appended and verified against the mandate');

  const stripeWired = tools.tools.some((tool) => tool.name === 'stripe_simulate_purchase');
  if (stripeWired) {
    await say('');
    await say('④ The same authority executes once over Stripe Issuing test mode');
    const stripeCard = await call('warden_issue_card', {
      task_id: task['task_id'],
      amount_cents: 1200,
      merchant: 'Staples',
      rail: 'stripe',
      idempotency_key: 'demo-staples-stripe-checkout',
    });
    await call('stripe_simulate_purchase', {
      card_id: stripeCard['card_id'],
      merchant: 'Staples',
      amount_cents: 1200,
    });
    await say('  ✓ same mandate and evidence model, second payment rail');
  }

  await say('');
  await say('⑤ A prompt-injected page asks for a $19.99 gift card elsewhere');
  try {
    await call('warden_issue_card', {
      task_id: task['task_id'],
      amount_cents: 1999,
      merchant: 'sketchy-gift-cards.example',
      idempotency_key: 'demo-injected-checkout',
    });
    await say('  !! card was issued — this should never print');
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    await say(`  ✗ ${error.payload['code']}: ${error.payload['message']}`);
    await say('  no card was created and no mandate authority was consumed');
  }

  const remaining = await call('warden_list_my_mandates');
  const current = (remaining['mandates'] as Array<Record<string, unknown>>).find(
    (mandate) => mandate['mandate_id'] === mandateId,
  );
  await say('');
  await say(
    `▶ complete · ${dollars((current?.['amount_available_cents'] as number) ?? 0)} authority remains · evidence is visible at http://localhost:8787`,
  );
} finally {
  await client.close();
}
