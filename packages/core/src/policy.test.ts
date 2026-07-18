import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  PolicyRulesSchema,
  evaluateCircuit,
  evaluateIssue,
  evaluatePurchase,
  parsePolicyRules,
  type IssueRequest,
  type PolicyRules,
} from './policy.js';

const policy = (overrides?: Partial<PolicyRules>): PolicyRules =>
  PolicyRulesSchema.parse({ ...overrides });

const req = (overrides?: Partial<IssueRequest>): IssueRequest => ({
  amount_cents: 1500,
  taskSpentCents: 0,
  taskBudgetCents: 10_000,
  cardsLastHour: 0,
  amountTodayCents: 0,
  ...overrides,
});

describe('PolicyRulesSchema', () => {
  it('applies documented defaults', () => {
    expect(DEFAULT_POLICY).toEqual({
      allowed_merchants: [],
      blocked_merchants: [],
      allowed_categories: [],
      per_card_cap_cents: 5000,
      per_task_budget_cents: 10_000,
      per_merchant_caps: {},
      velocity: { max_cards_per_hour: 0, max_amount_cents_per_day: 0 },
      approval_threshold_cents: 0,
      card_ttl_minutes: 60,
    });
  });

  it('rejects unknown keys and bad values', () => {
    expect(() => PolicyRulesSchema.parse({ nope: 1 })).toThrow();
    expect(() => PolicyRulesSchema.parse({ per_card_cap_cents: -5 })).toThrow();
    expect(() => PolicyRulesSchema.parse({ per_card_cap_cents: 10.5 })).toThrow();
    expect(() => parsePolicyRules('not json')).toThrow();
  });
});

describe('evaluateIssue — happy path and upstream clamp', () => {
  it('issues within all limits', () => {
    expect(evaluateIssue(policy(), req())).toEqual({ kind: 'issue', card_amount_cents: 1500 });
  });

  it('clamps card amount up to the upstream $1 minimum', () => {
    expect(evaluateIssue(policy(), req({ amount_cents: 50 }))).toEqual({
      kind: 'issue',
      card_amount_cents: 100,
    });
  });

  it('never exceeds the upstream $50 bound even if policy cap is higher', () => {
    const p = policy({ per_card_cap_cents: 999_999, per_task_budget_cents: 999_999 });
    const decision = evaluateIssue(p, req({ amount_cents: 6000, taskBudgetCents: 999_999 }));
    expect(decision).toMatchObject({ kind: 'block' });
    // per-card cap is clamped down to 5000, so 6000 is over cap
    expect((decision as { reasons: string[] }).reasons.join()).toMatch(/per-card cap 5000/);
  });

  it('rejects non-positive and non-integer amounts', () => {
    expect(evaluateIssue(policy(), req({ amount_cents: 0 })).kind).toBe('block');
    expect(evaluateIssue(policy(), req({ amount_cents: -100 })).kind).toBe('block');
    expect(evaluateIssue(policy(), req({ amount_cents: 10.5 })).kind).toBe('block');
  });
});

describe('evaluateIssue — merchant and category lists', () => {
  it('blocklist wins regardless of allowlist, case-insensitively', () => {
    const p = policy({ allowed_merchants: ['Staples'], blocked_merchants: ['staples'] });
    const d = evaluateIssue(p, req({ merchant: 'STAPLES' }));
    expect(d.kind).toBe('block');
    expect((d as { reasons: string[] }).reasons.join()).toMatch(/blocked list/);
  });

  it('empty allowlist allows any merchant; non-empty restricts', () => {
    expect(evaluateIssue(policy(), req({ merchant: 'anything' })).kind).toBe('issue');
    const p = policy({ allowed_merchants: ['staples'] });
    expect(evaluateIssue(p, req({ merchant: 'Staples' })).kind).toBe('issue');
    expect(evaluateIssue(p, req({ merchant: 'amazon' })).kind).toBe('block');
  });

  it('a missing merchant skips merchant rules (hint is optional)', () => {
    const p = policy({ allowed_merchants: ['staples'] });
    expect(evaluateIssue(p, req({ merchant: undefined })).kind).toBe('issue');
  });

  it('category allowlist behaves like merchant allowlist', () => {
    const p = policy({ allowed_categories: ['office'] });
    expect(evaluateIssue(p, req({ category: 'Office' })).kind).toBe('issue');
    expect(evaluateIssue(p, req({ category: 'toys' })).kind).toBe('block');
    expect(evaluateIssue(p, req()).kind).toBe('issue'); // no category given
  });
});

