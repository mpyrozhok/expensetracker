import { describe, expect, it } from 'vitest';
import { dayInCurrentMonth, isoDate, testEnv, type TestApp } from './helpers.js';

async function setup(): Promise<{ app: TestApp; categoryId: number }> {
  const app = testEnv();
  await app.api.login('ada');
  const created = await app.api.post('/api/categories').send({ name: 'Groceries' }).expect(201);
  return { app, categoryId: created.body.item.id as number };
}

function payload(categoryId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Weekly shop',
    amount: '53.20',
    currency: 'USD',
    date: dayInCurrentMonth(5),
    category_id: categoryId,
    notes: 'Essentials',
    ...overrides,
  };
}

describe('transactions', () => {
  it('creates and reads back a transaction with every required field', async () => {
    const { app, categoryId } = await setup();
    const res = await app.api.post('/api/transactions').send(payload(categoryId)).expect(201);

    expect(res.body.item).toMatchObject({
      title: 'Weekly shop',
      amount: 53.2,
      currency: 'USD',
      category_id: categoryId,
      category_name: 'Groceries',
      notes: 'Essentials',
    });
    expect(typeof res.body.item.id).toBe('number');
    app.close();
  });

  it('edits any field, including moving it to another category', async () => {
    const app = testEnv();
    await app.api.login('ada');
    const groceries = await app.api.post('/api/categories').send({ name: 'Groceries' }).expect(201);
    const eatingOut = await app.api.post('/api/categories').send({ name: 'Eating out' }).expect(201);

    const created = await app.api
      .post('/api/transactions')
      .send(payload(groceries.body.item.id as number))
      .expect(201);

    const updated = await app.api
      .put(`/api/transactions/${created.body.item.id}`)
      .send({ title: 'Birthday dinner', amount: 88, category_id: eatingOut.body.item.id, notes: '' })
      .expect(200);

    expect(updated.body.item).toMatchObject({
      title: 'Birthday dinner',
      amount: 88,
      category_name: 'Eating out',
      notes: '',
    });
    // Untouched fields survive a partial update.
    expect(updated.body.item.date).toBe(dayInCurrentMonth(5));
    app.close();
  });

  it('deletes a transaction', async () => {
    const { app, categoryId } = await setup();
    const created = await app.api.post('/api/transactions').send(payload(categoryId)).expect(201);
    await app.api.del(`/api/transactions/${created.body.item.id}`).expect(204);
    await app.api.get(`/api/transactions/${created.body.item.id}`).expect(404);
    app.close();
  });

  it('rejects an empty title, a non-positive amount and an invalid date', async () => {
    const { app, categoryId } = await setup();

    const noTitle = await app.api.post('/api/transactions').send(payload(categoryId, { title: '  ' }));
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error.code).toBe('field_required');

    for (const amount of [0, '0', -5, '0.00', 'abc', '', '1.234']) {
      const res = await app.api.post('/api/transactions').send(payload(categoryId, { amount }));
      expect(res.status, `amount ${String(amount)} must be rejected`).toBe(400);
      expect(res.body.error.code).toMatch(/^amount_/);
    }

    for (const date of ['2024-02-31', 'not-a-date', '2024-13-01', '', '2024-1-1']) {
      const res = await app.api.post('/api/transactions').send(payload(categoryId, { date }));
      expect(res.status, `date ${String(date)} must be rejected`).toBe(400);
      expect(res.body.error.code).toMatch(/^date_/);
    }

    const badCurrency = await app.api.post('/api/transactions').send(payload(categoryId, { currency: 'EUR' }));
    expect(badCurrency.status).toBe(400);
    expect(badCurrency.body.error.code).toBe('currency_unsupported');

    const noCategory = await app.api.post('/api/transactions').send(payload(categoryId, { category_id: null }));
    expect(noCategory.status).toBe(400);
    expect(noCategory.body.error.code).toBe('id_invalid');

    app.close();
  });

  it('accepts a whole-unit amount and keeps two-decimal precision', async () => {
    const { app, categoryId } = await setup();
    const whole = await app.api.post('/api/transactions').send(payload(categoryId, { amount: 12 })).expect(201);
    expect(whole.body.item.amount).toBe(12);
    const cents = await app.api.post('/api/transactions').send(payload(categoryId, { amount: '0.05' })).expect(201);
    expect(cents.body.item.amount).toBe(0.05);
    app.close();
  });

  it('refuses a transaction pointing at a category that does not exist', async () => {
    const { app } = await setup();
    const res = await app.api.post('/api/transactions').send(payload(9999));
    expect(res.status).toBe(404);
    app.close();
  });

  it('lists newest first and reports the filtered total amount', async () => {
    const { app, categoryId } = await setup();
    await app.api
      .post('/api/transactions')
      .send(payload(categoryId, { title: 'Old', date: isoDate(-40), amount: 10 }))
      .expect(201);
    await app.api
      .post('/api/transactions')
      .send(payload(categoryId, { title: 'New', date: isoDate(-1), amount: 20 }))
      .expect(201);

    const list = await app.api.get('/api/transactions').expect(200);
    const titles = list.body.items.map((t: { title: string }) => t.title);
    expect(titles[0]).toBe('New');
    expect(list.body.total).toBe(2);
    expect(list.body.total_amount).toBe(30);
    app.close();
  });
});
