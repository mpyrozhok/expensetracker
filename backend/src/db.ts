import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Sessions are stateless signed cookies, so this counter is what makes
  -- logout real: it is bumped on logout and every token carries the value it
  -- was minted with, so any token from a previous generation is refused.
  session_epoch INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_ci TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name_ci)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  date TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_user_category ON transactions (user_id, category_id);

CREATE TABLE IF NOT EXISTS budgets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, year, month)
);

CREATE TABLE IF NOT EXISTS budget_alert_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set by an ack over the WebSocket. Persisting it means a threshold stays
  -- acknowledged after a server restart, not just across a reconnect.
  read_at TEXT,
  UNIQUE (user_id, year, month, threshold)
);
`;

export function openDb(databasePath: string): Db {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Additive column migrations for a database created by an earlier release:
 * `CREATE TABLE IF NOT EXISTS` cannot extend an existing table, so columns added
 * after the first release are applied here. Every statement is a static string.
 */
const MIGRATIONS: Array<{ table: string; name: string; ddl: string }> = [
  {
    table: 'users',
    name: 'session_epoch',
    ddl: 'ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'budget_alert_fires',
    name: 'read_at',
    ddl: 'ALTER TABLE budget_alert_fires ADD COLUMN read_at TEXT',
  },
];

function migrate(db: Db): void {
  for (const step of MIGRATIONS) {
    const existing = new Set(
      (db.prepare('SELECT name FROM pragma_table_info(@table)').all({ table: step.table }) as Array<{
        name: string;
      }>).map((row) => row.name),
    );
    if (!existing.has(step.name)) db.exec(step.ddl);
  }
}

export interface UserRow {
  id: number;
  provider: string;
  provider_user_id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string;
  /** Bumped on logout; a token must carry the current value to be accepted. */
  session_epoch: number;
}

export interface CategoryRow {
  id: number;
  user_id: number;
  name: string;
  name_ci: string;
  created_at: string;
}

export interface TransactionRow {
  id: number;
  user_id: number;
  category_id: number | null;
  title: string;
  amount_cents: number;
  currency: string;
  date: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface BudgetRow {
  user_id: number;
  year: number;
  month: number;
  amount_cents: number;
  currency: string;
  created_at: string;
  updated_at: string;
}
