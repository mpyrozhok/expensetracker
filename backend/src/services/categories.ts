import type { Db, CategoryRow } from '../db.js';
import { conflict, notFound } from '../validation.js';
import type { ApiCategory } from '../types.js';

export const MAX_NAME_LENGTH = 60;

export class CategoriesService {
  constructor(private readonly db: Db) {}

  list(userId: number): ApiCategory[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS transaction_count
           FROM categories c
          WHERE c.user_id = ?
          ORDER BY lower(c.name) COLLATE NOCASE ASC`,
      )
      .all(userId) as (CategoryRow & { transaction_count: number })[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      transaction_count: r.transaction_count,
      created_at: r.created_at,
    }));
  }

  get(userId: number, id: number): ApiCategory | null {
    const row = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS transaction_count
           FROM categories c
          WHERE c.user_id = ? AND c.id = ?`,
      )
      .get(userId, id) as (CategoryRow & { transaction_count: number }) | undefined;
    return row ? toApi(row) : null;
  }

  /** Same as get() for rows this service just wrote, so callers need no null checks. */
  private mustGet(userId: number, id: number): ApiCategory {
    const row = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS transaction_count
           FROM categories c
          WHERE c.user_id = ? AND c.id = ?`,
      )
      .get(userId, id) as (CategoryRow & { transaction_count: number }) | undefined;
    if (!row) throw new Error(`category ${id} vanished after write for user ${userId}`);
    return toApi(row);
  }

  /** Authorization helper: 404 for both "missing" and "belongs to somebody else". */
  getOwnedRow(userId: number, id: number): CategoryRow {
    const row = this.db
      .prepare('SELECT * FROM categories WHERE user_id = ? AND id = ?')
      .get(userId, id) as CategoryRow | undefined;
    if (!row) throw notFound('Category not found');
    return row;
  }

  create(userId: number, name: string): ApiCategory {
    this.assertNotDuplicate(userId, name);
    const info = this.db
      .prepare('INSERT INTO categories (user_id, name, name_ci) VALUES (?, ?, ?)')
      .run(userId, name, name.toLowerCase());
    return this.mustGet(userId, Number(info.lastInsertRowid));
  }

  rename(userId: number, id: number, name: string): ApiCategory {
    this.getOwnedRow(userId, id);
    this.assertNotDuplicate(userId, name, id);
    this.db
      .prepare('UPDATE categories SET name = ?, name_ci = ? WHERE user_id = ? AND id = ?')
      .run(name, name.toLowerCase(), userId, id);
    return this.mustGet(userId, id);
  }

  /**
   * Deletion strategy (documented in README): BLOCK.
   * A category that still has transactions cannot be deleted; the client gets
   * 409 category_in_use so the UI can explain what to do instead.
   */
  delete(userId: number, id: number): void {
    this.getOwnedRow(userId, id);
    const used = this.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND category_id = ?')
      .get(userId, id) as { n: number };
    if (used.n > 0) {
      throw conflict(
        'category_in_use',
        `Cannot delete: ${used.n} transaction${used.n === 1 ? '' : 's'} still use${used.n === 1 ? 's' : ''} this category. Move them first.`,
        { transaction_count: used.n },
      );
    }
    this.db.prepare('DELETE FROM categories WHERE user_id = ? AND id = ?').run(userId, id);
  }

  countTransactions(userId: number, categoryId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND category_id = ?')
      .get(userId, categoryId) as { n: number };
    return row.n;
  }

  private assertNotDuplicate(userId: number, name: string, exceptId?: number): void {
    const sql = exceptId
      ? 'SELECT id FROM categories WHERE user_id = ? AND name_ci = ? AND id != ?'
      : 'SELECT id FROM categories WHERE user_id = ? AND name_ci = ?';
    const args = exceptId ? [userId, name.toLowerCase(), exceptId] : [userId, name.toLowerCase()];
    const dup = (this.db.prepare(sql).get(...args) as { id: number } | undefined) !== undefined;
    if (dup) {
      throw conflict('category_duplicate_name', `You already have a category named "${name}"`);
    }
  }
}

function toApi(row: CategoryRow & { transaction_count: number }): ApiCategory {
  return { id: row.id, name: row.name, transaction_count: row.transaction_count, created_at: row.created_at };
}
