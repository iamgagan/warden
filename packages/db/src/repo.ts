import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { nanoid } from 'nanoid';
import { normalizeMerchant } from '@warden/core';
import {
  agents,
  approvals,
  authorizations,
  cards,
  evidence,
  mandates,
  policies,
  policyEvents,
  receipts,
  tasks,
  transactions,
  type AgentRow,
  type ApprovalRow,
  type ApprovalStatus,
  type AuthorizationRow,
  type CardRow,
  type CardState,
  type EvidenceRow,
  type MandateRow,
  type MandateStatus,
  type PolicyEventRow,
  type PolicyEventType,
  type PolicyRow,
  type ReceiptRow,
  type TaskRow,
  type TaskStatus,
  type TransactionRow,
} from './schema.js';

export type WardenDrizzle = BetterSQLite3Database;

export class MandateNotFoundError extends Error {}
export class MandateStateError extends Error {}

const now = (): string => new Date().toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export type AuthorizationReservationResult =
  | { kind: 'reserved' | 'existing'; authorization: AuthorizationRow }
  | {
      kind: 'denied';
      reason:
        | 'mandate_not_active'
        | 'mandate_expired'
        | 'merchant_not_allowed'
        | 'rail_not_allowed'
        | 'amount_exceeds_limit'
        | 'transaction_limit_reached'
        | 'budget_unavailable'
        | 'idempotency_conflict';
    };

