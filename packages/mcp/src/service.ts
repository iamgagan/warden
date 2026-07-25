import { createHash } from 'node:crypto';
import {
  DEFAULT_POLICY,
  UPSTREAM_MAX_CARD_CENTS,
  UPSTREAM_MIN_CARD_CENTS,
  evaluateIssue,
  evaluatePurchase,
  normalizeMerchant,
  parsePolicyRules,
  type PolicyRules,
} from '@warden/core';
import type { Repo, TaskRow } from '@warden/db';
import {
  UpstreamError,
  type CardSummary,
  type CardCredentials,
  type Rail,
  type UpstreamClient,
} from '@warden/upstream';
import { WardenToolError } from './errors.js';

export type WardenMode = 'test' | 'live';

export interface WardenServiceOptions {
  repo: Repo;
  /** One UpstreamClient per rail (SPEC §2.8). 'agentcard' must always be present. */
  upstreams: Partial<Record<Rail, UpstreamClient>> & { agentcard: UpstreamClient };
  mode: WardenMode;
  /** Wired to the reconciler in T8; complete_task triggers one immediate pass. */
  reconcileNow?: () => Promise<void>;
  now?: () => number;
  /**
   * Identity bound by the MCP process configuration. Mandate authority is
   * unavailable without it and can never be selected from a tool argument.
   */
  actorAgentName?: string;
  /**
   * Compatibility escape hatch for pre-mandate clients. Disabled by default
   * so an agent cannot self-declare authority around the operator workflow.
   */
  allowLegacyTasks?: boolean;
  /** Operational errors that need human attention. */
  log?: (line: string) => void;
}

/**
 * The logic behind every warden-mcp tool (SPEC §3.1), independent of MCP
 * transport so it is fully testable against MockUpstream.
 */
export class WardenService {
  private readonly repo: Repo;
  private readonly upstreams: Partial<Record<Rail, UpstreamClient>>;
  private readonly mode: WardenMode;
  private readonly reconcileNow: () => Promise<void>;
  private readonly nowMs: () => number;
  private readonly actorAgentName: string | undefined;
  private readonly allowLegacyTasks: boolean;
  private readonly log: (line: string) => void;

