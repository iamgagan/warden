import { beforeEach, describe, expect, it } from 'vitest';
import { openWardenDb, type WardenDb } from '@warden/db';
import { MockUpstream } from '@warden/mock-agentcard';
import { Reconciler, WardenService } from '@warden/mcp';
import { createApiApp } from './app.js';

const TOKEN = 'test-token';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
const futureExpiry = (): string =>
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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
    actorAgentName: 'procurement-agent',
    allowLegacyTasks: true,
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

describe('mandates', () => {
  it('creates, activates, lists, and revokes operator-approved authority', async () => {
    const createdResponse = await app.request('/api/v1/mandates', {
      ...auth,
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_name: 'procurement-agent',
        purpose: 'Buy printer paper for the New York office',
        merchant: 'Staples',
        amount_limit_cents: 4000,
        per_transaction_limit_cents: 2500,
        max_transactions: 3,
        expires_at: futureExpiry(),
        rail: 'agentcard',
        activate_now: false,
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.mandate).toMatchObject({
      status: 'draft',
      agent: 'procurement-agent',
      merchant: 'Staples',
      amount_limit_cents: 4000,
    });

    const activatedResponse = await app.request(
      `/api/v1/mandates/${created.mandate.id}/activate`,
      { ...auth, method: 'POST' },
    );
    expect(activatedResponse.status).toBe(200);
    const activated = await activatedResponse.json();
    expect(activated.mandate).toMatchObject({
      status: 'active',
      amount_available_cents: 4000,
    });
    expect(activated.mandate.task_id).toBeTruthy();

    const listed = await (await app.request('/api/v1/mandates', auth)).json();
    expect(listed.mandates).toHaveLength(1);

    const revokedResponse = await app.request(
      `/api/v1/mandates/${created.mandate.id}/revoke`,
      {
        ...auth,
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'No longer needed' }),
      },
    );
    expect(revokedResponse.status).toBe(200);
    expect((await revokedResponse.json()).mandate.status).toBe('revoked');
  });

  it('logs unexpected authority-write failures without exposing internals', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const draft = db.repo.createMandate({
      agentId: agent.id,
      purpose: 'Buy paper',
      merchant: 'Staples',
      amountLimitCents: 1000,
      perTransactionLimitCents: 1000,
      maxTransactions: 1,
      expiresAt: futureExpiry(),
      rail: 'agentcard',
      createdBy: 'operator',
    });
    const logs: string[] = [];
    const brokenApp = createApiApp({
      repo: {
        ...db.repo,
        activateMandate() {
          throw new Error('disk path /secret/warden.db failed');
        },
        revokeMandate() {
          throw new Error('database lock details');
        },
      } as typeof db.repo,
      apiToken: TOKEN,
      mode: 'test',
      log: (line) => logs.push(line),
    });

    const activate = await brokenApp.request(`/api/v1/mandates/${draft.id}/activate`, {
      ...auth,
      method: 'POST',
    });
    expect(activate.status).toBe(500);
    expect(await activate.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'could not activate mandate' },
    });

    const revoke = await brokenApp.request(`/api/v1/mandates/${draft.id}/revoke`, {
      ...auth,
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'cancelled' }),
    });
    expect(revoke.status).toBe(500);
    expect(await revoke.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'could not revoke mandate' },
    });
    expect(logs.join('\n')).toContain('/secret/warden.db');
    expect(logs.join('\n')).toContain('database lock details');
  });

  it('rejects invalid or already-expired authority', async () => {
    const response = await app.request('/api/v1/mandates', {
      ...auth,
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_name: 'procurement-agent',
        purpose: 'Buy paper',
        merchant: '',
        amount_limit_cents: 0,
        max_transactions: 1,
        expires_at: '2020-01-01T00:00:00.000Z',
      }),
    });
    expect(response.status).toBe(400);
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

  it('exposes mandate-bound integrity evidence for a settled purchase', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const mandate = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'Local operator',
      }).id,
      'Local operator',
    );
    const { card_id } = await service.issueCard({
      task_id: mandate.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      idempotency_key: 'checkout-1',
    });
    upstream.simulatePurchase(card_id, { merchant: 'STAPLES', amount_cents: 1499 });
    await reconciler.runOnce();

    const evidenceResponse = await app.request('/api/v1/evidence', auth);
    expect(evidenceResponse.status).toBe(200);
    const evidence = await evidenceResponse.json();
    expect(evidence.evidence).toHaveLength(1);
    expect(evidence.evidence[0]).toMatchObject({
      mandate_id: mandate.id,
      outcome: 'settled',
      decision: 'matched',
      merchant: 'STAPLES',
      integrity: {
        kind: 'sha256_chain_v1',
        sequence: 1,
        previous_hash: null,
        verified: true,
      },
    });
    expect(evidence.chain_verification).toEqual({
      verified: true,
      checked_records: 1,
      first_invalid_sequence: null,
    });

    const receipts = await (await app.request('/api/v1/receipts', auth)).json();
    const detail = await (
      await app.request(`/api/v1/receipts/${receipts.receipts[0].id}`, auth)
    ).json();
    expect(detail).toMatchObject({
      mandate_id: mandate.id,
      evidence_hash: evidence.evidence[0].integrity.evidence_hash,
    });

    db.sqlite.prepare("UPDATE transactions SET merchant = 'Tampered merchant'").run();
    db.sqlite.prepare("UPDATE mandates SET purpose = 'Tampered purpose'").run();
    const joinedTamper = await (await app.request('/api/v1/evidence', auth)).json();
    expect(joinedTamper.chain_verification.verified).toBe(true);
    expect(joinedTamper.evidence[0]).toMatchObject({
      merchant: 'STAPLES',
      purpose: 'Buy paper',
      integrity: { verified: true },
    });

    // Simulate a privileged/out-of-band attacker bypassing Warden's
    // append-only trigger, then prove the hash verifier still fails closed.
    db.sqlite.exec('DROP TRIGGER evidence_no_update');
    db.sqlite.prepare("UPDATE evidence SET payload_json = '{\"tampered\":true}'").run();
    const tampered = await (await app.request('/api/v1/evidence', auth)).json();
    expect(tampered.chain_verification).toMatchObject({
      verified: false,
      first_invalid_sequence: 1,
    });
    expect(tampered.evidence[0].integrity.verified).toBe(false);
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
      active_mandates: 0,
      authority_available_cents: 0,
      evidence_total: 0,
    });
  });
});

