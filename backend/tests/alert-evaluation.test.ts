import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reachedThresholds } from '../src/services/alerts.js';
import { currentPeriod, dayInCurrentMonth, testEnv, type TestApp } from './helpers.js';

describe('threshold evaluation', () => {
  it('reaches 50, 80 and 100 at the exact spend boundaries and nowhere else', () => {
    const budget = 100_00;
    expect(reachedThresholds(budget, 0)).toEqual([]);
    expect(reachedThresholds(budget, 49_99)).toEqual([]);
    expect(reachedThresholds(budget, 50_00)).toEqual([50]);
    expect(reachedThresholds(budget, 79_99)).toEqual([50]);
    expect(reachedThresholds(budget, 80_00)).toEqual([50, 80]);
    expect(reachedThresholds(budget, 99_99)).toEqual([50, 80]);
    expect(reachedThresholds(budget, 100_00)).toEqual([50, 80, 100]);
    expect(reachedThresholds(budget, 350_00)).toEqual([50, 80, 100]);
  });

  it('never alerts when there is no budget for the period', () => {
    expect(reachedThresholds(0, 500_00)).toEqual([]);
  });
});

describe('alert ledger', () => {
  it('records each threshold once per month, even across re-evaluations', async () => {
    const app = testEnv();
    await app.api.login('ada');
    const userId = app.api.userId();
    const period = currentPeriod();

    app.ctx.budgets.set(userId, period, 100_00, 'USD');
    const first = app.ctx.alerts.evaluate(userId, period);
    expect(first?.fresh).toEqual([]);

    app.ctx.transactions.create(userId, {
      title: 'Rent',
      amount_cents: 60_00,
      currency: 'USD',
      date: dayInCurrentMonth(3),
      category_id: categoryFor(app),
      notes: '',
    });

    const second = app.ctx.alerts.evaluate(userId, period);
    expect(second?.fresh).toEqual([50]);

    // Re-evaluating the same state (reconnect, restart, another edit) is silent.
    const third = app.ctx.alerts.evaluate(userId, period);
    expect(third?.fresh).toEqual([]);
    expect(third?.reached).toEqual([50]);

    // A later edit that crosses 80 reports only 80 as new.
    app.ctx.transactions.create(userId, {
      title: 'Utilities',
      amount_cents: 25_00,
      currency: 'USD',
      date: dayInCurrentMonth(4),
      category_id: categoryFor(app),
      notes: '',
    });
    const fourth = app.ctx.alerts.evaluate(userId, period);
    expect(fourth?.fresh).toEqual([80]);
    expect(fourth?.reached).toEqual([50, 80]);
    app.close();
  });

  it('keeps each month independent', async () => {
    const app = testEnv();
    await app.api.login('ada');
    const userId = app.api.userId();
    const thisMonth = currentPeriod();
    const lastMonth = thisMonth.month === 1 ? { year: thisMonth.year - 1, month: 12 } : { year: thisMonth.year, month: thisMonth.month - 1 };

    app.ctx.budgets.set(userId, thisMonth, 100_00, 'USD');
    app.ctx.budgets.set(userId, lastMonth, 100_00, 'USD');

    app.ctx.transactions.create(userId, {
      title: 'This month',
      amount_cents: 100_00,
      currency: 'USD',
      date: dayInCurrentMonth(5),
      category_id: categoryFor(app),
      notes: '',
    });

    expect(app.ctx.alerts.evaluate(userId, thisMonth)?.reached).toEqual([50, 80, 100]);
    expect(app.ctx.alerts.evaluate(userId, lastMonth)?.reached).toEqual([]);
    app.close();
  });

  it('acknowledges a fired threshold, idempotently, and survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-alert-'));
    const file = path.join(dir, 'ledger.db');

    const app = testEnv({ config: { databasePath: file } });
    await app.api.login('ada');
    const userId = app.api.userId();
    const period = currentPeriod();

    app.ctx.budgets.set(userId, period, 100_00, 'USD');
    app.ctx.transactions.create(userId, {
      title: 'Rent',
      amount_cents: 60_00,
      currency: 'USD',
      date: dayInCurrentMonth(6),
      category_id: categoryFor(app),
      notes: '',
    });
    app.ctx.alerts.evaluate(userId, period);

    expect(app.ctx.alerts.snapshot(userId, period)).toMatchObject([{ threshold: 50, read: false }]);
    expect(app.ctx.alerts.markRead(userId, period, 50)).toBe(true);
    expect(app.ctx.alerts.snapshot(userId, period)).toMatchObject([{ threshold: 50, read: true }]);

    // Idempotent: a second ack (another tab, a retry) changes nothing.
    expect(app.ctx.alerts.markRead(userId, period, 50)).toBe(false);
    // A forged ack for a threshold that never fired writes nothing.
    expect(app.ctx.alerts.markRead(userId, period, 80)).toBe(false);
    expect(app.ctx.alerts.markRead(userId, period, 100)).toBe(false);
    app.close();

    // A brand new service over the same file: the ledger and the ack both lived.
    const reopened = testEnv({ config: { databasePath: file } });
    expect(reopened.ctx.alerts.snapshot(userId, period)).toMatchObject([
      { threshold: 50, read: true },
    ]);
    expect(reopened.ctx.alerts.firedThresholds(userId, period)).toEqual([50]);
    reopened.close();
  });

  it('returns null when the period has no budget', async () => {
    const app = testEnv();
    await app.api.login('ada');
    expect(app.ctx.alerts.evaluate(app.api.userId(), currentPeriod())).toBe(null);
    expect(app.ctx.alerts.snapshot(app.api.userId(), currentPeriod())).toEqual([]);
    app.close();
  });
});

/** The service layer needs a category id; create one once per user and reuse it. */
function categoryFor(app: TestApp, name = 'General'): number {
  const userId = app.api.userId();
  const existing = app.ctx.db
    .prepare('SELECT id FROM categories WHERE user_id = ? AND name = ?')
    .get(userId, name) as { id: number } | undefined;
  return existing ? existing.id : app.ctx.categories.create(userId, name).id;
}
