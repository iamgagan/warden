import { z } from 'zod';

// Upstream hard bounds (SPEC §2.7): create_card accepts 100–5000 cents.
export const UPSTREAM_MIN_CARD_CENTS = 100;
export const UPSTREAM_MAX_CARD_CENTS = 5000;

/** SPEC §2.6 — policy rules. Zero means "unlimited" for velocity fields. */
export const PolicyRulesSchema = z
  .object({
    allowed_merchants: z.array(z.string()).default([]), // empty = allow any
    blocked_merchants: z.array(z.string()).default([]),
    allowed_categories: z.array(z.string()).default([]), // empty = allow any
    per_card_cap_cents: z
      .number()
      .int()
      .positive()
      .default(UPSTREAM_MAX_CARD_CENTS),
    per_task_budget_cents: z.number().int().positive().default(10_000),
    per_merchant_caps: z.record(z.number().int().positive()).default({}),
    velocity: z
      .object({
        max_cards_per_hour: z.number().int().nonnegative().default(0),
        max_amount_cents_per_day: z.number().int().nonnegative().default(0),
      })
      .default({}),
    approval_threshold_cents: z.number().int().nonnegative().default(0),
    card_ttl_minutes: z.number().int().positive().default(60),
    default_rail: z.enum(['agentcard', 'stripe']).default('agentcard'),
  })
  .strict();

export type PolicyRules = z.infer<typeof PolicyRulesSchema>;

export const DEFAULT_POLICY: PolicyRules = PolicyRulesSchema.parse({});

export function parsePolicyRules(rulesJson: string): PolicyRules {
  return PolicyRulesSchema.parse(JSON.parse(rulesJson));
}

const normalizeText = (value: string): string => value.trim().toLocaleLowerCase();

/** Canonical merchant identity used by policy, reservation, replay, and settlement checks. */
export function normalizeMerchant(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const clampToUpstream = (cents: number): number =>
  Math.max(UPSTREAM_MIN_CARD_CENTS, Math.min(UPSTREAM_MAX_CARD_CENTS, cents));

export type IssueDecision =
  | { kind: 'issue'; card_amount_cents: number }
  | { kind: 'needs_approval'; threshold_cents: number }
  | { kind: 'block'; reasons: string[] };

export interface IssueRequest {
  amount_cents: number;
  merchant?: string;
  category?: string;
  taskSpentCents: number;
  taskBudgetCents: number;
  cardsLastHour: number;
  amountTodayCents: number;
}

/**
 * SPEC §3.2 — deterministic issuance gate. Pure, synchronous, no I/O.
 * Order: hard blocks first, then approval, then issue with the upstream clamp.
 */
export function evaluateIssue(policy: PolicyRules, req: IssueRequest): IssueDecision {
  const reasons: string[] = [];

  if (!Number.isInteger(req.amount_cents) || req.amount_cents <= 0) {
    reasons.push('amount_cents must be a positive integer');
  }

  const merchant = req.merchant === undefined ? undefined : normalizeMerchant(req.merchant);
  if (merchant !== undefined) {
    if (policy.blocked_merchants.some((m) => normalizeMerchant(m) === merchant)) {
      reasons.push(`merchant "${req.merchant}" is on the blocked list`);
    } else if (
      policy.allowed_merchants.length > 0 &&
      !policy.allowed_merchants.some((m) => normalizeMerchant(m) === merchant)
    ) {
      reasons.push(`merchant "${req.merchant}" is not on the allowed list`);
    }
  }

  if (
    req.category !== undefined &&
    policy.allowed_categories.length > 0 &&
    !policy.allowed_categories.some((c) => normalizeText(c) === normalizeText(req.category!))
  ) {
    reasons.push(`category "${req.category}" is not on the allowed list`);
  }

  const perCardCap = Math.min(policy.per_card_cap_cents, UPSTREAM_MAX_CARD_CENTS);
  if (req.amount_cents > perCardCap) {
    reasons.push(`amount ${req.amount_cents} exceeds per-card cap ${perCardCap}`);
  }

  const remainingBudget = Math.min(policy.per_task_budget_cents, req.taskBudgetCents) - req.taskSpentCents;
  if (req.amount_cents > remainingBudget) {
    reasons.push(`amount ${req.amount_cents} exceeds remaining task budget ${Math.max(0, remainingBudget)}`);
  }

  if (merchant !== undefined) {
    const merchantCapEntry = Object.entries(policy.per_merchant_caps).find(
      ([name]) => normalizeMerchant(name) === merchant,
    );
    if (merchantCapEntry && req.amount_cents > merchantCapEntry[1]) {
      reasons.push(
        `amount ${req.amount_cents} exceeds per-merchant cap ${merchantCapEntry[1]} for "${req.merchant}"`,
      );
    }
  }

  const circuit = evaluateCircuit(policy, {
    cardsLastHour: req.cardsLastHour,
    amountTodayCents: req.amountTodayCents,
  });
  if (circuit.open) reasons.push(...circuit.reasons);

  if (reasons.length > 0) return { kind: 'block', reasons };

  if (policy.approval_threshold_cents > 0 && req.amount_cents > policy.approval_threshold_cents) {
    return { kind: 'needs_approval', threshold_cents: policy.approval_threshold_cents };
  }

  return { kind: 'issue', card_amount_cents: clampToUpstream(req.amount_cents) };
}

export interface PurchaseRequest {
  merchant: string;
  amount_cents: number;
  category?: string;
  taskSpentCents: number;
  taskBudgetCents: number;
}

export interface PurchaseDecision {
  decision: 'allow' | 'block' | 'needs_approval';
  reasons: string[];
}

/** SPEC §3.2 — advisory precheck; same rules as issuance minus velocity/circuit. */
export function evaluatePurchase(policy: PolicyRules, req: PurchaseRequest): PurchaseDecision {
  const issue = evaluateIssue(policy, {
    amount_cents: req.amount_cents,
    merchant: req.merchant,
    category: req.category,
    taskSpentCents: req.taskSpentCents,
    taskBudgetCents: req.taskBudgetCents,
    cardsLastHour: 0,
    amountTodayCents: 0,
  });
  if (issue.kind === 'block') return { decision: 'block', reasons: issue.reasons };
  if (issue.kind === 'needs_approval') {
    return {
      decision: 'needs_approval',
      reasons: [`amount ${req.amount_cents} exceeds approval threshold ${issue.threshold_cents}`],
    };
  }
  return { decision: 'allow', reasons: [] };
}

export interface CircuitWindow {
  cardsLastHour: number;
  amountTodayCents: number;
}

export interface CircuitState {
  open: boolean;
  reasons: string[];
}

/** SPEC §3.2 — velocity circuit breaker. Zero limits mean unlimited. */
export function evaluateCircuit(policy: PolicyRules, window: CircuitWindow): CircuitState {
  const reasons: string[] = [];
  const { max_cards_per_hour, max_amount_cents_per_day } = policy.velocity;
  if (max_cards_per_hour > 0 && window.cardsLastHour >= max_cards_per_hour) {
    reasons.push(`issuance velocity ${window.cardsLastHour}/h at or above limit ${max_cards_per_hour}/h`);
  }
  if (max_amount_cents_per_day > 0 && window.amountTodayCents >= max_amount_cents_per_day) {
    reasons.push(
      `daily amount ${window.amountTodayCents} at or above limit ${max_amount_cents_per_day}`,
    );
  }
  return { open: reasons.length > 0, reasons };
}
