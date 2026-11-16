import { describe, expect, it } from 'vitest';
import { currentPeriod, dayInCurrentMonth, isoDate, testEnv, type TestApp } from './helpers.js';

async function setup(): Promise<{ app: TestApp; categoryId: number }> {
  const app = testEnv();
  await app.api.login('ada');
  const category = await app.api.post('/api/categories').send({ name: 'Living' }).expect(201);
  return { app, categoryId: category.body.item.id as number };
}

async function spend(app: TestApp, categoryId: number, amount: number | string, date: string): Promise<void> {
  await app.api
    .post('/api/transactions')
    .send({ title: `Spend ${amount}`, amount, currency: 'USD', date, category_id: categoryId, notes: '' })
    .expect(201);
}

describe('monthly budget', () => {
  it('reports an explicit "no budget set" state instead of misleading numbers', async () => {
    const { app, categoryId } = await setup();
    await spend(app, categoryId, 120, dayInCurrentMonth(2));

    const summary = await app.api.get('/api/budgets/summary').expect(200);
    expect(summary.body.budget).toBe(null);
    expect(summary.body.remaining).toBe(null);
    expect(summary.body.usage_percent).toBe(null);
    expect(summary.body.spent).toBe(120);
    expect(summary.body.transaction_count).toBe(1);
    app.close();
  });

  it('calculates spent, remaining and usage percentage for the selected month', async () => {
    const { app, categoryId } = await setup();
    const period = currentPeriod();
    await app.api.put('/api/budgets').send({ ...period, amount: 1000, currency: 'USD' }).expect(200);

    await spend(app, categoryId, 250, dayInCurrentMonth(3));
    await spend(app, categoryId, '120.50', dayInCurrentMonth(6));

    const summary = await app.api.get(`/api/budgets/summary?year=${period.year}&month=${period.month}`).expect(200);
    expect(summary.body.period).toEqual(period);
    expect(summary.body.budget).toMatchObject({ amount: 1000, currency: 'USD' });
    expect(summary.body.spent).toBe(370.5);
    expect(summary.body.remaining).toBe(629.5);
    expect(summary.body.usage_percent).toBe(37.05);
    app.close();
  });

  it('counts only the selected month', async () => {
    const { app, categoryId } = await setup();
    const period = currentPeriod();
    await app.api.put('/api/budgets').send({ ...period, amount: 500 }).expect(200);
    await spend(app, categoryId, 100, dayInCurrentMonth(4));
    // Last month's spend must not leak into this month's totals.
    await spend(app, categoryId, 400, isoDate(-45));

    const summary = await app.api.get('/api/budgets/summary').expect(200);
    expect(summary.body.spent).toBe(100);
    expect(summary.body.usage_percent).toBe(20);

    // A month without a budget keeps the empty state even though it has spend.
    const other = await app.api.get('/api/budgets/summary?year=2001&month=2').expect(200);
    expect(other.body).toMatchObject({ budget: null, remaining: null, usage_percent: null, spent: 0 });
    app.close();
  });

  it('allows overwriting and clearing the budget', async () => {
    const { app } = await setup();
    const period = currentPeriod();
    await app.api.put('/api/budgets').send({ ...period, amount: 500 }).expect(200);
    await app.api.put('/api/budgets').send({ ...period, amount: 750.25 }).expect(200);
    const after = await app.api.get('/api/budgets').expect(200);
    expect(after.body.budget).toMatchObject({ amount: 750.25 });

    await app.api.del(`/api/budgets?year=${period.year}&month=${period.month}`).expect(204);
    const cleared = await app.api.get('/api/budgets').expect(200);
    expect(cleared.body.budget).toBe(null);
    app.close();
  });

  it('rejects a non-positive or malformed budget amount and an invalid period', async () => {
    const { app } = await setup();
    const period = currentPeriod();

    for (const amount of [0, -10, 'abc', '', '1.999']) {
      const res = await app.api.put('/api/budgets').send({ ...period, amount });
      expect(res.status, `amount ${String(amount)}`).toBe(400);
    }
    const badMonth = await app.api.put('/api/budgets').send({ year: period.year, month: 13, amount: 100 });
    expect(badMonth.status).toBe(400);
    expect(badMonth.body.error.code).toBe('period_invalid');
    const badYear = await app.api.get('/api/budgets/summary?year=nope&month=3');
    expect(badYear.status).toBe(400);
    app.close();
  });
});