  constructor(opts: WardenServiceOptions) {
    this.repo = opts.repo;
    this.upstreams = opts.upstreams;
    this.mode = opts.mode;
    this.reconcileNow = opts.reconcileNow ?? (async () => undefined);
    this.nowMs = opts.now ?? Date.now;
    this.actorAgentName = opts.actorAgentName;
    this.allowLegacyTasks = opts.allowLegacyTasks ?? false;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  get sandbox(): boolean {
    return this.mode !== 'live';
  }

  private upstreamFor(rail: Rail): UpstreamClient {
    const client = this.upstreams[rail];
    if (!client) {
      throw new WardenToolError(
        'UPSTREAM_ERROR',
        `rail '${rail}' is not configured (missing credentials for this rail)`,
      );
    }
    return client;
  }

  private loadPolicy(task: TaskRow): { rules: PolicyRules; policyId: string | null } {
    const row = task.policyId
      ? this.repo.getPolicy(task.policyId)
      : this.repo.getActivePolicy(task.agentId);
    if (!row) return { rules: DEFAULT_POLICY, policyId: null };
    return { rules: parsePolicyRules(row.rulesJson), policyId: row.id };
  }

  private activeTaskOrThrow(taskId: string): TaskRow {
    const task = this.repo.getTask(taskId);
    if (!task) throw new WardenToolError('TASK_NOT_ACTIVE', `unknown task ${taskId}`);
    if (task.status !== 'active') {
      throw new WardenToolError('TASK_NOT_ACTIVE', `task ${taskId} is ${task.status}`, {
        status: task.status,
      });
    }
    return task;
  }

  private assertMandateActor(task: TaskRow): void {
    if (!task.mandateId) return;
    const delegatedAgent = this.repo.getAgent(task.agentId);
    if (!this.actorAgentName) {
      throw new WardenToolError(
        'POLICY_BLOCKED',
        'mandate tools require an MCP identity binding (set WARDEN_AGENT_NAME)',
        { reason: 'agent_identity_required', mandate_id: task.mandateId },
      );
    }
    if (!delegatedAgent || delegatedAgent.name !== this.actorAgentName) {
      throw new WardenToolError(
        'POLICY_BLOCKED',
        `mandate authority belongs to ${delegatedAgent?.name ?? 'another agent'}`,
        {
          reason: 'wrong_agent',
          mandate_id: task.mandateId,
          delegated_agent: delegatedAgent?.name ?? null,
        },
      );
    }
  }

  startTask(input: { agent_name: string; intent: string; budget_cents?: number }): {
    task_id: string;
    budget_cents: number;
    policy_summary: string;
  } {
    if (!this.allowLegacyTasks) {
      throw new WardenToolError(
        'POLICY_BLOCKED',
        'operator-approved authority is required; start an active mandate instead',
        { reason: 'operator_mandate_required' },
      );
    }
    const agent = this.repo.getOrCreateAgent(input.agent_name);
    const policyRow = this.repo.getActivePolicy(agent.id);
    const rules = policyRow ? parsePolicyRules(policyRow.rulesJson) : DEFAULT_POLICY;
    const budget = Math.min(
      input.budget_cents ?? rules.per_task_budget_cents,
      rules.per_task_budget_cents,
    );
    const task = this.repo.createTask({
      agentId: agent.id,
      intent: input.intent,
      budgetCents: budget,
      policyId: policyRow?.id ?? null,
    });
    return {
      task_id: task.id,
      budget_cents: budget,
      policy_summary: summarizePolicy(rules, budget),
    };
  }

  startMandateTask(input: { mandate_id: string }): {
    mandate_id: string;
    task_id: string;
    merchant: string;
    amount_available_cents: number;
    expires_at: string;
    policy_summary: string;
  } {
    const mandate = this.repo.getMandate(input.mandate_id);
    if (!mandate) {
      throw new WardenToolError('TASK_NOT_ACTIVE', `unknown mandate ${input.mandate_id}`);
    }
    if (mandate.status !== 'active' || !mandate.taskId) {
      throw new WardenToolError(
        'TASK_NOT_ACTIVE',
        `mandate ${input.mandate_id} is ${mandate.status}`,
        { status: mandate.status },
      );
    }
    const task = this.activeTaskOrThrow(mandate.taskId);
    this.assertMandateActor(task);
    const { rules } = this.loadPolicy(task);
    return {
      mandate_id: mandate.id,
      task_id: task.id,
      merchant: mandate.merchant,
      amount_available_cents:
        mandate.amountLimitCents - mandate.reservedCents - mandate.settledCents,
      expires_at: mandate.expiresAt,
      policy_summary: summarizePolicy(rules, task.budgetCents),
    };
  }

  listMyMandates(): {
    agent: string;
    mandates: Array<{
      mandate_id: string;
      purpose: string;
      merchant: string;
      amount_available_cents: number;
      per_transaction_limit_cents: number;
      transactions_remaining: number;
      expires_at: string;
      rail: 'auto' | Rail;
    }>;
  } {
    if (!this.actorAgentName) {
      throw new WardenToolError(
        'POLICY_BLOCKED',
        'mandate discovery requires an MCP identity binding (set WARDEN_AGENT_NAME)',
        { reason: 'agent_identity_required' },
      );
    }
    const agent = this.repo.getAgentByName(this.actorAgentName);
    const mandates = agent
      ? this.repo
          .listMandates('active')
          .filter((mandate) => mandate.agentId === agent.id)
          .map((mandate) => ({
            mandate_id: mandate.id,
            purpose: mandate.purpose,
            merchant: mandate.merchant,
            amount_available_cents:
              mandate.amountLimitCents - mandate.reservedCents - mandate.settledCents,
            per_transaction_limit_cents: mandate.perTransactionLimitCents,
            transactions_remaining: Math.max(
              0,
              mandate.maxTransactions -
                mandate.transactionCount -
                this.repo.countOpenAuthorizations(mandate.id),
            ),
            expires_at: mandate.expiresAt,
            rail: mandate.rail,
          }))
      : [];
    return { agent: this.actorAgentName, mandates };
  }

  async issueCard(input: {
    task_id: string;
    amount_cents: number;
    merchant?: string;
    category?: string;
    rail?: Rail;
    idempotency_key?: string;
  }): Promise<{
    card_id: string;
    amount_cents: number;
    single_use: true;
    expires: '7d-unused';
    rail: Rail;
  }> {
    const task = this.activeTaskOrThrow(input.task_id);
    this.assertMandateActor(task);
    const { rules, policyId } = this.loadPolicy(task);
    const rail = input.rail ?? rules.default_rail;

    if (task.mandateId) {
      const mandate = this.repo.getMandate(task.mandateId);
      if (!mandate || mandate.status !== 'active') {
        throw new WardenToolError(
          'TASK_NOT_ACTIVE',
          `mandate ${task.mandateId} is ${mandate?.status ?? 'missing'}`,
          { status: mandate?.status ?? 'missing' },
        );
      }
    }

    if (task.mandateId && input.idempotency_key) {
      const existing = this.repo.getAuthorizationByIdempotency(
        task.mandateId,
        input.idempotency_key,
      );
      if (existing?.cardId) {
        if (existing.status === 'released') {
          throw new WardenToolError(
            'POLICY_BLOCKED',
            'the previous authorization is closed; use a new idempotency key',
            { reason: 'authorization_released', mandate_id: task.mandateId },
          );
        }
        const canonicalAmount = Math.max(
          UPSTREAM_MIN_CARD_CENTS,
          Math.min(UPSTREAM_MAX_CARD_CENTS, input.amount_cents),
        );
        const sameRequest =
          existing.amountCents === canonicalAmount &&
          normalizeMerchant(existing.merchant) === normalizeMerchant(input.merchant ?? '') &&
          existing.category === (input.category ?? null) &&
          existing.rail === rail;
        if (!sameRequest) {
          throw new WardenToolError(
            'POLICY_BLOCKED',
            'the idempotency key was already used for a different request',
            { reason: 'idempotency_conflict', mandate_id: task.mandateId },
          );
        }
        return {
          card_id: existing.cardId,
          amount_cents: existing.amountCents,
          single_use: true,
          expires: '7d-unused',
          rail: existing.rail,
        };
      }
    }

    const hourAgo = new Date(this.nowMs() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(this.nowMs() - 24 * 60 * 60 * 1000).toISOString();
    const decision = evaluateIssue(rules, {
      amount_cents: input.amount_cents,
      merchant: input.merchant,
      category: input.category,
      taskSpentCents: task.spentCents,
      taskBudgetCents: task.budgetCents,
      cardsLastHour: this.repo.countCardsIssuedSince(task.agentId, hourAgo),
      amountTodayCents: this.repo.sumCardAmountsSince(task.agentId, dayAgo),
    });

    if (decision.kind === 'block') {
      this.repo.insertPolicyEvent({
        type: 'block',
        taskId: task.id,
        agentId: task.agentId,
        detailsJson: JSON.stringify({
          reasons: decision.reasons,
          request: input,
          enforced_at: 'issuance',
        }),
      });
      throw new WardenToolError('POLICY_BLOCKED', decision.reasons.join('; '), {
        reasons: decision.reasons,
      });
    }

    if (decision.kind === 'needs_approval') {
      // T7 stub (SPEC): approval flow lands in T15; block over-threshold for now.
      const reason = `amount ${input.amount_cents} exceeds approval threshold ${decision.threshold_cents}; human approvals ship in week 4`;
      this.repo.insertPolicyEvent({
        type: 'block',
        taskId: task.id,
        agentId: task.agentId,
        detailsJson: JSON.stringify({ reasons: [reason], request: input, enforced_at: 'issuance' }),
      });
      throw new WardenToolError('POLICY_BLOCKED', reason, {
        threshold_cents: decision.threshold_cents,
      });
    }

    let authorizationId: string | null = null;
    if (task.mandateId) {
      if (!input.merchant?.trim()) {
        throw new WardenToolError(
          'POLICY_BLOCKED',
          'a merchant is required for mandate-authorized spending',
          { reason: 'merchant_required' },
        );
      }
      if (!input.idempotency_key?.trim()) {
        throw new WardenToolError(
          'POLICY_BLOCKED',
          'idempotency_key is required for mandate-authorized spending',
          { reason: 'idempotency_key_required' },
        );
      }
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            taskId: task.id,
            amountCents: decision.card_amount_cents,
            merchant: normalizeMerchant(input.merchant),
            category: input.category ?? null,
            rail,
          }),
        )
        .digest('hex');
      const reservation = this.repo.reserveAuthorization({
        mandateId: task.mandateId,
        taskId: task.id,
        idempotencyKey: input.idempotency_key,
        requestHash,
        amountCents: decision.card_amount_cents,
        merchant: input.merchant,
        category: input.category ?? null,
        rail,
      });
      if (reservation.kind === 'denied') {
        this.repo.insertPolicyEvent({
          type: 'block',
          taskId: task.id,
          agentId: task.agentId,
          detailsJson: JSON.stringify({
            reasons: [reservation.reason],
            request: input,
            mandate_id: task.mandateId,
            enforced_at: 'authorization',
          }),
        });
        throw new WardenToolError('POLICY_BLOCKED', mandateReason(reservation.reason), {
          reason: reservation.reason,
          mandate_id: task.mandateId,
        });
      }
      authorizationId = reservation.authorization.id;
      if (reservation.kind === 'existing') {
        if (reservation.authorization.cardId) {
          return {
            card_id: reservation.authorization.cardId,
            amount_cents: reservation.authorization.amountCents,
            single_use: true,
            expires: '7d-unused',
            rail: reservation.authorization.rail,
          };
        }
        throw new WardenToolError(
          'APPROVAL_PENDING',
          'the matching authorization is already being provisioned; retry shortly',
          {
            authorization_id: reservation.authorization.id,
            mandate_id: task.mandateId,
          },
        );
      }
    } else if (!this.repo.tryReserveTaskSpend(task.id, decision.card_amount_cents)) {
      this.repo.insertPolicyEvent({
        type: 'block',
        taskId: task.id,
        agentId: task.agentId,
        detailsJson: JSON.stringify({
          reasons: ['task budget is no longer available'],
          request: input,
          enforced_at: 'authorization',
        }),
      });
      throw new WardenToolError('BUDGET_EXCEEDED', 'task budget is no longer available');
    }

