import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWardenDb, type WardenDb } from '@warden/db';
import { MockUpstream } from '@warden/mock-agentcard';
import { UpstreamError, type UpstreamClient } from '@warden/upstream';
import { Reconciler } from './reconciler.js';
import { WardenService } from './service.js';

let db: WardenDb;
let upstream: MockUpstream;
let service: WardenService;
let reconciler: Reconciler;

beforeEach(() => {
  db = openWardenDb(':memory:');
  upstream = new MockUpstream();
  reconciler = new Reconciler({ repo: db.repo, upstream, log: () => undefined });
  service = new WardenService({
    repo: db.repo,
    upstream,
    mode: 'test',
    reconcileNow: () => reconciler.runOnce(),
  });
});

describe('Reconciler (T8 done-check)', () => {
  it('binds a mock purchase to the intent as a receipt', async () => {
    const { task_id } = service.startTask({
      agent_name: 'shopper',
      intent: 'restock office supplies under $40',
    });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1500, merchant: 'staples' });
    upstream.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1499 });

    await reconciler.runOnce();

    const receipts = db.repo.listReceipts({ limit: 10 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      intent: 'restock office supplies under $40',
      merchant: 'staples',
      amountCents: 1499,
      cardId: card_id,
      agentName: 'shopper',
    });
    const decision = JSON.parse(receipts[0]!.decisionJson);
    expect(decision).toMatchObject({ card_amount_cents: 1500, sandbox: true });

    // settlement trues the reservation up to the settled amount
    expect(db.repo.getTask(task_id)?.spentCents).toBe(1499);
    expect(db.repo.getCard(card_id)?.state).toBe('used');
  });

  it('is idempotent across repeated passes', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1000 });
    upstream.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1000 });

    await reconciler.runOnce();
    await reconciler.runOnce();
    await reconciler.runOnce();

    expect(db.repo.listReceipts({ limit: 10 })).toHaveLength(1);
    expect(db.repo.getTask(task_id)?.spentCents).toBe(1000);
  });

  it('turns network declines into enforced_at:network block events, not receipts', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1000 });
    upstream.simulatePurchase(card_id, { merchant: 'apple', amount_cents: 99_00 }); // over card limit

    await reconciler.runOnce();

    expect(db.repo.listReceipts({ limit: 10 })).toHaveLength(0);
    const blocks = db.repo.listPolicyEvents({ type: 'block', limit: 10 });
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0]!.detailsJson)).toMatchObject({
      enforced_at: 'network',
      card_id,
      merchant: 'apple',
    });
    expect(db.repo.getCard(card_id)?.state).toBe('open'); // decline does not consume the card
  });

  it('complete_task runs an immediate pass so totals include fresh receipts', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1500 });
    upstream.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1200 });

    const result = await service.completeTask({ task_id });
    expect(result.receipts_count).toBe(1);
    expect(result.total_spent_cents).toBe(1200);
    expect(result.cards_issued).toBe(1);
  });

  it('marks upstream_auth needs_login on auth failure and recovers on success', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    await service.issueCard({ task_id, amount_cents: 1000 });

    const failing: UpstreamClient = {
      ...upstream,
      listTransactions: vi
        .fn()
        .mockRejectedValue(new UpstreamError('refresh token dead', 'UPSTREAM_AUTH_REQUIRED')),
    } as unknown as UpstreamClient;
    const failingReconciler = new Reconciler({ repo: db.repo, upstream: failing, log: () => undefined });
    await failingReconciler.runOnce();
    expect(failingReconciler.status.upstream_auth).toBe('needs_login');
    expect(failingReconciler.status.last_error).toMatch(/refresh token dead/);

    await reconciler.runOnce();
    expect(reconciler.status.upstream_auth).toBe('ok');
    expect(reconciler.status.last_error).toBeNull();
  });

  it('survives per-card upstream errors and continues the pass', async () => {
    const t1 = service.startTask({ agent_name: 'shopper', intent: 'a' });
    const c1 = await service.issueCard({ task_id: t1.task_id, amount_cents: 1000 });
    const t2 = service.startTask({ agent_name: 'shopper', intent: 'b' });
    const c2 = await service.issueCard({ task_id: t2.task_id, amount_cents: 1000 });
    upstream.simulatePurchase(c2.card_id, { merchant: 'staples', amount_cents: 900 });

    const original = upstream.listTransactions.bind(upstream);
    const flaky: UpstreamClient = {
      ...upstream,
      listTransactions: vi.fn().mockImplementation(async (cardId: string) => {
        if (cardId === c1.card_id) throw new UpstreamError('boom');
        return original(cardId);
      }),
    } as unknown as UpstreamClient;
    const flakyReconciler = new Reconciler({ repo: db.repo, upstream: flaky, log: () => undefined });

    await flakyReconciler.runOnce();
    // the healthy card still produced its receipt despite the flaky one
    expect(db.repo.listReceipts({ limit: 10 })).toHaveLength(1);
    expect(flakyReconciler.status.last_error).toMatch(/boom/);
  });
});
