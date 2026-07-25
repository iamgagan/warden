import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PolicyRulesSchema } from '@warden/core';
import { openWardenDb, type WardenDb } from '@warden/db';
import { MockUpstream } from '@warden/mock-agentcard';
import { UpstreamError, type UpstreamClient } from '@warden/upstream';
import { WardenToolError } from './errors.js';
import { WardenService } from './service.js';

/**
 * A second rail's real card_id namespace never collides with AgentCard's
 * (e.g. Stripe's "ic_..." vs AgentCard's own ids) — but two bare MockUpstream
 * instances both count from "mock_card_1", so tests that exercise two rails
 * side by side need distinct id namespaces to avoid an artificial collision.
 */
function fakeRail(prefix: string): UpstreamClient {
  const inner = new MockUpstream();
  const toInner = new Map<string, string>();
  const toOuter = (id: string) => `${prefix}_${id}`;
  return {
    async createCard(req) {
      const { card_id } = await inner.createCard(req);
      const outer = toOuter(card_id);
      toInner.set(outer, card_id);
      return { card_id: outer };
    },
    async closeCard(id) {
      return inner.closeCard(toInner.get(id)!);
    },
    async getCardDetails(id) {
      const d = await inner.getCardDetails(toInner.get(id)!);
      return { ...d, card_id: id };
    },
    async listTransactions(id, opts) {
      return inner.listTransactions(toInner.get(id)!, opts);
    },
    async listCards() {
      return (await inner.listCards()).map((c) => ({ ...c, card_id: toOuter(c.card_id) }));
    },
    async checkBalance(id) {
      return inner.checkBalance(toInner.get(id)!);
    },
  };
}

let db: WardenDb;
let upstream: MockUpstream;
let service: WardenService;
const futureExpiry = (): string =>
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  db = openWardenDb(':memory:');
  upstream = new MockUpstream();
  service = new WardenService({
    repo: db.repo,
    upstreams: { agentcard: upstream },
    mode: 'test',
    actorAgentName: 'procurement-agent',
    allowLegacyTasks: true,
  });
});

const setPolicy = (agentName: string, rules: object) => {
  const agent = db.repo.getOrCreateAgent(agentName);
  return db.repo.setActivePolicy(agent.id, JSON.stringify(PolicyRulesSchema.parse(rules)));
};

describe('warden_start_task', () => {
  it('creates the agent on first use and applies the policy budget envelope', () => {
    setPolicy('shopper', { per_task_budget_cents: 3000 });
    const result = service.startTask({
      agent_name: 'shopper',
      intent: 'restock office supplies',
      budget_cents: 10_000,
    });
    expect(result.budget_cents).toBe(3000); // min(requested, policy)
    expect(result.policy_summary).toMatch(/task budget \$30\.00/);
    const task = db.repo.getTask(result.task_id)!;
    expect(task.intent).toBe('restock office supplies');
    expect(task.status).toBe('active');
    expect(db.repo.getAgentByName('shopper')).toBeDefined();
  });

  it('defaults the budget from policy when none is requested', () => {
    const result = service.startTask({ agent_name: 'fresh-agent', intent: 'x' });
    expect(result.budget_cents).toBe(10_000); // DEFAULT_POLICY.per_task_budget_cents
  });
});

