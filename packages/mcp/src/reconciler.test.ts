import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PolicyRulesSchema } from '@warden/core';
import { openWardenDb, type WardenDb } from '@warden/db';
import { MockUpstream } from '@warden/mock-agentcard';
import { UpstreamError, type UpstreamClient, type UpstreamTxn } from '@warden/upstream';
import { Reconciler } from './reconciler.js';
import { WardenService } from './service.js';

let db: WardenDb;
let upstream: MockUpstream;
let service: WardenService;
let reconciler: Reconciler;
const futureExpiry = (): string =>
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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

  it('settles mandate accounting and appends hash-linked integrity evidence', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const mandate = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy printer paper',
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

    expect(db.repo.getMandate(mandate.id)).toMatchObject({
      status: 'exhausted',
      reservedCents: 0,
      settledCents: 1499,
      transactionCount: 1,
    });
    const evidence = db.repo.listEvidence({ mandateId: mandate.id, limit: 10 });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      outcome: 'settled',
      sequence: 1,
      previousHash: null,
      merchant: 'STAPLES',
      amountCents: 1499,
      purpose: 'Buy printer paper',
    });
    expect(evidence[0]!.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(evidence[0]!.payloadJson)).toMatchObject({
      decision: 'matched',
      mandate: {
        id: mandate.id,
        merchant: 'Staples',
        agent_name: 'procurement-agent',
      },
      transaction: { merchant: 'STAPLES', amount_cents: 1499 },
    });
  });

  it('cumulatively accounts multiple captures against one authorization', async () => {
    const multiCaptureUpstream: UpstreamClient = {
      createCard: async () => ({ card_id: 'card_multi_capture' }),
      closeCard: async () => undefined,
      getCardDetails: async (id) => ({
        card_id: id,
        pan: '4000000000000002',
        cvv: '123',
        expiry_month: 12,
        expiry_year: 2030,
      }),
      listCards: async () => [],
      checkBalance: async () => ({ balance_cents: 0 }),
      listTransactions: async (id) => [
        {
          id: 'txn_capture_1',
          card_id: id,
          merchant: 'Staples',
          amount_cents: 700,
          currency: 'USD',
          category: 'office_supplies',
          status: 'SETTLED',
          occurred_at: '2026-07-25T14:30:00.000Z',
          raw: {},
        },
        {
          id: 'txn_capture_2',
          card_id: id,
          merchant: 'Staples',
          amount_cents: 800,
          currency: 'USD',
          category: 'office_supplies',
          status: 'SETTLED',
          occurred_at: '2026-07-25T14:31:00.000Z',
          raw: {},
        },
      ],
    };
    const multiCaptureReconciler = new Reconciler({
      repo: db.repo,
      upstreams: { agentcard: multiCaptureUpstream },
      log: () => undefined,
    });
    const multiCaptureService = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: multiCaptureUpstream },
      mode: 'test',
      actorAgentName: 'procurement-agent',
    });
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const mandate = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 1500,
        maxTransactions: 2,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'Local operator',
      }).id,
      'Local operator',
    );
    const card = await multiCaptureService.issueCard({
      task_id: mandate.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      idempotency_key: 'multi-capture',
    });

    await multiCaptureReconciler.runOnce();
    await multiCaptureReconciler.runOnce();

    expect(db.repo.getTask(mandate.taskId!)?.spentCents).toBe(1500);
    expect(db.repo.getMandate(mandate.id)).toMatchObject({
      reservedCents: 0,
      settledCents: 1500,
      status: 'active',
    });
    expect(db.repo.getAuthorizationByCard(card.card_id)).toMatchObject({
      status: 'settled',
      settledCents: 1500,
    });
    expect(db.repo.listEvidence({ mandateId: mandate.id, limit: 10 })).toHaveLength(2);
  });

  it('appends a new evidence event when a pending transaction settles', async () => {
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
    let transactionStatus: UpstreamTxn['status'] = 'PENDING';
    let cardId = '';
    const lifecycleUpstream: UpstreamClient = {
      async createCard(request) {
        const created = await upstream.createCard(request);
        cardId = created.card_id;
        return created;
      },
      closeCard: (id) => upstream.closeCard(id),
      getCardDetails: (id) => upstream.getCardDetails(id),
      listCards: () => upstream.listCards(),
      checkBalance: (id) => upstream.checkBalance(id),
      async listTransactions(id) {
        if (!cardId || id !== cardId) return [];
        return [
          {
            id: 'txn_lifecycle',
            card_id: cardId,
            merchant: 'STAPLES',
            amount_cents: 1499,
            currency: 'USD',
            category: 'office_supplies',
            status: transactionStatus,
            occurred_at: '2026-07-25T14:30:00.000Z',
            raw: { lifecycle: true },
          },
        ];
      },
    };
    const lifecycleReconciler = new Reconciler({
      repo: db.repo,
      upstreams: { agentcard: lifecycleUpstream },
      log: () => undefined,
    });
    const lifecycleService = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: lifecycleUpstream },
      mode: 'test',
      actorAgentName: 'procurement-agent',
    });
    await lifecycleService.issueCard({
      task_id: mandate.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      idempotency_key: 'checkout-lifecycle',
    });

    await lifecycleReconciler.runOnce();
    expect(db.repo.listEvidence({ mandateId: mandate.id, limit: 10 }).map((row) => row.outcome)).toEqual([
      'pending',
    ]);

    transactionStatus = 'SETTLED';
    await lifecycleReconciler.runOnce();
    expect(db.repo.listEvidence({ mandateId: mandate.id, limit: 10 }).map((row) => row.outcome)).toEqual([
      'settled',
      'pending',
    ]);
    expect(db.repo.getMandate(mandate.id)).toMatchObject({
      reservedCents: 0,
      settledCents: 1499,
    });
  });

  it('keeps a Stripe authorization pollable through pending to captured settlement', async () => {
    let phase: 'PENDING' | 'SETTLED' = 'PENDING';
    const stripeLifecycle: UpstreamClient = {
      createCard: async () => ({ card_id: 'ic_pending_capture' }),
      closeCard: async () => undefined,
      getCardDetails: async (id) => ({
        card_id: id,
        pan: '4000000000000002',
        cvv: '123',
        expiry_month: 12,
        expiry_year: 2030,
      }),
      listCards: async () => [],
      checkBalance: async () => ({ balance_cents: 0 }),
      listTransactions: async (id) => [
        {
          id: 'iauth_pending_capture',
          card_id: id,
          merchant: 'Staples',
          amount_cents: 1499,
          currency: 'USD',
          category: 'office_supplies',
          status: phase,
          occurred_at: '2026-07-25T14:30:00.000Z',
          raw: { native_id: phase === 'PENDING' ? 'iauth_native' : 'ipi_native' },
        },
      ],
    };
    const stripeReconciler = new Reconciler({
      repo: db.repo,
      upstreams: { stripe: stripeLifecycle },
      log: () => undefined,
    });
    const stripeService = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: upstream, stripe: stripeLifecycle },
      mode: 'test',
      actorAgentName: 'procurement-agent',
    });
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
        rail: 'stripe',
        createdBy: 'Local operator',
      }).id,
      'Local operator',
    );
    const card = await stripeService.issueCard({
      task_id: mandate.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      rail: 'stripe',
      idempotency_key: 'stripe-pending-capture',
    });

    await stripeReconciler.runOnce();
    expect(db.repo.getCard(card.card_id)?.state).toBe('used');
    expect(db.repo.getMandate(mandate.id)).toMatchObject({
      reservedCents: 1500,
      settledCents: 0,
    });

    phase = 'SETTLED';
    await stripeReconciler.runOnce();
    expect(db.repo.getCard(card.card_id)?.state).toBe('closed');
    expect(db.repo.listReceipts({ taskId: mandate.taskId!, limit: 10 })).toHaveLength(1);
    expect(
      db.repo.listEvidence({ mandateId: mandate.id, limit: 10 }).map((row) => row.outcome),
    ).toEqual(['settled', 'pending']);
    expect(db.repo.getMandate(mandate.id)).toMatchObject({
      reservedCents: 0,
      settledCents: 1499,
    });
  });

  it('closes rail credentials and releases reservations after mandate revocation', async () => {
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
    const card = await service.issueCard({
      task_id: mandate.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      idempotency_key: 'checkout-revoked',
    });
    db.repo.revokeMandate(mandate.id, 'Order cancelled', 'Local operator');

    await reconciler.runOnce();

    expect((await upstream.listCards()).find((row) => row.card_id === card.card_id)?.state).toBe(
      'closed',
    );
    expect(db.repo.getCard(card.card_id)?.state).toBe('closed');
    expect(db.repo.getMandate(mandate.id)?.reservedCents).toBe(0);
    expect(db.repo.getTask(mandate.taskId!)?.spentCents).toBe(0);
  });

  it('captures a final settlement that lands immediately before mandate revocation', async () => {
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
    const card = await service.issueCard({
      task_id: mandate.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      idempotency_key: 'checkout-settled-before-revoke',
    });
    upstream.simulatePurchase(card.card_id, {
      merchant: 'Staples',
      amount_cents: 1499,
    });
    db.repo.revokeMandate(mandate.id, 'Order cancelled after checkout', 'Local operator');

    await reconciler.runOnce();

    expect(db.repo.listReceipts({ taskId: mandate.taskId!, limit: 10 })).toHaveLength(1);
    expect(db.repo.listEvidence({ mandateId: mandate.id, limit: 10 })).toHaveLength(1);
    expect(db.repo.getMandate(mandate.id)).toMatchObject({
      status: 'revoked',
      reservedCents: 0,
      settledCents: 1499,
    });
    expect(db.repo.getTask(mandate.taskId!)?.spentCents).toBe(1499);
    expect(db.repo.getCard(card.card_id)?.state).toBe('closed');
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

  it('records a violation when rail-observed settlement does not match the mandate', async () => {
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
    const card = await service.issueCard({
      task_id: mandate.taskId!,
      amount_cents: 1000,
      merchant: 'Staples',
      idempotency_key: 'mismatch-settlement',
    });
    upstream.simulatePurchase(card.card_id, {
      merchant: 'UNAPPROVED GIFT CARDS',
      amount_cents: 900,
    });

    await reconciler.runOnce();

    const records = db.repo.listEvidence({ mandateId: mandate.id, limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'violation' });
    const payload = JSON.parse(records[0]!.payloadJson);
    expect(payload.decision).toBe('mismatch');
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PAYEE_MATCH', result: 'fail' }),
      ]),
    );
    expect(
      db.repo
        .listPolicyEvents({ type: 'block', limit: 10 })
        .map((event) => JSON.parse(event.detailsJson)),
    ).toContainEqual(
      expect.objectContaining({
        enforced_at: 'evidence',
        mandate_id: mandate.id,
      }),
    );
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
    const failingReconciler = new Reconciler({
      repo: db.repo,
      upstreams: { agentcard: failing },
      log: () => undefined,
    });
    await failingReconciler.runOnce();
    expect(failingReconciler.status.upstream_auth).toBe('needs_login');
    expect(failingReconciler.status.last_error).toMatch(/refresh token dead/);

    await reconciler.runOnce();
    expect(reconciler.status.upstream_auth).toBe('ok');
    expect(reconciler.status.last_error).toBeNull();
  });

  it('closes unused cards after the configured credential TTL and releases exposure', async () => {
    const agent = db.repo.getOrCreateAgent('shopper');
    db.repo.setActivePolicy(
      agent.id,
      JSON.stringify(PolicyRulesSchema.parse({ card_ttl_minutes: 1 })),
    );
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1000 });
    db.sqlite
      .prepare("UPDATE cards SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(card_id);

    await reconciler.runOnce();

    expect(db.repo.getCard(card_id)?.state).toBe('expired');
    expect(db.repo.getTask(task_id)?.spentCents).toBe(0);
    expect((await upstream.listCards())[0]?.state).toBe('closed');
    expect(
      db.repo
        .listPolicyEvents({ type: 'card_closed', limit: 10 })
        .map((event) => JSON.parse(event.detailsJson)),
    ).toContainEqual(
      expect.objectContaining({ card_id, reason: 'credential_ttl_expired' }),
    );
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
    const flakyReconciler = new Reconciler({
      repo: db.repo,
      upstreams: { agentcard: flaky },
      log: () => undefined,
    });

    await flakyReconciler.runOnce();
    // the healthy card still produced its receipt despite the flaky one
    expect(db.repo.listReceipts({ limit: 10 })).toHaveLength(1);
    expect(flakyReconciler.status.last_error).toMatch(/boom/);
  });
});