    let cardId: string;
    try {
      const created = await this.upstreamFor(rail).createCard({
        amount_cents: decision.card_amount_cents,
        sandbox: this.sandbox,
      });
      cardId = created.card_id;
    } catch (err) {
      if (authorizationId) this.repo.releaseAuthorization(authorizationId);
      else this.repo.addTaskSpent(task.id, -decision.card_amount_cents);
      throw upstreamToolError(err);
    }

    let cardPersisted = false;
    try {
      this.repo.insertCard({
        id: cardId,
        taskId: task.id,
        amountCents: decision.card_amount_cents,
        merchantHint: input.merchant ?? null,
        sandbox: this.sandbox,
        rail,
      });
      cardPersisted = true;
      if (authorizationId && !this.repo.bindAuthorizationCard(authorizationId, cardId)) {
        throw new Error(`authorization ${authorizationId} was no longer reservable`);
      }
    } catch (err) {
      try {
        await this.upstreamFor(rail).closeCard(cardId);
        if (cardPersisted) this.repo.setCardState(cardId, 'closed');
        if (authorizationId) this.repo.releaseAuthorization(authorizationId);
        else this.repo.addTaskSpent(task.id, -decision.card_amount_cents);
      } catch (closeError) {
        // Keep authority reserved when the live rail artifact could not be
        // closed. This fails closed against retries and double issuance.
        this.log(
          `[warden] CRITICAL orphan-risk card ${cardId}: local persistence failed and compensating close failed: ${String(closeError)}`,
        );
        try {
          this.repo.insertPolicyEvent({
            type: 'circuit_break',
            taskId: task.id,
            agentId: task.agentId,
            detailsJson: JSON.stringify({
              reason: 'card_persistence_and_close_failed',
              card_id: cardId,
              rail,
              amount_cents: decision.card_amount_cents,
              local_error: err instanceof Error ? err.message : String(err),
              close_error: closeError instanceof Error ? closeError.message : String(closeError),
            }),
          });
        } catch (eventError) {
          this.log(`[warden] CRITICAL failed to persist orphan-risk event: ${String(eventError)}`);
        }
      }
      throw err;
    }
    this.repo.insertPolicyEvent({
      type: 'card_issued',
      taskId: task.id,
      agentId: task.agentId,
      detailsJson: JSON.stringify({
        card_id: cardId,
        amount_cents: decision.card_amount_cents,
        merchant: input.merchant ?? null,
        policy_id: policyId,
        sandbox: this.sandbox,
      }),
    });

