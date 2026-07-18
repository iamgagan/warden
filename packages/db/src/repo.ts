import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { nanoid } from 'nanoid';
import {
  agents,
  approvals,
  cards,
  policies,
  policyEvents,
  receipts,
  tasks,
  transactions,
  type AgentRow,
  type ApprovalRow,
  type ApprovalStatus,
  type CardRow,
  type CardState,
  type PolicyEventRow,
  type PolicyEventType,
  type PolicyRow,
  type ReceiptRow,
  type TaskRow,
  type TaskStatus,
  type TransactionRow,
} from './schema.js';

export type WardenDrizzle = BetterSQLite3Database;

const now = (): string => new Date().toISOString();

export interface ReceiptListItem extends ReceiptRow {
  merchant: string;
  amountCents: number;
  currency: string;
  category: string | null;
  cardId: string;
  occurredAt: string;
  agentId: string;
  agentName: string;
  transactionStatus: TransactionRow['status'];
}

export interface AgentRollup extends AgentRow {
  totalSpentCents: number;
  receipts: number;
  blocks: number;
}

/**
 * Repository layer. Invariants enforced here, not in callers:
 * - exactly one active policy per agent_id (NULL agent_id = global default)
 * - receipts and policy_events are append-only: no update/delete is exported
 */
