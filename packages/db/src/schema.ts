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
    createdAt: text('created_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [index('tasks_agent').on(t.agentId), index('tasks_status').on(t.status)],
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
export type CardRow = typeof cards.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type ReceiptRow = typeof receipts.$inferSelect;
export type PolicyEventRow = typeof policyEvents.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export type TaskStatus = TaskRow['status'];
export type CardState = CardRow['state'];
export type TransactionStatus = TransactionRow['status'];
export type PolicyEventType = PolicyEventRow['type'];
export type ApprovalStatus = ApprovalRow['status'];
