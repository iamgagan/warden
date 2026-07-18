import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from './migrate.js';
import { createRepo, type Repo } from './repo.js';

export interface WardenDb {
  sqlite: BetterSqlite3.Database;
  repo: Repo;
  close(): void;
}

/** Opens (or creates) the SQLite database, applies migrations, returns the repo. */
export function openWardenDb(path: string): WardenDb {
  const sqlite = new BetterSqlite3(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(sqlite);
  const db = drizzle(sqlite);
  return {
    sqlite,
    repo: createRepo(db),
    close: () => sqlite.close(),
  };
}
