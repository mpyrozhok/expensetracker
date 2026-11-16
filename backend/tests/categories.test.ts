import { describe, expect, it } from 'vitest';
import { dayInCurrentMonth, testEnv, type TestApp } from './helpers.js';

async function setup(): Promise<TestApp> {
  const app = testEnv();
  await app.api.login('ada');
  return app;
}

describe('categories', () => {
  it('creates, lists, renames and deletes a category', async () => {
    const app = await setup();

    const created = await app.api.post('/api/categories').send({ name: 'Groceries' }).expect(201);
    expect(created.body.item).toMatchObject({ name: 'Groceries', transaction_count: 0 });
    const id = created.body.item.id as number;

    const list = await app.api.get('/api/categories').expect(200);
    expect(list.body.items).toHaveLength(1);

    const renamed = await app.api.put(`/api/categories/${id}`).send({ name: 'Food' }).expect(200);
    expect(renamed.body.item.name).toBe('Food');

    await app.api.del(`/api/categories/${id}`).expect(204);
    const after = await app.api.get('/api/categories').expect(200);
    expect(after.body.items).toHaveLength(0);
    app.close();
  });

  it('enforces one category name per user, case-insensitively', async () => {
    const ada = await setup();
    await ada.api.post('/api/categories').send({ name: 'Rent' }).expect(201);
    const duplicate = await ada.api.post('/api/categories').send({ name: ' rent ' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('category_duplicate_name');

    // A different user may use the same name.
    const bob = testEnv();
    await bob.api.login('bob');
    await bob.api.post('/api/categories').send({ name: 'Rent' }).expect(201);
    ada.close();
    bob.close();
  });

  it('rejects an empty name', async () => {
    const app = await setup();
    const res = await app.api.post('/api/categories').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Name');
    app.close();
  });

  it('blocks deletion while transactions reference the category (documented strategy)', async () => {
    const app = await setup();
    const category = await app.api.post('/api/categories').send({ name: 'Travel' }).expect(201);
    const categoryId = category.body.item.id as number;
    await app.api
      .post('/api/transactions')
      .send({ title: 'Flight', amount: 120, currency: 'USD', date: dayInCurrentMonth(4), category_id: categoryId })
      .expect(201);

    const blocked = await app.api.del(`/api/categories/${categoryId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('category_in_use');
    expect(blocked.body.error.message).toContain('1 transaction');

    const stillThere = await app.api.get('/api/categories').expect(200);
    const first = stillThere.body.items[0] as { id: number; transaction_count: number };
    expect(first).toMatchObject({ id: categoryId, transaction_count: 1 });
    app.close();
  });

  it('renaming onto another existing name conflicts instead of renaming', async () => {
    const app = await setup();
    const a = await app.api.post('/api/categories').send({ name: 'Alpha' }).expect(201);
    await app.api.post('/api/categories').send({ name: 'Beta' }).expect(201);
    const res = await app.api.put(`/api/categories/${a.body.item.id}`).send({ name: 'Beta' });
    expect(res.status).toBe(409);
    app.close();
  });
});