describe('warden_issue_card', () => {
  it('mints a single-use sandbox card, reserves budget, and records the event', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'buy paper' });
    const card = await service.issueCard({
      task_id,
      amount_cents: 1500,
      merchant: 'staples',
    });
    expect(card).toEqual({
      card_id: 'mock_card_1',
      amount_cents: 1500,
      single_use: true,
      expires: '7d-unused',
      rail: 'agentcard',
    });
    expect((await upstream.listCards())[0]).toMatchObject({ sandbox: true, state: 'open' });
    expect(db.repo.getTask(task_id)?.spentCents).toBe(1500); // reservation
    expect(db.repo.getCard('mock_card_1')).toMatchObject({ state: 'open', merchantHint: 'staples' });
    expect(db.repo.countPolicyEvents('card_issued')).toBe(1);
  });

  it('POLICY_BLOCKED for a blocked merchant: no upstream card, block event recorded', async () => {
    setPolicy('shopper', { blocked_merchants: ['sketchy-gift-cards'] });
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'buy paper' });
    const attempt = service.issueCard({
      task_id,
      amount_cents: 1000,
      merchant: 'Sketchy-Gift-Cards',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(await upstream.listCards()).toHaveLength(0);
    expect(db.repo.countPolicyEvents('block')).toBe(1);
    expect(db.repo.getTask(task_id)?.spentCents).toBe(0);
  });

  it('enforces the cumulative task budget across multiple cards', async () => {
    const { task_id } = service.startTask({
      agent_name: 'shopper',
      intent: 'buy supplies',
      budget_cents: 4000,
    });
    await service.issueCard({ task_id, amount_cents: 2500 });
    await expect(service.issueCard({ task_id, amount_cents: 2000 })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
    await service.issueCard({ task_id, amount_cents: 1500 }); // exactly the remainder
    expect(db.repo.getTask(task_id)?.spentCents).toBe(4000);
  });

  it('atomically prevents simultaneous issuance from overspending a task', async () => {
    const { task_id } = service.startTask({
      agent_name: 'shopper',
      intent: 'buy supplies',
      budget_cents: 1000,
    });
    const results = await Promise.allSettled([
      service.issueCard({ task_id, amount_cents: 800 }),
      service.issueCard({ task_id, amount_cents: 800 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(db.repo.getTask(task_id)?.spentCents).toBe(800);
    expect(await upstream.listCards()).toHaveLength(1);
  });

  it('stubs the approval path as POLICY_BLOCKED for now (T15 ships it)', async () => {
    setPolicy('shopper', { approval_threshold_cents: 1000 });
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'buy a monitor' });
    await expect(service.issueCard({ task_id, amount_cents: 2000 })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      details: { threshold_cents: 1000 },
    });
  });

  it('applies issuance velocity from persisted card history', async () => {
    setPolicy('shopper', { velocity: { max_cards_per_hour: 2, max_amount_cents_per_day: 0 } });
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    await service.issueCard({ task_id, amount_cents: 200 });
    await service.issueCard({ task_id, amount_cents: 200 });
    await expect(service.issueCard({ task_id, amount_cents: 200 })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
  });

  it('rejects issuance on unknown or non-active tasks', async () => {
    await expect(service.issueCard({ task_id: 'nope', amount_cents: 100 })).rejects.toMatchObject({
      code: 'TASK_NOT_ACTIVE',
    });
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    await service.completeTask({ task_id });
    await expect(service.issueCard({ task_id, amount_cents: 100 })).rejects.toMatchObject({
      code: 'TASK_NOT_ACTIVE',
    });
  });
});

describe('mandate authority', () => {
  it('keeps self-declared legacy tasks behind an explicit compatibility flag', () => {
    const mandateOnly = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: upstream },
      mode: 'test',
      actorAgentName: 'procurement-agent',
    });
    expect(() =>
      mandateOnly.startTask({ agent_name: 'procurement-agent', intent: 'self-declared spend' }),
    ).toThrow(/operator-approved authority is required/);
  });

  it('starts only active mandates and requires the declared merchant', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const draft = db.repo.createMandate({
      agentId: agent.id,
      purpose: 'Buy paper',
      merchant: 'Staples',
      amountLimitCents: 4000,
      perTransactionLimitCents: 2500,
      maxTransactions: 2,
      expiresAt: futureExpiry(),
      rail: 'agentcard',
      createdBy: 'local-operator',
    });
    expect(() => service.startMandateTask({ mandate_id: draft.id })).toThrow(/draft/);

    const active = db.repo.activateMandate(draft.id, 'local-operator');
    expect(service.startMandateTask({ mandate_id: active.id })).toMatchObject({
      mandate_id: active.id,
      task_id: active.taskId,
      merchant: 'Staples',
      amount_available_cents: 4000,
    });
    await expect(
      service.issueCard({
        task_id: active.taskId!,
        amount_cents: 1000,
        merchant: 'Office Depot',
        idempotency_key: 'checkout-1',
      }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });

  it('lets the bound agent discover only its own active mandates', () => {
    const procurement = db.repo.getOrCreateAgent('procurement-agent');
    const research = db.repo.getOrCreateAgent('research-agent');
    const own = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: procurement.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 1000,
        maxTransactions: 2,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    db.repo.activateMandate(
      db.repo.createMandate({
        agentId: research.id,
        purpose: 'Buy a report',
        merchant: 'Gartner',
        amountLimitCents: 5000,
        perTransactionLimitCents: 5000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );

    expect(service.listMyMandates()).toMatchObject({
      agent: 'procurement-agent',
      mandates: [
        {
          mandate_id: own.id,
          merchant: 'Staples',
          amount_available_cents: 2000,
          transactions_remaining: 2,
        },
      ],
    });
  });

  it('binds mandate authority to the configured MCP agent identity', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    const wrongAgent = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: upstream },
      mode: 'test',
      actorAgentName: 'research-agent',
    });

    expect(() => wrongAgent.startMandateTask({ mandate_id: active.id })).toThrow(
      /belongs to procurement-agent/,
    );
    await expect(
      wrongAgent.issueCard({
        task_id: active.taskId!,
        amount_cents: 1000,
        merchant: 'Staples',
        idempotency_key: 'wrong-agent',
      }),
    ).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      details: { reason: 'wrong_agent' },
    });
    expect(await upstream.listCards()).toHaveLength(0);
  });

  it('applies the identity binding to precheck, credentials, and lifecycle operations', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 2,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    const card = await service.issueCard({
      task_id: active.taskId!,
      amount_cents: 1000,
      merchant: 'Staples',
      idempotency_key: 'bound-card',
    });
    const wrongAgent = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: upstream },
      mode: 'test',
      actorAgentName: 'research-agent',
    });

    expect(() =>
      wrongAgent.precheckPurchase({
        task_id: active.taskId!,
        merchant: 'Staples',
        amount_cents: 500,
      }),
    ).toThrow(/belongs to procurement-agent/);
    await expect(wrongAgent.getCardDetails({ card_id: card.card_id })).rejects.toMatchObject({
      details: { reason: 'wrong_agent' },
    });
    await expect(wrongAgent.completeTask({ task_id: active.taskId! })).rejects.toMatchObject({
      details: { reason: 'wrong_agent' },
    });
  });

  it('prechecks mandate terms and never reports an out-of-scope purchase as allowed', () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 1200,
        maxTransactions: 2,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );

    expect(
      service.precheckPurchase({
        task_id: active.taskId!,
        merchant: 'Office Depot',
        amount_cents: 1500,
      }),
    ).toMatchObject({
      decision: 'block',
      reasons: expect.arrayContaining([
        expect.stringContaining('does not match mandate payee'),
        expect.stringContaining('per-transaction limit'),
      ]),
    });
  });

  it('keeps reusable mandate lifecycle under operator control', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy office supplies',
        merchant: 'Staples',
        amountLimitCents: 5000,
        perTransactionLimitCents: 2500,
        maxTransactions: 3,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );

    await expect(service.completeTask({ task_id: active.taskId! })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      details: { reason: 'mandate_controlled_lifecycle' },
    });
    expect(db.repo.getTask(active.taskId!)?.status).toBe('active');
    expect(db.repo.getMandate(active.id)?.status).toBe('active');
  });

  it('denies credential access after mandate expiry', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    const card = await service.issueCard({
      task_id: active.taskId!,
      amount_cents: 1000,
      merchant: 'Staples',
      idempotency_key: 'expiring-card',
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 2_000);
      await expect(service.getCardDetails({ card_id: card.card_id })).rejects.toMatchObject({
        code: 'TASK_NOT_ACTIVE',
        details: { status: 'expired' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an upstream-minimum amount retry as the same canonical request', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy a small sample',
        merchant: 'Staples',
        amountLimitCents: 500,
        perTransactionLimitCents: 500,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    const request = {
      task_id: active.taskId!,
      amount_cents: 50,
      merchant: 'Staples',
      idempotency_key: 'minimum-clamp',
    };
    const first = await service.issueCard(request);
    const retry = await service.issueCard(request);
    expect(retry).toEqual(first);
    expect(first.amount_cents).toBe(100);
    expect(await upstream.listCards()).toHaveLength(1);
  });

  it('returns the same card for an idempotent retry and never double reserves', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );

    const first = await service.issueCard({
      task_id: active.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      idempotency_key: 'checkout-42',
    });
    const retry = await service.issueCard({
      task_id: active.taskId!,
      amount_cents: 1500,
      merchant: 'Staples',
      idempotency_key: 'checkout-42',
    });

    expect(retry.card_id).toBe(first.card_id);
    expect(await upstream.listCards()).toHaveLength(1);
    expect(db.repo.getMandate(active.id)).toMatchObject({
      reservedCents: 1500,
      transactionCount: 1,
    });
  });

  it('does not mint a second card for a simultaneous same-key retry', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    const request = {
      task_id: active.taskId!,
      amount_cents: 1000,
      merchant: 'Staples',
      idempotency_key: 'simultaneous-checkout',
    };

    const results = await Promise.allSettled([
      service.issueCard(request),
      service.issueCard(request),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'APPROVAL_PENDING' },
    });
    expect(await upstream.listCards()).toHaveLength(1);
    expect(db.repo.getMandate(active.id)).toMatchObject({
      reservedCents: 1000,
      transactionCount: 1,
    });
  });

  it('can safely retry the same request after rail provisioning fails', async () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const active = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy paper',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    let failOnce = true;
    const flaky: UpstreamClient = {
      async createCard(request) {
        if (failOnce) {
          failOnce = false;
          throw new UpstreamError('temporary rail failure');
        }
        return upstream.createCard(request);
      },
      closeCard: (id) => upstream.closeCard(id),
      getCardDetails: (id) => upstream.getCardDetails(id),
      listTransactions: (id, options) => upstream.listTransactions(id, options),
      listCards: () => upstream.listCards(),
      checkBalance: (id) => upstream.checkBalance(id),
    };
    const retryService = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: flaky },
      mode: 'test',
      actorAgentName: 'procurement-agent',
    });
    const request = {
      task_id: active.taskId!,
      amount_cents: 1000,
      merchant: 'Staples',
      idempotency_key: 'checkout-retry',
    };

    await expect(retryService.issueCard(request)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    expect(db.repo.getMandate(active.id)?.reservedCents).toBe(0);

    const card = await retryService.issueCard(request);
    expect(card.card_id).toBe('mock_card_1');
    expect(db.repo.getMandate(active.id)).toMatchObject({
      reservedCents: 1000,
      transactionCount: 1,
    });
  });
});