    return {
      card_id: cardId,
      amount_cents: decision.card_amount_cents,
      single_use: true,
      expires: '7d-unused',
      rail,
    };
  }

  /**
   * SPEC §3.1 — advisory-only deterministic evaluation. Never mints a card or
   * touches task/card state; only writes a policy_event when it would block,
   * so the dashboard's block feed stays complete even for prechecks the agent
   * never acted on.
   */
  precheckPurchase(input: {
    task_id: string;
    merchant: string;
    amount_cents: number;
    category?: string;
  }): { decision: 'allow' | 'block' | 'needs_approval'; reasons: string[] } {
    const task = this.activeTaskOrThrow(input.task_id);
    this.assertMandateActor(task);
    const { rules } = this.loadPolicy(task);
    const policyResult = evaluatePurchase(rules, {
      merchant: input.merchant,
      amount_cents: input.amount_cents,
      category: input.category,
      taskSpentCents: task.spentCents,
      taskBudgetCents: task.budgetCents,
    });
    const mandateReasons: string[] = [];
    if (task.mandateId) {
      const mandate = this.repo.getMandate(task.mandateId);
      if (!mandate || mandate.status !== 'active') {
        mandateReasons.push(`mandate is ${mandate?.status ?? 'missing'}`);
      } else {
        if (normalizeMerchant(mandate.merchant) !== normalizeMerchant(input.merchant)) {
          mandateReasons.push(`merchant "${input.merchant}" does not match mandate payee "${mandate.merchant}"`);
        }
        if (input.amount_cents > mandate.perTransactionLimitCents) {
          mandateReasons.push(
            `amount ${input.amount_cents} exceeds mandate per-transaction limit ${mandate.perTransactionLimitCents}`,
          );
        }
        if (
          input.amount_cents >
          mandate.amountLimitCents - mandate.reservedCents - mandate.settledCents
        ) {
          mandateReasons.push('amount exceeds remaining mandate authority');
        }
        if (
          mandate.transactionCount + this.repo.countOpenAuthorizations(mandate.id) >=
          mandate.maxTransactions
        ) {
          mandateReasons.push('mandate transaction limit has been reached');
        }
      }
    }
    const result =
      mandateReasons.length > 0
        ? { decision: 'block' as const, reasons: mandateReasons }
        : policyResult;
    if (result.decision === 'block') {
      this.repo.insertPolicyEvent({
        type: 'block',
        taskId: task.id,
        agentId: task.agentId,
        detailsJson: JSON.stringify({
          reasons: result.reasons,
          request: input,
          enforced_at: 'advisory',
        }),
      });
    }
    return result;
  }

  async getCardDetails(input: { card_id: string }): Promise<CardCredentials> {
    const card = this.repo.getCard(input.card_id);
    if (!card) throw new WardenToolError('POLICY_BLOCKED', `unknown card ${input.card_id}`);
    if (card.state !== 'open') {
      throw new WardenToolError('POLICY_BLOCKED', `card ${input.card_id} is ${card.state}`, {
        state: card.state,
      });
    }
    const task = this.activeTaskOrThrow(card.taskId);
    this.assertMandateActor(task);
    if (task.mandateId) {
      const mandate = this.repo.getMandate(task.mandateId);
      if (!mandate || mandate.status !== 'active') {
        throw new WardenToolError(
          'TASK_NOT_ACTIVE',
          `mandate ${task.mandateId} is ${mandate?.status ?? 'missing'}`,
          { status: mandate?.status ?? 'missing' },
        );
      }
    }
    try {
      // Pass-through only: PAN/CVV stay in memory, never persisted or logged.
      return await this.upstreamFor(card.rail).getCardDetails(input.card_id);
    } catch (err) {
      throw upstreamToolError(err);
    }
  }

  async listCards(): Promise<Array<CardSummary & { rail: Rail }>> {
    if (!this.actorAgentName) {
      throw new WardenToolError(
        'POLICY_BLOCKED',
        'card discovery requires an MCP identity binding (set WARDEN_AGENT_NAME)',
        { reason: 'agent_identity_required' },
      );
    }
    const agent = this.repo.getAgentByName(this.actorAgentName);
    const visibleCardIds = new Set(
      agent
        ? this.repo
            .listTasksByAgent(agent.id)
            .flatMap((task) => this.repo.listCardsByTask(task.id).map((card) => card.id))
        : [],
    );
    const results = await Promise.all(
      (Object.entries(this.upstreams) as Array<[Rail, UpstreamClient]>).map(
        async ([rail, upstream]) =>
          (await upstream.listCards())
            .filter((card) => visibleCardIds.has(card.card_id))
            .map((card) => ({ ...card, rail })),
      ),
    );
    return results.flat();
  }

  async checkBalance(input: { card_id: string }): Promise<{ balance_cents: number }> {
    const card = this.repo.getCard(input.card_id);
    if (!card) throw new WardenToolError('POLICY_BLOCKED', `unknown card ${input.card_id}`);
    const task = this.repo.getTask(card.taskId);
    if (!task) {
      throw new WardenToolError('TASK_NOT_ACTIVE', `unknown task ${card.taskId}`);
    }
    this.assertMandateActor(task);
    return this.upstreamFor(card.rail).checkBalance(card.id);
  }

  async completeTask(input: { task_id: string }): Promise<{
    task_id: string;
    status: 'completed';
    cards_issued: number;
    receipts_count: number;
    total_spent_cents: number;
  }> {
    const task = this.activeTaskOrThrow(input.task_id);
    this.assertMandateActor(task);
    if (task.mandateId) {
      throw new WardenToolError(
        'POLICY_BLOCKED',
        'mandate tasks stay open for their approved lifetime; revoke the mandate from the operator console to close it',
        { reason: 'mandate_controlled_lifecycle', mandate_id: task.mandateId },
      );
    }
    // Catch up on settlements first: a card whose purchase already settled
    // upstream must become 'used' (keeping its spend) before we close the
    // remainder and release their reservations.
    await this.reconcileNow();
    const cards = this.repo.listCardsByTask(task.id);
    for (const card of cards) {
      const current = this.repo.getCard(card.id);
      if (current?.state !== 'open') continue;
      try {
        await this.upstreamFor(current.rail).closeCard(card.id);
      } catch (err) {
        throw upstreamToolError(err);
      }
      this.repo.setCardState(card.id, 'closed');
      // Release the unused reservation.
      const authorization = this.repo.getAuthorizationByCard(card.id);
      if (authorization) this.repo.releaseAuthorization(authorization.id);
      else this.repo.addTaskSpent(task.id, -card.amountCents);
      this.repo.insertPolicyEvent({
        type: 'card_closed',
        taskId: task.id,
        agentId: task.agentId,
        detailsJson: JSON.stringify({ card_id: card.id, reason: 'task_completed' }),
      });
    }
    this.repo.setTaskStatus(task.id, 'completed');
    await this.reconcileNow();
    const finalTask = this.repo.getTask(task.id)!;
    return {
      task_id: task.id,
      status: 'completed',
      cards_issued: cards.length,
      receipts_count: this.repo.listReceipts({ taskId: task.id, limit: 10_000 }).length,
      total_spent_cents: finalTask.spentCents,
    };
  }
}

