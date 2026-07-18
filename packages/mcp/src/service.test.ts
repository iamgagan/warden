import { beforeEach, describe, expect, it } from 'vitest';
import { PolicyRulesSchema } from '@warden/core';
import { openWardenDb, type WardenDb } from '@warden/db';
import { MockUpstream } from '@warden/mock-agentcard';
import { WardenToolError } from './errors.js';
import { WardenService } from './service.js';

let db: WardenDb;
let upstream: MockUpstream;
let service: WardenService;

beforeEach(() => {
  db = openWardenDb(':memory:');
  upstream = new MockUpstream();
  service = new WardenService({ repo: db.repo, upstream, mode: 'test' });
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
