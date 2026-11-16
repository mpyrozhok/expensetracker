import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../src/db.js';

/**
 * The schema in `db.ts` can only ever create a *fresh* database: every statement
 * is `CREATE TABLE IF NOT EXISTS`, which cannot add a column to a table that is
 * already there. Columns added after the first release therefore depend on the
 * migration step in `openDb`. These checks stand up a database in the shape of
 * that first release - no `session_epoch`, no `read_at` - and assert that opening
 * it upgrades in place without losing a row. A migration that only works on an
 * empty database is not a migration.
 */
const RELEASE_ONE_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_ci TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name_ci)
);
CREATE TABLE budget_alert_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, year, month, threshold)
);
`;

function legacyDatabase(): { file: string; db: Db } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-migrate-'));
  const file = path.join(dir, 'app.db');
  const db = new Database(file);
  db.exec(RELEASE_ONE_SCHEMA);
  db.prepare('INSERT INTO users (id, provider, provider_user_id, display_name) VALUES (?, ?, ?, ?)')
    .run(7, 'google', 'legacy-1', 'Legacy Ada');
  db.prepare('INSERT INTO categories (id, user_id, name, name_ci) VALUES (?, ?, ?, ?)')
    .run(3, 7, 'Rent', 'rent');
  db.prepare('INSERT INTO budget_alert_fires (user_id, year, month, threshold) VALUES (?, ?, ?, ?)')
    .run(7, 2026, 11, 50);
  return { file, db };
}

function columnNames(db: Db, table: string): string[] {
  return (db.prepare('SELECT name FROM pragma_table_info(@table)').all({ table }) as { name: string }[])
    .map((row) => row.name);
}

describe('upgrading a database written by an earlier release', () => {
  it('adds the columns later code depends on and keeps every row', () => {
    const { file, db } = legacyDatabase();
    expect(columnNames(db, 'users')).not.toContain('session_epoch');
    expect(columnNames(db, 'budget_alert_fires')).not.toContain('read_at');
    db.close();

    const upgraded = openDb(file);
    expect(columnNames(upgraded, 'users')).toContain('session_epoch');
    expect(columnNames(upgraded, 'budget_alert_fires')).toContain('read_at');

    const user = upgraded.prepare('SELECT * FROM users WHERE id = 7').get() as {
      display_name: string;
      session_epoch: number;
    };
    expect(user.display_name).toBe('Legacy Ada');
    // Existing sessions stay valid: generation 0 is what their tokens carry.
    expect(user.session_epoch).toBe(0);

    const fire = upgraded.prepare('SELECT * FROM budget_alert_fires WHERE user_id = 7').get() as {
      threshold: number;
      read_at: string | null;
    };
    expect(fire.threshold).toBe(50);
    // An alert that fired before acks were persisted starts out unread, not lost.
    expect(fire.read_at).toBeNull();

    expect(upgraded.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 1 });
    upgraded.close();
  });

  it('is idempotent, so a restart does not fail on an already-migrated file', () => {
    const { file, db } = legacyDatabase();
    db.close();

    const first = openDb(file);
    first.prepare('UPDATE users SET session_epoch = 3 WHERE id = 7').run();
    first.close();

    // Second open runs the migration check again against a table that already
    // has the columns; ALTER TABLE would throw if the check were wrong.
    const second = openDb(file);
    const user = second.prepare('SELECT session_epoch FROM users WHERE id = 7').get() as {
      session_epoch: number;
    };
    expect(user.session_epoch).toBe(3);
    second.close();
  });

  it('leaves a database created by the current schema untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-current-'));
    const file = path.join(dir, 'app.db');

    const fresh = openDb(file);
    expect(columnNames(fresh, 'users')).toContain('session_epoch');
    fresh.close();

    const reopened = openDb(file);
    expect(columnNames(reopened, 'users')).toContain('session_epoch');
    expect(columnNames(reopened, 'budget_alert_fires')).toContain('read_at');
    reopened.close();
  });
});