describe('policies (T11)', () => {
  it('GET returns null/empty before any policy is set', async () => {
    const body = await (await app.request('/api/v1/policies', auth)).json();
    expect(body).toEqual({ agent_name: null, active: null, versions: [] });
  });

  it('PUT creates version 1 as the global default when agent_name is null', async () => {
    const res = await app.request('/api/v1/policies', {
      ...auth,
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_name: null, rules: { per_task_budget_cents: 5000 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent_name).toBeNull();
    expect(body.active).toMatchObject({ version: 1, active: true });
    expect(body.active.rules.per_task_budget_cents).toBe(5000);

    const get = await (await app.request('/api/v1/policies', auth)).json();
    expect(get.active).toMatchObject({ version: 1 });
    expect(get.versions).toHaveLength(1);
  });

  it('PUT for a new agent name creates the agent and scopes the policy to it', async () => {
    await app.request('/api/v1/policies', {
      ...auth,
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_name: 'shopping-agent',
        rules: { allowed_merchants: ['Staples'], per_task_budget_cents: 4000 },
      }),
    });
    expect(db.repo.getAgentByName('shopping-agent')).toBeDefined();

    const scoped = await (await app.request('/api/v1/policies?agent=shopping-agent', auth)).json();
    expect(scoped.active.rules.allowed_merchants).toEqual(['Staples']);

    // The global default (agent_name: null) is untouched by an agent-scoped PUT.
    const global = await (await app.request('/api/v1/policies', auth)).json();
    expect(global.active).toBeNull();
  });

  it('a second PUT for the same agent creates version 2 and deactivates version 1', async () => {
    const put = (rules: object) =>
      app.request('/api/v1/policies', {
        ...auth,
        method: 'PUT',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_name: 'shopper', rules }),
      });
    await put({ per_task_budget_cents: 1000 });
    await put({ per_task_budget_cents: 2000 });

    const body = await (await app.request('/api/v1/policies?agent=shopper', auth)).json();
    expect(body.active).toMatchObject({ version: 2, active: true });
    expect(body.versions).toHaveLength(2);
    expect(body.versions.find((v: { version: number }) => v.version === 1)).toMatchObject({
      active: false,
    });
  });

  it('GET 404s for an unknown agent name', async () => {
    expect((await app.request('/api/v1/policies?agent=nobody', auth)).status).toBe(404);
  });

  it('PUT 400s on invalid rules', async () => {
    const res = await app.request('/api/v1/policies', {
      ...auth,
      method: 'PUT',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_name: null, rules: { per_task_budget_cents: -5 } }),
    });
    expect(res.status).toBe(400);
  });
});