describe('warden_precheck_purchase', () => {
  it('returns allow for an in-policy purchase and never mints a card or touches state', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'buy paper' });
    const result = service.precheckPurchase({ task_id, merchant: 'staples', amount_cents: 1000 });
    expect(result).toEqual({ decision: 'allow', reasons: [] });
    expect(await upstream.listCards()).toHaveLength(0);
    expect(db.repo.getTask(task_id)?.spentCents).toBe(0);
    expect(db.repo.countPolicyEvents('block')).toBe(0);
  });

  it('returns block with reasons for a blocked merchant and records an advisory policy_event', async () => {
    setPolicy('shopper', { blocked_merchants: ['sketchy-gift-cards'] });
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const result = service.precheckPurchase({
      task_id,
      merchant: 'Sketchy-Gift-Cards',
      amount_cents: 500,
    });
    expect(result.decision).toBe('block');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(db.repo.countPolicyEvents('block')).toBe(1);
    expect(await upstream.listCards()).toHaveLength(0); // advisory only, never mints
  });

  it('returns needs_approval over the threshold without blocking the eventual issuance path', async () => {
    setPolicy('shopper', { approval_threshold_cents: 1000 });
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const result = service.precheckPurchase({ task_id, merchant: 'staples', amount_cents: 2000 });
    expect(result.decision).toBe('needs_approval');
  });

  it('rejects prechecks on unknown or non-active tasks', () => {
    expect(() =>
      service.precheckPurchase({ task_id: 'nope', merchant: 'staples', amount_cents: 100 }),
    ).toThrow();
  });
});

