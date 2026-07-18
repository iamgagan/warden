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
