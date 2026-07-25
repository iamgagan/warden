import type { Database } from 'better-sqlite3';

// Hand-rolled, append-only migration list. Never edit an applied migration;
// add a new one. Applied ids are tracked in _migrations.
const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: '0001_initial',
    sql: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX agents_name_unique ON agents (name);

      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES agents(id),
        version INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        rules_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX policies_agent_active ON policies (agent_id, active);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        intent TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','completed','expired','halted')),
        budget_cents INTEGER NOT NULL,
        spent_cents INTEGER NOT NULL DEFAULT 0,
        policy_id TEXT REFERENCES policies(id),
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE INDEX tasks_agent ON tasks (agent_id);
      CREATE INDEX tasks_status ON tasks (status);

      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        amount_cents INTEGER NOT NULL,
        merchant_hint TEXT,
        sandbox INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open','used','closed','expired')),
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE INDEX cards_task ON cards (task_id);
      CREATE INDEX cards_state ON cards (state);

      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id),
        merchant TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL CHECK (status IN ('PENDING','SETTLED','DECLINED','REVERSED','EXPIRED','REFUNDED')),
        raw_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );
      CREATE INDEX transactions_card ON transactions (card_id);

      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        intent TEXT NOT NULL,
        policy_id TEXT,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX receipts_transaction_unique ON receipts (transaction_id);
      CREATE INDEX receipts_task ON receipts (task_id);
      CREATE INDEX receipts_created ON receipts (created_at);

      CREATE TABLE policy_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('block','circuit_break','approval_required','approved','denied','card_issued','card_closed')),
        task_id TEXT REFERENCES tasks(id),
        agent_id TEXT REFERENCES agents(id),
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX policy_events_type ON policy_events (type);
      CREATE INDEX policy_events_created ON policy_events (created_at);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        merchant TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      );
      CREATE INDEX approvals_status ON approvals (status);
    `,
  },
  {
    id: '0002_cards_rail',
    sql: `
      ALTER TABLE cards ADD COLUMN rail TEXT NOT NULL DEFAULT 'agentcard';
    `,
  },
  {
    id: '0003_mandate_authority',
    sql: `
      ALTER TABLE tasks ADD COLUMN mandate_id TEXT;
      CREATE INDEX tasks_mandate ON tasks (mandate_id);

      CREATE TABLE mandates (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        task_id TEXT,
        purpose TEXT NOT NULL,
        merchant TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','active','exhausted','revoked','expired')),
        currency TEXT NOT NULL DEFAULT 'USD',
        amount_limit_cents INTEGER NOT NULL,
        per_transaction_limit_cents INTEGER NOT NULL,
        max_transactions INTEGER NOT NULL,
        transaction_count INTEGER NOT NULL DEFAULT 0,
        reserved_cents INTEGER NOT NULL DEFAULT 0,
        settled_cents INTEGER NOT NULL DEFAULT 0,
        rail TEXT NOT NULL DEFAULT 'auto' CHECK (rail IN ('auto','agentcard','stripe')),
        policy_id TEXT REFERENCES policies(id),
        policy_snapshot_hash TEXT,
        mandate_hash TEXT,
        created_by TEXT NOT NULL,
        approved_by TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        expires_at TEXT NOT NULL,
        closed_at TEXT,
        close_reason TEXT
      );
      CREATE INDEX mandates_agent ON mandates (agent_id);
      CREATE INDEX mandates_status ON mandates (status);
      CREATE INDEX mandates_created ON mandates (created_at);

      CREATE TABLE authorizations (
        id TEXT PRIMARY KEY,
        mandate_id TEXT NOT NULL REFERENCES mandates(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        merchant TEXT NOT NULL,
        category TEXT,
        rail TEXT NOT NULL CHECK (rail IN ('agentcard','stripe')),
        status TEXT NOT NULL CHECK (status IN ('reserved','card_issued','released','settled')),
        card_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX authorizations_idempotency_unique ON authorizations (mandate_id, idempotency_key);
      CREATE UNIQUE INDEX authorizations_card_unique ON authorizations (card_id);
      CREATE INDEX authorizations_mandate ON authorizations (mandate_id);

      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL REFERENCES receipts(id),
        mandate_id TEXT NOT NULL REFERENCES mandates(id),
        authorization_id TEXT REFERENCES authorizations(id),
        transaction_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('pending','settled','declined','reversed','refunded','violation')),
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT,
        evidence_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX evidence_event_unique ON evidence (event_key);
      CREATE INDEX evidence_receipt ON evidence (receipt_id);
      CREATE INDEX evidence_transaction ON evidence (transaction_id);
      CREATE UNIQUE INDEX evidence_hash_unique ON evidence (evidence_hash);
      CREATE INDEX evidence_mandate ON evidence (mandate_id);
      CREATE INDEX evidence_created ON evidence (created_at);
    `,
  },
  {
    id: '0004_authorization_settlement_totals',
    sql: `
      ALTER TABLE authorizations ADD COLUMN settled_cents INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: '0005_evidence_append_only',
    sql: `
      CREATE TRIGGER evidence_no_update
      BEFORE UPDATE ON evidence
      BEGIN
        SELECT RAISE(ABORT, 'evidence is append-only');
      END;

      CREATE TRIGGER evidence_no_delete
      BEFORE DELETE ON evidence
      BEGIN
        SELECT RAISE(ABORT, 'evidence is append-only');
      END;
    `,
  },
];

export function migrate(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (sqlite.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>).map((r) => r.id),
  );
  const record = sqlite.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
    });
    run();
  }
}