describe('warden_get_card_details', () => {
  it('passes through credentials for open cards on active tasks only', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1000 });
    const creds = await service.getCardDetails({ card_id });
    expect(creds.pan).toMatch(/^4\d{15}$/);
    // card used → guard refuses before hitting upstream
    upstream.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 900 });
    // Warden's local state still says open; upstream refuses with its own error
    await expect(service.getCardDetails({ card_id })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('refuses cards Warden knows are not open', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1000 });
    db.repo.setCardState(card_id, 'closed');
    await expect(service.getCardDetails({ card_id })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
  });
});

describe('warden_complete_task', () => {
  it('closes open cards upstream, releases reservations, reports totals', async () => {
    const { task_id } = service.startTask({
      agent_name: 'shopper',
      intent: 'x',
      budget_cents: 5000,
    });
    await service.issueCard({ task_id, amount_cents: 1200 });
    await service.issueCard({ task_id, amount_cents: 800 });
    const result = await service.completeTask({ task_id });
    expect(result).toMatchObject({
      status: 'completed',
      cards_issued: 2,
      receipts_count: 0,
      total_spent_cents: 0, // nothing settled; both reservations released
    });
    const upstreamCards = await upstream.listCards();
    expect(upstreamCards.every((c) => c.state === 'closed')).toBe(true);
    expect(db.repo.countPolicyEvents('card_closed')).toBe(2);
    expect(db.repo.getTask(task_id)?.status).toBe('completed');
  });

  it('leaves used cards alone when completing', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    const { card_id } = await service.issueCard({ task_id, amount_cents: 1000 });
    upstream.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1000 });
    db.repo.setCardState(card_id, 'used'); // reconciler's job in T8
    const result = await service.completeTask({ task_id });
    expect(result.total_spent_cents).toBe(1000); // reservation kept for used card
    expect((await upstream.listCards())[0]?.state).toBe('used');
  });
});

