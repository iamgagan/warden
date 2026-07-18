import {
  DEFAULT_POLICY,
  evaluateIssue,
  parsePolicyRules,
  type PolicyRules,
} from '@warden/core';
import type { Repo, TaskRow } from '@warden/db';
import { UpstreamError, type CardCredentials, type UpstreamClient } from '@warden/upstream';
import { WardenToolError } from './errors.js';

export type WardenMode = 'test' | 'live';

export interface WardenServiceOptions {
  repo: Repo;
  upstream: UpstreamClient;
  mode: WardenMode;
  /** Wired to the reconciler in T8; complete_task triggers one immediate pass. */
  reconcileNow?: () => Promise<void>;
  now?: () => number;
}

/**
 * The logic behind every warden-mcp tool (SPEC §3.1), independent of MCP
 * transport so it is fully testable against MockUpstream.
 */
export class WardenService {
  private readonly repo: Repo;
  private readonly upstream: UpstreamClient;
  private readonly mode: WardenMode;
  private readonly reconcileNow: () => Promise<void>;
  private readonly nowMs: () => number;

  constructor(opts: WardenServiceOptions) {
    this.repo = opts.repo;
    this.upstream = opts.upstream;
    this.mode = opts.mode;
    this.reconcileNow = opts.reconcileNow ?? (async () => undefined);
    this.nowMs = opts.now ?? Date.now;
  }

  get sandbox(): boolean {
    return this.mode !== 'live';
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

  startTask(input: { agent_name: string; intent: string; budget_cents?: number }): {
    task_id: string;
    budget_cents: number;
    policy_summary: string;
  } {
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

  async issueCard(input: {
    task_id: string;
    amount_cents: number;
    merchant?: string;
    category?: string;
  }): Promise<{ card_id: string; amount_cents: number; single_use: true; expires: '7d-unused' }> {
    const task = this.activeTaskOrThrow(input.task_id);
    const { rules, policyId } = this.loadPolicy(task);

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

    let cardId: string;
    try {
      const created = await this.upstream.createCard({
        amount_cents: decision.card_amount_cents,
        sandbox: this.sandbox,
      });
      cardId = created.card_id;
    } catch (err) {
      throw upstreamToolError(err);
    }

    this.repo.insertCard({
      id: cardId,
      taskId: task.id,
      amountCents: decision.card_amount_cents,
      merchantHint: input.merchant ?? null,
      sandbox: this.sandbox,
    });
    // Reserve the card amount against the task budget; the reconciler trues
    // this up to settled amounts (releases the unspent remainder).
    this.repo.addTaskSpent(task.id, decision.card_amount_cents);
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
    };
  }

  async getCardDetails(input: { card_id: string }): Promise<CardCredentials> {
    const card = this.repo.getCard(input.card_id);
    if (!card) throw new WardenToolError('POLICY_BLOCKED', `unknown card ${input.card_id}`);
    if (card.state !== 'open') {
      throw new WardenToolError('POLICY_BLOCKED', `card ${input.card_id} is ${card.state}`, {
        state: card.state,
      });
    }
    this.activeTaskOrThrow(card.taskId);
    try {
      // Pass-through only: PAN/CVV stay in memory, never persisted or logged.
      return await this.upstream.getCardDetails(input.card_id);
    } catch (err) {
      throw upstreamToolError(err);
    }
  }

  async completeTask(input: { task_id: string }): Promise<{
    task_id: string;
    status: 'completed';
    cards_issued: number;
    receipts_count: number;
    total_spent_cents: number;
  }> {
    const task = this.activeTaskOrThrow(input.task_id);
    const cards = this.repo.listCardsByTask(task.id);
    for (const card of cards) {
      if (card.state !== 'open') continue;
      try {
        await this.upstream.closeCard(card.id);
      } catch (err) {
        throw upstreamToolError(err);
      }
      this.repo.setCardState(card.id, 'closed');
      // Release the unused reservation.
      this.repo.addTaskSpent(task.id, -card.amountCents);
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
