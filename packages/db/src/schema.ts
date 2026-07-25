import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// SPEC §2.5. Money is integer cents; timestamps are UTC ISO 8601 strings.

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('agents_name_unique').on(t.name)],
);

export const policies = sqliteTable(
  'policies',
  {
    id: text('id').primaryKey(),
    // NULL = global default policy
    agentId: text('agent_id').references(() => agents.id),
    version: integer('version').notNull(),
    active: integer('active').notNull().default(0),
    rulesJson: text('rules_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('policies_agent_active').on(t.agentId, t.active)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    intent: text('intent').notNull(),
    status: text('status', { enum: ['active', 'completed', 'expired', 'halted'] }).notNull(),
    budgetCents: integer('budget_cents').notNull(),
    spentCents: integer('spent_cents').notNull().default(0),
    policyId: text('policy_id').references(() => policies.id),
    mandateId: text('mandate_id'),
    createdAt: text('created_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [index('tasks_agent').on(t.agentId), index('tasks_status').on(t.status)],
);

export const mandates = sqliteTable(
  'mandates',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    taskId: text('task_id'),
    purpose: text('purpose').notNull(),
    merchant: text('merchant').notNull(),
    status: text('status', {
      enum: ['draft', 'active', 'exhausted', 'revoked', 'expired'],
    }).notNull(),
    currency: text('currency').notNull().default('USD'),
    amountLimitCents: integer('amount_limit_cents').notNull(),
    perTransactionLimitCents: integer('per_transaction_limit_cents').notNull(),
    maxTransactions: integer('max_transactions').notNull(),
    transactionCount: integer('transaction_count').notNull().default(0),
    reservedCents: integer('reserved_cents').notNull().default(0),
    settledCents: integer('settled_cents').notNull().default(0),
    rail: text('rail', { enum: ['auto', 'agentcard', 'stripe'] }).notNull().default('auto'),
    policyId: text('policy_id').references(() => policies.id),
    policySnapshotHash: text('policy_snapshot_hash'),
    mandateHash: text('mandate_hash'),
    createdBy: text('created_by').notNull(),
    approvedBy: text('approved_by'),
    createdAt: text('created_at').notNull(),
    activatedAt: text('activated_at'),
    expiresAt: text('expires_at').notNull(),
    closedAt: text('closed_at'),
    closeReason: text('close_reason'),
  },
  (t) => [
    index('mandates_agent').on(t.agentId),
    index('mandates_status').on(t.status),
    index('mandates_created').on(t.createdAt),
  ],
);

export const authorizations = sqliteTable(
  'authorizations',
  {
    id: text('id').primaryKey(),
    mandateId: text('mandate_id')
      .notNull()
      .references(() => mandates.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    amountCents: integer('amount_cents').notNull(),
    merchant: text('merchant').notNull(),
    category: text('category'),
    rail: text('rail', { enum: ['agentcard', 'stripe'] }).notNull(),
    status: text('status', {
      enum: ['reserved', 'card_issued', 'released', 'settled'],
    }).notNull(),
    settledCents: integer('settled_cents').notNull().default(0),
    cardId: text('card_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('authorizations_idempotency_unique').on(t.mandateId, t.idempotencyKey),
    uniqueIndex('authorizations_card_unique').on(t.cardId),
    index('authorizations_mandate').on(t.mandateId),
  ],
);

export const cards = sqliteTable(
  'cards',
  {
    // AgentCard card_id, verbatim
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    amountCents: integer('amount_cents').notNull(),
    merchantHint: text('merchant_hint'),
    sandbox: integer('sandbox').notNull(),
    state: text('state', { enum: ['open', 'used', 'closed', 'expired'] }).notNull(),
    rail: text('rail', { enum: ['agentcard', 'stripe'] }).notNull().default('agentcard'),
    createdAt: text('created_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [index('cards_task').on(t.taskId), index('cards_state').on(t.state)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    // AgentCard txn id, verbatim
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    merchant: text('merchant').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    category: text('category'),
    status: text('status', {
      enum: ['PENDING', 'SETTLED', 'DECLINED', 'REVERSED', 'EXPIRED', 'REFUNDED'],
    }).notNull(),
    rawJson: text('raw_json').notNull(),
    occurredAt: text('occurred_at').notNull(),
    ingestedAt: text('ingested_at').notNull(),
  },
  (t) => [index('transactions_card').on(t.cardId)],
);

export const receipts = sqliteTable(
  'receipts',
  {
    id: text('id').primaryKey(),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    intent: text('intent').notNull(),
    policyId: text('policy_id'),
    decisionJson: text('decision_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('receipts_transaction_unique').on(t.transactionId),
    index('receipts_task').on(t.taskId),
    index('receipts_created').on(t.createdAt),
  ],
);

export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    receiptId: text('receipt_id')
      .notNull()
      .references(() => receipts.id),
    mandateId: text('mandate_id')
      .notNull()
      .references(() => mandates.id),
    authorizationId: text('authorization_id').references(() => authorizations.id),
    transactionId: text('transaction_id').notNull(),
    eventKey: text('event_key').notNull(),
    outcome: text('outcome', {
      enum: ['pending', 'settled', 'declined', 'reversed', 'refunded', 'violation'],
    }).notNull(),
    sequence: integer('sequence').notNull(),
    payloadJson: text('payload_json').notNull(),
    previousHash: text('previous_hash'),
    evidenceHash: text('evidence_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('evidence_event_unique').on(t.eventKey),
    index('evidence_receipt').on(t.receiptId),
    index('evidence_transaction').on(t.transactionId),
    uniqueIndex('evidence_hash_unique').on(t.evidenceHash),
    index('evidence_mandate').on(t.mandateId),
    index('evidence_created').on(t.createdAt),
  ],
);

export const policyEvents = sqliteTable(
  'policy_events',
  {
    id: text('id').primaryKey(),
    type: text('type', {
      enum: [
        'block',
        'circuit_break',
        'approval_required',
        'approved',
        'denied',
        'card_issued',
        'card_closed',
      ],
    }).notNull(),
    taskId: text('task_id').references(() => tasks.id),
    agentId: text('agent_id').references(() => agents.id),
    detailsJson: text('details_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('policy_events_type').on(t.type), index('policy_events_created').on(t.createdAt)],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    merchant: text('merchant').notNull(),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull(),
    requestedAt: text('requested_at').notNull(),
    decidedAt: text('decided_at'),
    decidedBy: text('decided_by'),
  },
  (t) => [index('approvals_status').on(t.status)],
);

export type AgentRow = typeof agents.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type MandateRow = typeof mandates.$inferSelect;
export type AuthorizationRow = typeof authorizations.$inferSelect;
export type CardRow = typeof cards.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
export type PolicyEventRow = typeof policyEvents.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export type TaskStatus = TaskRow['status'];
export type MandateStatus = MandateRow['status'];
export type AuthorizationStatus = AuthorizationRow['status'];
export type CardState = CardRow['state'];
export type TransactionStatus = TransactionRow['status'];
export type PolicyEventType = PolicyEventRow['type'];
export type ApprovalStatus = ApprovalRow['status'];