describe('error payloads', () => {
  it('serializes code + details for the MCP layer', () => {
    const err = new WardenToolError('POLICY_BLOCKED', 'nope', { reasons: ['a', 'b'] });
    expect(err.toPayload()).toEqual({ code: 'POLICY_BLOCKED', message: 'nope', reasons: ['a', 'b'] });
  });
});

describe('multi-rail (SPEC §2.8)', () => {
  it('issues to the requested rail, defaults to agentcard, and dispatches getCardDetails/completeTask per-card by rail', async () => {
    const stripeRail = fakeRail('stripe');
    const multiRail = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: upstream, stripe: stripeRail },
      mode: 'test',
      allowLegacyTasks: true,
    });
    const { task_id } = multiRail.startTask({ agent_name: 'shopper', intent: 'multi-rail run' });

    const viaStripe = await multiRail.issueCard({ task_id, amount_cents: 1000, rail: 'stripe' });
    expect(viaStripe.rail).toBe('stripe');
    expect(await stripeRail.listCards()).toHaveLength(1);
    expect(await upstream.listCards()).toHaveLength(0);

    const viaAgentCard = await multiRail.issueCard({ task_id, amount_cents: 500 });
    expect(viaAgentCard.rail).toBe('agentcard'); // default_rail when `rail` is omitted
    expect(await upstream.listCards()).toHaveLength(1);

    // getCardDetails must ask the card's own rail, not always the default.
    const details = await multiRail.getCardDetails({ card_id: viaStripe.card_id });
    expect(details.card_id).toBe(viaStripe.card_id);

    await multiRail.completeTask({ task_id });
    expect((await stripeRail.listCards())[0]).toMatchObject({ state: 'closed' });
    expect((await upstream.listCards())[0]).toMatchObject({ state: 'closed' });
  });

  it('respects policy.default_rail when `rail` is omitted from warden_issue_card', async () => {
    setPolicy('stripe-shopper', { default_rail: 'stripe' });
    const stripeRail = fakeRail('stripe');
    const multiRail = new WardenService({
      repo: db.repo,
      upstreams: { agentcard: upstream, stripe: stripeRail },
      mode: 'test',
      allowLegacyTasks: true,
    });
    const { task_id } = multiRail.startTask({ agent_name: 'stripe-shopper', intent: 'x' });
    const card = await multiRail.issueCard({ task_id, amount_cents: 500 });
    expect(card.rail).toBe('stripe');
  });

  it('throws UPSTREAM_ERROR when the requested rail has no configured client', async () => {
    const { task_id } = service.startTask({ agent_name: 'shopper', intent: 'x' });
    await expect(
      service.issueCard({ task_id, amount_cents: 1000, rail: 'stripe' }),
    ).rejects.toThrow(/not configured/);
  });
});