function mandateReason(reason: string): string {
  const reasons: Record<string, string> = {
    mandate_not_active: 'the mandate is not active',
    mandate_expired: 'the mandate has expired',
    merchant_not_allowed: 'the merchant does not match the operator-approved payee',
    rail_not_allowed: 'the requested payment rail is outside the mandate',
    amount_exceeds_limit: 'the amount exceeds the mandate per-transaction limit',
    transaction_limit_reached: 'the mandate transaction limit has been reached',
    budget_unavailable: 'the mandate does not have enough authority remaining',
    idempotency_conflict: 'the idempotency key was already used for a different request',
  };
  return reasons[reason] ?? reason;
}

function summarizePolicy(rules: PolicyRules, budgetCents: number): string {
  const parts = [
    `task budget $${(budgetCents / 100).toFixed(2)}`,
    `per-card cap $${(Math.min(rules.per_card_cap_cents, 5000) / 100).toFixed(2)} (single-use)`,
    rules.allowed_merchants.length > 0
      ? `merchants limited to: ${rules.allowed_merchants.join(', ')}`
      : 'any merchant not on the blocklist',
  ];
  if (rules.blocked_merchants.length > 0) parts.push(`blocked: ${rules.blocked_merchants.join(', ')}`);
  if (rules.approval_threshold_cents > 0) {
    parts.push(`human approval above $${(rules.approval_threshold_cents / 100).toFixed(2)}`);
  }
  return parts.join('; ');
}

function upstreamToolError(err: unknown): WardenToolError {
  if (err instanceof WardenToolError) return err;
  if (err instanceof UpstreamError && err.code === 'UPSTREAM_AUTH_REQUIRED') {
    return new WardenToolError('UPSTREAM_AUTH_REQUIRED', err.message);
  }
  return new WardenToolError('UPSTREAM_ERROR', err instanceof Error ? err.message : String(err));
}