export interface EvidenceListItem extends EvidenceRow {
  merchant: string;
  amountCents: number;
  currency: string;
  agentName: string;
  purpose: string;
}

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
  rail: CardRow['rail'];
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

    getAgent(id: string): AgentRow | undefined {
      return db.select().from(agents).where(eq(agents.id, id)).get();
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

    // ── mandates (operator-approved source of spend authority) ───────────
    createMandate(input: {
      agentId: string;
      purpose: string;
      merchant: string;
      amountLimitCents: number;
      perTransactionLimitCents: number;
      maxTransactions: number;
      expiresAt: string;
      rail: 'auto' | 'agentcard' | 'stripe';
      createdBy: string;
    }): MandateRow {
      if (!input.purpose.trim()) throw new Error('mandate purpose is required');
      if (!input.merchant.trim()) throw new Error('mandate merchant is required');
      if (!Number.isInteger(input.amountLimitCents) || input.amountLimitCents <= 0) {
        throw new Error('mandate amount limit must be a positive integer');
      }
      if (
        !Number.isInteger(input.perTransactionLimitCents) ||
        input.perTransactionLimitCents <= 0 ||
        input.perTransactionLimitCents > input.amountLimitCents
      ) {
        throw new Error('mandate per-transaction limit must be positive and within total authority');
      }
      if (!Number.isInteger(input.maxTransactions) || input.maxTransactions <= 0) {
        throw new Error('mandate max transactions must be a positive integer');
      }
      if (!Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt <= now()) {
        throw new Error('mandate expiry must be a future ISO timestamp');
      }
      const row: MandateRow = {
        id: nanoid(),
        agentId: input.agentId,
        taskId: null,
        purpose: input.purpose,
        merchant: input.merchant.trim(),
        status: 'draft',
        currency: 'USD',
        amountLimitCents: input.amountLimitCents,
        perTransactionLimitCents: input.perTransactionLimitCents,
        maxTransactions: input.maxTransactions,
        transactionCount: 0,
        reservedCents: 0,
        settledCents: 0,
        rail: input.rail,
        policyId: null,
        policySnapshotHash: null,
        mandateHash: null,
        createdBy: input.createdBy,
        approvedBy: null,
        createdAt: now(),
        activatedAt: null,
        expiresAt: input.expiresAt,
        closedAt: null,
        closeReason: null,
      };
      db.insert(mandates).values(row).run();
      return row;
    },

    activateMandate(id: string, approvedBy: string): MandateRow {
      return db.transaction((tx) => {
        const mandate = tx.select().from(mandates).where(eq(mandates.id, id)).get();
        if (!mandate) throw new MandateNotFoundError(`unknown mandate ${id}`);
        if (mandate.status === 'active') return mandate;
        if (mandate.status !== 'draft') {
          throw new MandateStateError(`mandate ${id} is ${mandate.status}`);
        }
        const activatedAt = now();
        if (mandate.expiresAt <= activatedAt) {
          tx
            .update(mandates)
            .set({ status: 'expired', closedAt: activatedAt, closeReason: 'expired before activation' })
            .where(eq(mandates.id, id))
            .run();
          throw new MandateStateError(`mandate ${id} is expired`);
        }
        const policy = tx
          .select()
          .from(policies)
          .where(and(eq(policies.agentId, mandate.agentId), eq(policies.active, 1)))
          .get() ??
          tx
            .select()
            .from(policies)
            .where(and(isNull(policies.agentId), eq(policies.active, 1)))
            .get();
        const policySnapshotHash = sha256(policy?.rulesJson ?? '{}');
        const task: TaskRow = {
          id: nanoid(),
          agentId: mandate.agentId,
          intent: mandate.purpose,
          status: 'active',
          budgetCents: mandate.amountLimitCents,
          spentCents: 0,
          policyId: policy?.id ?? null,
          mandateId: mandate.id,
          createdAt: activatedAt,
          closedAt: null,
        };
        tx.insert(tasks).values(task).run();
        const mandateHash = sha256(
          JSON.stringify({
            id: mandate.id,
            agentId: mandate.agentId,
            purpose: mandate.purpose,
            merchant: normalizeMerchant(mandate.merchant),
            currency: mandate.currency,
            amountLimitCents: mandate.amountLimitCents,
            perTransactionLimitCents: mandate.perTransactionLimitCents,
            maxTransactions: mandate.maxTransactions,
            rail: mandate.rail,
            expiresAt: mandate.expiresAt,
            policySnapshotHash,
            approvedBy,
            activatedAt,
          }),
        );
        tx
          .update(mandates)
          .set({
            taskId: task.id,
            status: 'active',
            policyId: policy?.id ?? null,
            policySnapshotHash,
            mandateHash,
            approvedBy,
            activatedAt,
          })
          .where(eq(mandates.id, id))
          .run();
        return tx.select().from(mandates).where(eq(mandates.id, id)).get()!;
      });
    },

    getMandate(id: string): MandateRow | undefined {
      return db.transaction((tx) => {
        const row = tx.select().from(mandates).where(eq(mandates.id, id)).get();
        const expiredAt = now();
        if (row?.status === 'active' && row.expiresAt <= expiredAt) {
          tx
            .update(mandates)
            .set({ status: 'expired', closedAt: expiredAt, closeReason: 'expiry reached' })
            .where(and(eq(mandates.id, id), eq(mandates.status, 'active')))
            .run();
          if (row.taskId) {
            tx
              .update(tasks)
              .set({ status: 'expired', closedAt: expiredAt })
              .where(eq(tasks.id, row.taskId))
              .run();
          }
          return tx.select().from(mandates).where(eq(mandates.id, id)).get();
        }
        return row;
      });
    },

    listMandates(status?: MandateStatus): MandateRow[] {
      const expiredAt = now();
      db.transaction((tx) => {
        const due = tx
          .select({ id: mandates.id, taskId: mandates.taskId })
          .from(mandates)
          .where(and(eq(mandates.status, 'active'), sql`${mandates.expiresAt} <= ${expiredAt}`))
          .all();
        for (const mandate of due) {
          tx
            .update(mandates)
            .set({ status: 'expired', closedAt: expiredAt, closeReason: 'expiry reached' })
            .where(eq(mandates.id, mandate.id))
            .run();
          if (mandate.taskId) {
            tx
              .update(tasks)
              .set({ status: 'expired', closedAt: expiredAt })
              .where(eq(tasks.id, mandate.taskId))
              .run();
          }
        }
      });
      return db
        .select()
        .from(mandates)
        .where(status ? eq(mandates.status, status) : undefined)
        .orderBy(desc(mandates.createdAt), desc(mandates.id))
        .all();
    },

    revokeMandate(id: string, reason: string, revokedBy: string): MandateRow {
      return db.transaction((tx) => {
        const mandate = tx.select().from(mandates).where(eq(mandates.id, id)).get();
        if (!mandate) throw new MandateNotFoundError(`unknown mandate ${id}`);
        if (!['draft', 'active'].includes(mandate.status)) {
          throw new MandateStateError(`mandate ${id} is ${mandate.status}`);
        }
        const closedAt = now();
        tx
          .update(mandates)
          .set({
            status: 'revoked',
            closedAt,
            closeReason: `${reason.trim()} — ${revokedBy}`,
          })
          .where(eq(mandates.id, id))
          .run();
        if (mandate.taskId) {
          tx
            .update(tasks)
            .set({ status: 'halted', closedAt })
            .where(eq(tasks.id, mandate.taskId))
            .run();
        }
        return tx.select().from(mandates).where(eq(mandates.id, id)).get()!;
      });
    },

    reserveAuthorization(input: {
      mandateId: string;
      taskId: string;
      idempotencyKey: string;
      requestHash: string;
      amountCents: number;
      merchant: string;
      category: string | null;
      rail: 'agentcard' | 'stripe';
    }): AuthorizationReservationResult {
      return db.transaction((tx): AuthorizationReservationResult => {
        const existing = tx
          .select()
          .from(authorizations)
          .where(
            and(
              eq(authorizations.mandateId, input.mandateId),
              eq(authorizations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .get();
        if (existing) {
          if (existing.requestHash !== input.requestHash) {
            return { kind: 'denied', reason: 'idempotency_conflict' };
          }
          if (existing.status === 'released' && existing.cardId === null) {
            // Provisioning failed before any rail artifact existed. Reusing the
            // same key is a safe retry: remove the inert reservation record and
            // re-run every current mandate check below.
            tx.delete(authorizations).where(eq(authorizations.id, existing.id)).run();
          } else {
            return { kind: 'existing', authorization: existing };
          }
        }

        const mandate = tx.select().from(mandates).where(eq(mandates.id, input.mandateId)).get();
        if (!mandate || mandate.taskId !== input.taskId) {
          return { kind: 'denied', reason: 'mandate_not_active' };
        }
        const timestamp = now();
        if (mandate.expiresAt <= timestamp) {
          tx
            .update(mandates)
            .set({ status: 'expired', closedAt: timestamp, closeReason: 'expiry reached' })
            .where(eq(mandates.id, mandate.id))
            .run();
          tx
            .update(tasks)
            .set({ status: 'expired', closedAt: timestamp })
            .where(eq(tasks.id, input.taskId))
            .run();
          return { kind: 'denied', reason: 'mandate_expired' };
        }
        if (mandate.status !== 'active') {
          return { kind: 'denied', reason: 'mandate_not_active' };
        }
        if (normalizeMerchant(mandate.merchant) !== normalizeMerchant(input.merchant)) {
          return { kind: 'denied', reason: 'merchant_not_allowed' };
        }
        if (mandate.rail !== 'auto' && mandate.rail !== input.rail) {
          return { kind: 'denied', reason: 'rail_not_allowed' };
        }
        if (input.amountCents > mandate.perTransactionLimitCents) {
          return { kind: 'denied', reason: 'amount_exceeds_limit' };
        }
        const openReservations =
          tx
            .select({ count: sql<number>`count(*)` })
            .from(authorizations)
            .where(
              and(
                eq(authorizations.mandateId, mandate.id),
                inArray(authorizations.status, ['reserved', 'card_issued']),
              ),
            )
            .get()?.count ?? 0;
        if (mandate.transactionCount + openReservations >= mandate.maxTransactions) {
          return { kind: 'denied', reason: 'transaction_limit_reached' };
        }

        const taskReservation = tx
          .update(tasks)
          .set({ spentCents: sql`${tasks.spentCents} + ${input.amountCents}` })
          .where(
            and(
              eq(tasks.id, input.taskId),
              eq(tasks.status, 'active'),
              sql`${tasks.spentCents} + ${input.amountCents} <= ${tasks.budgetCents}`,
            ),
          )
          .run();
        if (taskReservation.changes === 0) {
          return { kind: 'denied', reason: 'budget_unavailable' };
        }

        const mandateReservation = tx
          .update(mandates)
          .set({
            reservedCents: sql`${mandates.reservedCents} + ${input.amountCents}`,
          })
          .where(
            and(
              eq(mandates.id, input.mandateId),
              eq(mandates.status, 'active'),
              sql`${mandates.reservedCents} + ${mandates.settledCents} + ${input.amountCents} <= ${mandates.amountLimitCents}`,
            ),
          )
          .run();
        if (mandateReservation.changes === 0) {
          return { kind: 'denied', reason: 'budget_unavailable' };
        }

        const authorization: AuthorizationRow = {
          id: nanoid(),
          mandateId: input.mandateId,
          taskId: input.taskId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          amountCents: input.amountCents,
          merchant: input.merchant.trim(),
          category: input.category,
          rail: input.rail,
          status: 'reserved',
          settledCents: 0,
          cardId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        tx.insert(authorizations).values(authorization).run();
        return { kind: 'reserved', authorization };
      });
    },

    bindAuthorizationCard(id: string, cardId: string): boolean {
      const result = db
        .update(authorizations)
        .set({ cardId, status: 'card_issued', updatedAt: now() })
        .where(and(eq(authorizations.id, id), eq(authorizations.status, 'reserved')))
        .run();
      return result.changes > 0;
    },

    getAuthorizationByCard(cardId: string): AuthorizationRow | undefined {
      return db.select().from(authorizations).where(eq(authorizations.cardId, cardId)).get();
    },

    getAuthorizationByIdempotency(
      mandateId: string,
      idempotencyKey: string,
    ): AuthorizationRow | undefined {
      return db
        .select()
        .from(authorizations)
        .where(
          and(
            eq(authorizations.mandateId, mandateId),
            eq(authorizations.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
    },

    countOpenAuthorizations(mandateId: string): number {
      return (
        db
          .select({ count: sql<number>`count(*)` })
          .from(authorizations)
          .where(
            and(
              eq(authorizations.mandateId, mandateId),
              inArray(authorizations.status, ['reserved', 'card_issued']),
            ),
          )
          .get()?.count ?? 0
      );
    },

    releaseAuthorization(id: string): boolean {
      return db.transaction((tx) => {
        const authorization = tx.select().from(authorizations).where(eq(authorizations.id, id)).get();
        if (!authorization || !['reserved', 'card_issued'].includes(authorization.status)) return false;
        tx
          .update(authorizations)
          .set({ status: 'released', updatedAt: now() })
          .where(eq(authorizations.id, id))
          .run();
        tx
          .update(mandates)
          .set({
            reservedCents: sql`max(0, ${mandates.reservedCents} - ${authorization.amountCents})`,
          })
          .where(eq(mandates.id, authorization.mandateId))
          .run();
        tx
          .update(tasks)
          .set({ spentCents: sql`max(0, ${tasks.spentCents} - ${authorization.amountCents})` })
          .where(eq(tasks.id, authorization.taskId))
          .run();
        return true;
      });
    },

    /**
     * Idempotently true an authorization up to the card-wide cumulative
     * settled total. A rail can capture more than once before cancellation,
     * and multiple reconcilers can observe the same total concurrently.
     */
    settleAuthorization(id: string, settledCents: number): boolean {
      return db.transaction((tx) => {
        const authorization = tx.select().from(authorizations).where(eq(authorizations.id, id)).get();
        if (
          !authorization ||
          !['reserved', 'card_issued', 'settled'].includes(authorization.status) ||
          settledCents <= authorization.settledCents
        ) {
          return false;
        }
        if (settledCents > authorization.amountCents) return false;
        const firstSettlement = authorization.status !== 'settled';
        const delta = settledCents - authorization.settledCents;
        tx
          .update(authorizations)
          .set({ status: 'settled', settledCents, updatedAt: now() })
          .where(eq(authorizations.id, id))
          .run();
        tx
          .update(tasks)
          .set({
            spentCents: firstSettlement
              ? sql`${tasks.spentCents} + ${settledCents - authorization.amountCents}`
              : sql`${tasks.spentCents} + ${delta}`,
          })
          .where(eq(tasks.id, authorization.taskId))
          .run();
        tx
          .update(mandates)
          .set({
            reservedCents: firstSettlement
              ? sql`max(0, ${mandates.reservedCents} - ${authorization.amountCents})`
              : mandates.reservedCents,
            settledCents: sql`${mandates.settledCents} + ${delta}`,
            transactionCount: firstSettlement
              ? sql`${mandates.transactionCount} + 1`
              : mandates.transactionCount,
          })
          .where(eq(mandates.id, authorization.mandateId))
          .run();
        const mandate = tx
          .select()
          .from(mandates)
          .where(eq(mandates.id, authorization.mandateId))
          .get()!;
        if (
          mandate.reservedCents === 0 &&
          (mandate.settledCents >= mandate.amountLimitCents ||
            mandate.transactionCount >= mandate.maxTransactions)
        ) {
          tx
            .update(mandates)
            .set({ status: 'exhausted', closedAt: now(), closeReason: 'authority consumed' })
            .where(and(eq(mandates.id, mandate.id), eq(mandates.status, 'active')))
            .run();
        }
        return true;
      });
    },

    // ── tasks ─────────────────────────────────────────────────────────────
    createTask(input: {
      agentId: string;
      intent: string;
      budgetCents: number;
      policyId: string | null;
      mandateId?: string | null;
    }): TaskRow {
      const row: TaskRow = {
        id: nanoid(),
        agentId: input.agentId,
        intent: input.intent,
        status: 'active',
        budgetCents: input.budgetCents,
        spentCents: 0,
        policyId: input.policyId,
        mandateId: input.mandateId ?? null,
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

    tryReserveTaskSpend(id: string, cents: number): boolean {
      const result = db
        .update(tasks)
        .set({ spentCents: sql`${tasks.spentCents} + ${cents}` })
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.status, 'active'),
            sql`${tasks.spentCents} + ${cents} <= ${tasks.budgetCents}`,
          ),
        )
        .run();
      return result.changes > 0;
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
      id: string; // upstream card_id, verbatim
      taskId: string;
      amountCents: number;
      merchantHint: string | null;
      sandbox: boolean;
      rail: 'agentcard' | 'stripe';
    }): CardRow {
      const row: CardRow = {
        id: input.id,
        taskId: input.taskId,
        amountCents: input.amountCents,
        merchantHint: input.merchantHint,
        sandbox: input.sandbox ? 1 : 0,
        state: 'open',
        rail: input.rail,
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

    getReceiptByTransaction(transactionId: string): ReceiptRow | undefined {
      return db
        .select()
        .from(receipts)
        .where(eq(receipts.transactionId, transactionId))
        .get();
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
          rail: cards.rail,
        })
        .from(receipts)
        .innerJoin(transactions, eq(receipts.transactionId, transactions.id))
        .innerJoin(cards, eq(transactions.cardId, cards.id))
        .innerJoin(tasks, eq(receipts.taskId, tasks.id))
        .innerJoin(agents, eq(tasks.agentId, agents.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(receipts.createdAt), desc(receipts.id))
        .limit(filter.limit)
        .all();
      return rows.map(({ receipt, ...details }) => ({ ...receipt, ...details }));
    },

    countReceipts(): number {
      const row = db.select({ n: sql<number>`count(*)` }).from(receipts).get();
      return row?.n ?? 0;
    },

    // ── evidence (APPEND-ONLY hash-linked receipt projections) ───────────
    insertEvidence(input: {
      receiptId: string;
      mandateId: string;
      authorizationId: string | null;
      transactionId: string;
      eventKey: string;
      outcome: EvidenceRow['outcome'];
      payload: Record<string, unknown>;
    }): EvidenceRow {
      return db.transaction((tx) => {
        const existing = tx.select().from(evidence).where(eq(evidence.eventKey, input.eventKey)).get();
        if (existing) {
          const sameRecord =
            existing.receiptId === input.receiptId &&
            existing.mandateId === input.mandateId &&
            existing.authorizationId === input.authorizationId &&
            existing.transactionId === input.transactionId &&
            existing.outcome === input.outcome &&
            existing.payloadJson === JSON.stringify(input.payload);
          if (!sameRecord) {
            throw new Error(`evidence event key ${input.eventKey} was reused with different data`);
          }
          return existing;
        }
        const latest = tx.select().from(evidence).orderBy(desc(evidence.sequence)).limit(1).get();
        const sequence = (latest?.sequence ?? 0) + 1;
        const previousHash = latest?.evidenceHash ?? null;
        const id = nanoid();
        const createdAt = now();
        const payloadJson = JSON.stringify(input.payload);
        const evidenceHash = sha256(
          JSON.stringify({
            sequence,
            previousHash,
            record: {
              id,
              receiptId: input.receiptId,
              mandateId: input.mandateId,
              authorizationId: input.authorizationId,
              transactionId: input.transactionId,
              eventKey: input.eventKey,
              outcome: input.outcome,
              createdAt,
              payload: input.payload,
            },
          }),
        );
        const row: EvidenceRow = {
          id,
          receiptId: input.receiptId,
          mandateId: input.mandateId,
          authorizationId: input.authorizationId,
          transactionId: input.transactionId,
          eventKey: input.eventKey,
          outcome: input.outcome,
          sequence,
          payloadJson,
          previousHash,
          evidenceHash,
          createdAt,
        };
        tx.insert(evidence).values(row).run();
        return row;
      });
    },

    getEvidenceByReceipt(receiptId: string): EvidenceRow | undefined {
      return db
        .select()
        .from(evidence)
        .where(eq(evidence.receiptId, receiptId))
        .orderBy(desc(evidence.sequence))
        .limit(1)
        .get();
    },

    verifyEvidenceChain(): {
      valid: boolean;
      checkedRecords: number;
      firstInvalidSequence: number | null;
    } {
      const rows = db.select().from(evidence).orderBy(asc(evidence.sequence)).all();
      let previousHash: string | null = null;
      let expectedSequence = 1;
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payloadJson) as unknown;
          const expectedHash = sha256(
            JSON.stringify({
              sequence: row.sequence,
              previousHash: row.previousHash,
              record: {
                id: row.id,
                receiptId: row.receiptId,
                mandateId: row.mandateId,
                authorizationId: row.authorizationId,
                transactionId: row.transactionId,
                eventKey: row.eventKey,
                outcome: row.outcome,
                createdAt: row.createdAt,
                payload,
              },
            }),
          );
          if (
            row.sequence !== expectedSequence ||
            row.previousHash !== previousHash ||
            row.evidenceHash !== expectedHash
          ) {
            return {
              valid: false,
              checkedRecords: expectedSequence - 1,
              firstInvalidSequence: row.sequence,
            };
          }
        } catch (error) {
          console.error(
            `[warden-db] evidence chain verification failed at sequence ${row.sequence}: ${String(error)}`,
          );
          return {
            valid: false,
            checkedRecords: expectedSequence - 1,
            firstInvalidSequence: row.sequence,
          };
        }
        previousHash = row.evidenceHash;
        expectedSequence += 1;
      }
      return { valid: true, checkedRecords: rows.length, firstInvalidSequence: null };
    },

    listEvidence(filter: { mandateId?: string; limit: number }): EvidenceListItem[] {
      return db
        .select({
          evidence,
          merchant: transactions.merchant,
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          agentName: agents.name,
          purpose: mandates.purpose,
        })
        .from(evidence)
        .innerJoin(receipts, eq(evidence.receiptId, receipts.id))
        .innerJoin(transactions, eq(evidence.transactionId, transactions.id))
        .innerJoin(mandates, eq(evidence.mandateId, mandates.id))
        .innerJoin(agents, eq(mandates.agentId, agents.id))
        .where(filter.mandateId ? eq(evidence.mandateId, filter.mandateId) : undefined)
        .orderBy(desc(evidence.sequence))
        .limit(filter.limit)
        .all()
        .map(({ evidence: evidenceRow, ...details }) => ({ ...evidenceRow, ...details }));
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