describe('evaluateIssue — budgets and caps', () => {
  it('blocks on per-card cap from policy', () => {
    const p = policy({ per_card_cap_cents: 1000 });
    expect(evaluateIssue(p, req({ amount_cents: 1001 })).kind).toBe('block');
    expect(evaluateIssue(p, req({ amount_cents: 1000 })).kind).toBe('issue');
  });

  it('blocks on budget exhaustion using min(policy budget, task budget)', () => {
    const p = policy({ per_task_budget_cents: 2000 });
    // task asked for 10_000 but policy caps the envelope at 2000
    expect(evaluateIssue(p, req({ amount_cents: 1500, taskSpentCents: 600 })).kind).toBe('block');
    expect(evaluateIssue(p, req({ amount_cents: 1400, taskSpentCents: 600 })).kind).toBe('issue');
    // task budget lower than policy budget
    expect(
      evaluateIssue(policy(), req({ amount_cents: 1500, taskBudgetCents: 1000 })).kind,
    ).toBe('block');
  });

  it('exact remaining budget is allowed; one cent over is blocked', () => {
    expect(
      evaluateIssue(policy(), req({ amount_cents: 1000, taskSpentCents: 9000 })).kind,
    ).toBe('issue');
    expect(
      evaluateIssue(policy(), req({ amount_cents: 1001, taskSpentCents: 9000 })).kind,
    ).toBe('block');
  });

  it('applies per-merchant caps case-insensitively', () => {
    const p = policy({ per_merchant_caps: { Staples: 1200 } });
    expect(evaluateIssue(p, req({ merchant: 'staples', amount_cents: 1200 })).kind).toBe('issue');
    expect(evaluateIssue(p, req({ merchant: 'staples', amount_cents: 1201 })).kind).toBe('block');
    expect(evaluateIssue(p, req({ merchant: 'amazon', amount_cents: 1300 })).kind).toBe('issue');
  });

  it('collects multiple reasons in one block decision', () => {
    const p = policy({ blocked_merchants: ['evil'], per_card_cap_cents: 500 });
    const d = evaluateIssue(p, req({ merchant: 'evil', amount_cents: 900 }));
    expect(d.kind).toBe('block');
    expect((d as { reasons: string[] }).reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('evaluateIssue — approvals', () => {
  it('routes over-threshold amounts to approval', () => {
    const p = policy({ approval_threshold_cents: 2000 });
    expect(evaluateIssue(p, req({ amount_cents: 2001 }))).toEqual({
      kind: 'needs_approval',
      threshold_cents: 2000,
    });
    expect(evaluateIssue(p, req({ amount_cents: 2000 })).kind).toBe('issue');
  });

  it('zero threshold disables approvals', () => {
    expect(evaluateIssue(policy(), req({ amount_cents: 4999 })).kind).toBe('issue');
  });

  it('hard blocks take precedence over approval', () => {
    const p = policy({ approval_threshold_cents: 100, blocked_merchants: ['evil'] });
    expect(evaluateIssue(p, req({ merchant: 'evil', amount_cents: 200 })).kind).toBe('block');
  });
});

describe('evaluateIssue — velocity and circuit', () => {
  it('zero velocity limits mean unlimited', () => {
    expect(
      evaluateIssue(policy(), req({ cardsLastHour: 10_000, amountTodayCents: 10_000_000 })).kind,
    ).toBe('issue');
  });

  it('blocks at the issuance-velocity limit (edge: at limit, not one below)', () => {
    const p = policy({ velocity: { max_cards_per_hour: 5, max_amount_cents_per_day: 0 } });
    expect(evaluateIssue(p, req({ cardsLastHour: 4 })).kind).toBe('issue');
    expect(evaluateIssue(p, req({ cardsLastHour: 5 })).kind).toBe('block');
  });

  it('blocks at the daily amount limit', () => {
    const p = policy({ velocity: { max_cards_per_hour: 0, max_amount_cents_per_day: 5000 } });
    expect(evaluateIssue(p, req({ amountTodayCents: 4999 })).kind).toBe('issue');
    expect(evaluateIssue(p, req({ amountTodayCents: 5000 })).kind).toBe('block');
  });
});

describe('evaluateCircuit', () => {
  it('is closed with no limits or under limits', () => {
    expect(evaluateCircuit(policy(), { cardsLastHour: 99, amountTodayCents: 99 })).toEqual({
      open: false,
      reasons: [],
    });
  });

  it('opens with reasons for each tripped limit', () => {
    const p = policy({ velocity: { max_cards_per_hour: 5, max_amount_cents_per_day: 1000 } });
    const state = evaluateCircuit(p, { cardsLastHour: 40, amountTodayCents: 2000 });
    expect(state.open).toBe(true);
    expect(state.reasons).toHaveLength(2);
  });
});

describe('evaluatePurchase', () => {
  it('mirrors issuance decisions without velocity input', () => {
    expect(
      evaluatePurchase(policy(), {
        merchant: 'staples',
        amount_cents: 1500,
        taskSpentCents: 0,
        taskBudgetCents: 10_000,
      }),
    ).toEqual({ decision: 'allow', reasons: [] });

    const blocked = evaluatePurchase(policy({ blocked_merchants: ['evil'] }), {
      merchant: 'evil',
      amount_cents: 100,
      taskSpentCents: 0,
      taskBudgetCents: 10_000,
    });
    expect(blocked.decision).toBe('block');
    expect(blocked.reasons.length).toBeGreaterThan(0);

    const approval = evaluatePurchase(policy({ approval_threshold_cents: 1000 }), {
      merchant: 'staples',
      amount_cents: 1500,
      taskSpentCents: 0,
      taskBudgetCents: 10_000,
    });
    expect(approval.decision).toBe('needs_approval');
    expect(approval.reasons.join()).toMatch(/threshold/);
  });

  it('is deterministic: same inputs, same output', () => {
    const p = policy({ allowed_merchants: ['staples'], per_card_cap_cents: 2000 });
    const input = {
      merchant: 'staples',
      amount_cents: 1999,
      taskSpentCents: 100,
      taskBudgetCents: 5000,
    };
    const a = evaluatePurchase(p, input);
    const b = evaluatePurchase(p, input);
    expect(a).toEqual(b);
  });
});