export function createRepo(db: WardenDrizzle) {
  return {
    // ── agents ────────────────────────────────────────────────────────────
    getOrCreateAgent(name: string, description?: string): AgentRow {
      const existing = db.select().from(agents).where(eq(agents.name, name)).get();
      if (existing) return existing;
      const row: AgentRow = {
        id: nanoid(),
        name,
        description: description ?? null,
        createdAt: now(),
      };
      db.insert(agents).values(row).run();
      return row;
    },

    getAgentByName(name: string): AgentRow | undefined {
      return db.select().from(agents).where(eq(agents.name, name)).get();
    },

    listAgents(): AgentRow[] {
      return db.select().from(agents).orderBy(agents.name).all();
    },

    // ── policies ──────────────────────────────────────────────────────────
    /**
     * Creates a NEW policy version for the agent (or the global default when
     * agentId is null) and atomically makes it the only active one.
     */
    setActivePolicy(agentId: string | null, rulesJson: string): PolicyRow {
      return db.transaction((tx) => {
        const scope = agentId === null ? isNull(policies.agentId) : eq(policies.agentId, agentId);
        const latest = tx
          .select({ version: sql<number>`coalesce(max(${policies.version}), 0)` })
          .from(policies)
          .where(scope)
          .get();
        tx.update(policies).set({ active: 0 }).where(and(scope, eq(policies.active, 1))).run();
        const row: PolicyRow = {
          id: nanoid(),
          agentId,
          version: (latest?.version ?? 0) + 1,
          active: 1,
          rulesJson,
          createdAt: now(),
        };
        tx.insert(policies).values(row).run();
        return row;
      });
    },

    /** Agent-specific active policy, falling back to the global default. */
    getActivePolicy(agentId: string | null): PolicyRow | undefined {
      if (agentId !== null) {
        const specific = db
          .select()
          .from(policies)
          .where(and(eq(policies.agentId, agentId), eq(policies.active, 1)))
          .get();
        if (specific) return specific;
      }
      return db
        .select()
        .from(policies)
        .where(and(isNull(policies.agentId), eq(policies.active, 1)))
        .get();
    },

    listPolicyVersions(agentId: string | null): PolicyRow[] {
      const scope = agentId === null ? isNull(policies.agentId) : eq(policies.agentId, agentId);
      return db.select().from(policies).where(scope).orderBy(desc(policies.version)).all();
    },

    getPolicy(id: string): PolicyRow | undefined {
      return db.select().from(policies).where(eq(policies.id, id)).get();
    },

    // ── tasks ─────────────────────────────────────────────────────────────
    createTask(input: {
      agentId: string;
      intent: string;
      budgetCents: number;
      policyId: string | null;
    }): TaskRow {
      const row: TaskRow = {
        id: nanoid(),
        agentId: input.agentId,
        intent: input.intent,
        status: 'active',
        budgetCents: input.budgetCents,
        spentCents: 0,
        policyId: input.policyId,
        createdAt: now(),
        closedAt: null,
      };
      db.insert(tasks).values(row).run();
      return row;
    },

    getTask(id: string): TaskRow | undefined {
      return db.select().from(tasks).where(eq(tasks.id, id)).get();
    },

    setTaskStatus(id: string, status: TaskStatus): void {
      const closedAt = status === 'active' ? null : now();
      db.update(tasks).set({ status, closedAt }).where(eq(tasks.id, id)).run();
    },

    addTaskSpent(id: string, cents: number): void {
      db.update(tasks)
        .set({ spentCents: sql`${tasks.spentCents} + ${cents}` })
        .where(eq(tasks.id, id))
        .run();
    },

    listTasksByAgent(agentId: string): TaskRow[] {
      return db
        .select()
        .from(tasks)
        .where(eq(tasks.agentId, agentId))
        .orderBy(desc(tasks.createdAt))
        .all();
    },

    listTasksByStatus(status: TaskStatus): TaskRow[] {
      return db.select().from(tasks).where(eq(tasks.status, status)).all();
    },

    // ── cards ─────────────────────────────────────────────────────────────
    insertCard(input: {
      id: string; // AgentCard card_id, verbatim
      taskId: string;
      amountCents: number;
      merchantHint: string | null;
      sandbox: boolean;
    }): CardRow {
      const row: CardRow = {
        id: input.id,
        taskId: input.taskId,
        amountCents: input.amountCents,
        merchantHint: input.merchantHint,
        sandbox: input.sandbox ? 1 : 0,
        state: 'open',
        createdAt: now(),
        closedAt: null,
      };
      db.insert(cards).values(row).run();
      return row;
    },

    getCard(id: string): CardRow | undefined {
      return db.select().from(cards).where(eq(cards.id, id)).get();
    },

    setCardState(id: string, state: CardState): void {
      const closedAt = state === 'open' ? null : now();
      db.update(cards).set({ state, closedAt }).where(eq(cards.id, id)).run();
    },

    listCardsByTask(taskId: string): CardRow[] {
      return db.select().from(cards).where(eq(cards.taskId, taskId)).all();
    },

    listCardsByState(state: CardState): CardRow[] {
      return db.select().from(cards).where(eq(cards.state, state)).all();
    },

    /** Cards issued for an agent since the ISO timestamp (issuance velocity). */
    countCardsIssuedSince(agentId: string, sinceIso: string): number {
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(cards)
        .innerJoin(tasks, eq(cards.taskId, tasks.id))
        .where(and(eq(tasks.agentId, agentId), sql`${cards.createdAt} >= ${sinceIso}`))
        .get();
      return row?.n ?? 0;
    },

    /** Sum of card amounts issued for an agent since the ISO timestamp (daily amount). */
    sumCardAmountsSince(agentId: string, sinceIso: string): number {
      const row = db
        .select({ n: sql<number>`coalesce(sum(${cards.amountCents}), 0)` })
        .from(cards)
        .innerJoin(tasks, eq(cards.taskId, tasks.id))
        .where(and(eq(tasks.agentId, agentId), sql`${cards.createdAt} >= ${sinceIso}`))
        .get();
      return row?.n ?? 0;
    },

    /** Open cards created before the given ISO timestamp (for TTL sweep). */
    listOpenCardsCreatedBefore(isoTimestamp: string): CardRow[] {
      return db
        .select()
        .from(cards)
        .where(and(eq(cards.state, 'open'), lt(cards.createdAt, isoTimestamp)))
        .all();
    },

    // ── transactions ──────────────────────────────────────────────────────
    /** Idempotent on transaction id; returns true if the row was inserted. */
    insertTransactionIfNew(row: Omit<TransactionRow, 'ingestedAt'>): boolean {
      const result = db
        .insert(transactions)
        .values({ ...row, ingestedAt: now() })
        .onConflictDoNothing()
        .run();
      return result.changes > 0;
    },

    updateTransactionStatus(id: string, status: TransactionRow['status']): void {
      db.update(transactions).set({ status }).where(eq(transactions.id, id)).run();
    },

    getTransaction(id: string): TransactionRow | undefined {
      return db.select().from(transactions).where(eq(transactions.id, id)).get();
    },

    listTransactionsByCard(cardId: string): TransactionRow[] {
      return db.select().from(transactions).where(eq(transactions.cardId, cardId)).all();
    },

    // ── receipts (APPEND-ONLY: insert + reads, nothing else) ─────────────
    insertReceipt(input: {
      transactionId: string;
      taskId: string;
      intent: string;
      policyId: string | null;
      decisionJson: string;
    }): ReceiptRow {
      const row: ReceiptRow = { id: nanoid(), ...input, createdAt: now() };
      db.insert(receipts).values(row).run();
      return row;
    },

    getReceipt(id: string): ReceiptListItem | undefined {
      return this.listReceipts({ receiptId: id, limit: 1 })[0];
    },

    listReceipts(filter: {
      taskId?: string;
      agentId?: string;
      receiptId?: string;
      limit: number;
      cursor?: string; // receipt id of the last item on the previous page
    }): ReceiptListItem[] {
      const conditions = [];
      if (filter.taskId) conditions.push(eq(receipts.taskId, filter.taskId));
      if (filter.agentId) conditions.push(eq(tasks.agentId, filter.agentId));
      if (filter.receiptId) conditions.push(eq(receipts.id, filter.receiptId));
      if (filter.cursor) {
        const anchor = db.select().from(receipts).where(eq(receipts.id, filter.cursor)).get();
        if (anchor) {
          conditions.push(
            sql`(${receipts.createdAt}, ${receipts.id}) < (${anchor.createdAt}, ${anchor.id})`,
          );
        }
      }
      const rows = db
        .select({
          receipt: receipts,
          merchant: transactions.merchant,
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          category: transactions.category,
          cardId: transactions.cardId,
          occurredAt: transactions.occurredAt,
          transactionStatus: transactions.status,
          agentId: tasks.agentId,
          agentName: agents.name,
        })
        .from(receipts)
        .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
        .innerJoin(tasks, eq(receipts.taskId, tasks.id))
        .innerJoin(agents, eq(tasks.agentId, agents.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(receipts.createdAt), desc(receipts.id))
        .limit(filter.limit)
        .all();
      return rows.map((r) => ({ ...r.receipt, ...r, receipt: undefined }) as unknown as ReceiptListItem);
    },

    countReceipts(): number {
      const row = db.select({ n: sql<number>`count(*)` }).from(receipts).get();
      return row?.n ?? 0;
    },

    // ── policy events (APPEND-ONLY) ───────────────────────────────────────
    insertPolicyEvent(input: {
      type: PolicyEventType;
      taskId: string | null;
      agentId: string | null;
      detailsJson: string;
    }): PolicyEventRow {
      const row: PolicyEventRow = { id: nanoid(), ...input, createdAt: now() };
      db.insert(policyEvents).values(row).run();
      return row;
    },

    listPolicyEvents(filter: { type?: PolicyEventType; limit: number }): PolicyEventRow[] {
      return db
        .select()
        .from(policyEvents)
        .where(filter.type ? eq(policyEvents.type, filter.type) : undefined)
        .orderBy(desc(policyEvents.createdAt), desc(policyEvents.id))
        .limit(filter.limit)
        .all();
    },

    countPolicyEvents(type: PolicyEventType): number {
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(policyEvents)
        .where(eq(policyEvents.type, type))
        .get();
      return row?.n ?? 0;
    },

    // ── approvals ─────────────────────────────────────────────────────────
    createApproval(input: {
      taskId: string;
      merchant: string;
      amountCents: number;
      reason: string;
    }): ApprovalRow {
      const row: ApprovalRow = {
        id: nanoid(),
        ...input,
        status: 'pending',
        requestedAt: now(),
        decidedAt: null,
        decidedBy: null,
      };
      db.insert(approvals).values(row).run();
      return row;
    },

    getApproval(id: string): ApprovalRow | undefined {
      return db.select().from(approvals).where(eq(approvals.id, id)).get();
    },

    decideApproval(id: string, decision: 'approved' | 'denied' | 'expired', decidedBy: string | null): void {
      db.update(approvals)
        .set({ status: decision, decidedAt: now(), decidedBy })
        .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
        .run();
    },

    listApprovals(status?: ApprovalStatus): ApprovalRow[] {
      return db
        .select()
        .from(approvals)
        .where(status ? eq(approvals.status, status) : undefined)
        .orderBy(desc(approvals.requestedAt))
        .all();
    },

    stats(): {
      spendUnderManagementCents: number;
      receiptsTotal: number;
      blocksTotal: number;
      avgBlastRadiusCents: number;
    } {
      const spent = db.select({ n: sql<number>`coalesce(sum(${tasks.spentCents}), 0)` }).from(tasks).get();
      // mean open-card exposure per task that currently has open cards
      const blast = db.get<{ n: number }>(sql`
        SELECT coalesce(avg(exposure), 0) AS n FROM (
          SELECT sum(amount_cents) AS exposure FROM cards
          WHERE state = 'open' GROUP BY task_id
        )
      `);
      return {
        spendUnderManagementCents: spent?.n ?? 0,
        receiptsTotal: this.countReceipts(),
        blocksTotal: this.countPolicyEvents('block'),
        avgBlastRadiusCents: Math.round(blast?.n ?? 0),
      };
    },

    // ── rollups (dashboard/stats) ─────────────────────────────────────────
    agentRollups(): AgentRollup[] {
      const rows = db.all<{
        id: string;
        name: string;
        description: string | null;
        created_at: string;
        total_spent_cents: number;
        receipts: number;
        blocks: number;
      }>(sql`
        SELECT
          a.id, a.name, a.description, a.created_at,
          coalesce((SELECT sum(t.spent_cents) FROM tasks t WHERE t.agent_id = a.id), 0) AS total_spent_cents,
          coalesce((SELECT count(*) FROM receipts r JOIN tasks t ON r.task_id = t.id WHERE t.agent_id = a.id), 0) AS receipts,
          coalesce((SELECT count(*) FROM policy_events e WHERE e.agent_id = a.id AND e.type = 'block'), 0) AS blocks
        FROM agents a
        ORDER BY a.name
      `);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        createdAt: r.created_at,
        totalSpentCents: r.total_spent_cents,
        receipts: r.receipts,
        blocks: r.blocks,
      }));
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
