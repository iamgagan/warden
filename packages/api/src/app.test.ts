import { beforeEach, describe, expect, it } from 'vitest';
import { openWardenDb, type WardenDb } from '@warden/db';
import { MockUpstream } from '@warden/mock-agentcard';
import { Reconciler, WardenService } from '@warden/mcp';
import { createApiApp } from './app.js';

const TOKEN = 'test-token';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

let db: WardenDb;
let upstream: MockUpstream;
let service: WardenService;
let reconciler: Reconciler;
let app: ReturnType<typeof createApiApp>;

beforeEach(() => {
  db = openWardenDb(':memory:');
  upstream = new MockUpstream();
  reconciler = new Reconciler({ repo: db.repo, upstreams: { agentcard: upstream }, log: () => undefined });
  service = new WardenService({
    repo: db.repo,
    upstreams: { agentcard: upstream },
    mode: 'test',
    reconcileNow: () => reconciler.runOnce(),
  });
  app = createApiApp({
    repo: db.repo,
    apiToken: TOKEN,
    mode: 'test',
    reconcilerStatus: reconciler.status,
  });
});

async function seedReceipts(count: number): Promise<string> {
  const { task_id } = service.startTask({
    agent_name: 'shopper',
    intent: 'restock office supplies',
    budget_cents: 10_000,
  });
  for (let i = 0; i < count; i++) {
    const { card_id } = await service.issueCard({ task_id, amount_cents: 500, merchant: 'staples' });
    upstream.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 450 });
  }
  await reconciler.runOnce();
  return task_id;
}

describe('auth', () => {
  it('healthz is open; api routes need the bearer token', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/api/v1/receipts')).status).toBe(401);
    const wrong = await app.request('/api/v1/receipts', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect((await app.request('/api/v1/receipts', auth)).status).toBe(200);
  });

  it('healthz reflects mode and reconciler auth state', async () => {
    const body = await (await app.request('/healthz')).json();
    expect(body).toEqual({ ok: true, mode: 'test', upstream_auth: 'ok' });
    reconciler.status.upstream_auth = 'needs_login';
    const after = await (await app.request('/healthz')).json();
    expect(after.upstream_auth).toBe('needs_login');
  });
});

describe('receipts', () => {
  it('lists receipts newest-first with intent and merchant detail', async () => {
    await seedReceipts(2);
    const body = await (await app.request('/api/v1/receipts', auth)).json();
    expect(body.receipts).toHaveLength(2);
    expect(body.receipts[0]).toMatchObject({
      intent: 'restock office supplies',
      merchant: 'staples',
      amount_cents: 450,
      agent: 'shopper',
      transaction_status: 'SETTLED',
    });
    expect(body.next_cursor).toBeNull();
  });

  it('paginates via cursor', async () => {
    await seedReceipts(3);
    const page1 = await (await app.request('/api/v1/receipts?limit=2', auth)).json();
    expect(page1.receipts).toHaveLength(2);
    expect(page1.next_cursor).toBe(page1.receipts[1].id);
    const page2 = await (
      await app.request(`/api/v1/receipts?limit=2&cursor=${page1.next_cursor}`, auth)
    ).json();
    expect(page2.receipts).toHaveLength(1);
    const ids = [...page1.receipts, ...page2.receipts].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('filters by agent and task, 404s unknown agents', async () => {
    const taskId = await seedReceipts(1);
    const byAgent = await (await app.request('/api/v1/receipts?agent=shopper', auth)).json();
    expect(byAgent.receipts).toHaveLength(1);
    const byTask = await (await app.request(`/api/v1/receipts?task=${taskId}`, auth)).json();
    expect(byTask.receipts).toHaveLength(1);
    expect((await app.request('/api/v1/receipts?agent=nobody', auth)).status).toBe(404);
  });

  it('serves receipt detail with the parsed decision', async () => {
    await seedReceipts(1);
    const list = await (await app.request('/api/v1/receipts', auth)).json();
    const detail = await (
      await app.request(`/api/v1/receipts/${list.receipts[0].id}`, auth)
    ).json();
    expect(detail.intent).toBe('restock office supplies');
    expect(detail.decision).toMatchObject({ decision: 'issue', card_amount_cents: 500, sandbox: true });
    expect((await app.request('/api/v1/receipts/nope', auth)).status).toBe(404);
  });
});

describe('agents, events, stats', () => {
  it('rolls up agents', async () => {
    await seedReceipts(2);
    const body = await (await app.request('/api/v1/agents', auth)).json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      name: 'shopper',
      total_spent_cents: 900,
      receipts: 2,
      blocks: 0,
    });
  });

  it('lists events with parsed details and filters by type', async () => {
    await seedReceipts(1);
    const all = await (await app.request('/api/v1/events', auth)).json();
    expect(all.events.length).toBeGreaterThan(0);
    const issued = await (await app.request('/api/v1/events?type=card_issued', auth)).json();
    expect(issued.events).toHaveLength(1);
    expect(issued.events[0].details).toMatchObject({ amount_cents: 500 });
    expect((await app.request('/api/v1/events?type=bogus', auth)).status).toBe(400);
  });

  it('reports stats including blast radius of open cards', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    await service.issueCard({ task_id, amount_cents: 1000 });
    await service.issueCard({ task_id, amount_cents: 500 });
    const body = await (await app.request('/api/v1/stats', auth)).json();
    expect(body).toEqual({
      spend_under_management_cents: 1500, // reservations
      receipts_total: 0,
      blocks_total: 0,
      avg_blast_radius_cents: 1500, // one task with $15.00 open exposure
    });
  });
});
