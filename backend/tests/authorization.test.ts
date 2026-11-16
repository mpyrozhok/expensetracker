import { describe, expect, it } from 'vitest';
import { currentPeriod, dayInCurrentMonth, testEnv, type TestApp } from './helpers.js';

interface Fixture {
  ada: TestApp;
  bob: TestApp;
  adaCategoryId: number;
  adaTransactionId: number;
}

async function twoUsers(): Promise<Fixture> {
  const ada = testEnv();
  await ada.api.login('ada');
  const bob = testEnv();
  await bob.api.login('bob');

  const category = await ada.api.post('/api/categories').send({ name: 'Rent' }).expect(201);
  const adaCategoryId = category.body.item.id as number;
  const tx = await ada.api
    .post('/api/transactions')
    .send({
      title: 'Apartment',
      amount: 900,
      currency: 'USD',
      date: dayInCurrentMonth(1),
      category_id: adaCategoryId,
    })
    .expect(201);

  return { ada, bob, adaCategoryId, adaTransactionId: tx.body.item.id as number };
}

describe('per-user data isolation', () => {
  it('hides another user’s categories, transactions and budgets from every verb', async () => {
    const { ada, bob, adaCategoryId, adaTransactionId } = await twoUsers();

    // Bob sees none of Ada's data in list endpoints.
    const bobCategories = await bob.api.get('/api/categories').expect(200);
    expect(bobCategories.body.items).toEqual([]);
    const bobTransactions = await bob.api.get('/api/transactions').expect(200);
    expect(bobTransactions.body.items).toEqual([]);
    const bobSummary = await bob.api.get('/api/budgets/summary').expect(200);
    expect(bobSummary.body.spent).toBe(0);
    expect(bobSummary.body.budget).toBe(null);

    // ...and cannot address Ada's rows by id: the answer is 404, not 403, so
    // ids cannot be probed for existence across accounts.
    await bob.api.get(`/api/transactions/${adaTransactionId}`).expect(404);
    await bob.api.put(`/api/transactions/${adaTransactionId}`).send({ title: 'hijacked' }).expect(404);
    await bob.api.del(`/api/transactions/${adaTransactionId}`).expect(404);
    await bob.api.put(`/api/categories/${adaCategoryId}`).send({ name: 'hijacked' }).expect(404);
    await bob.api.del(`/api/categories/${adaCategoryId}`).expect(404);

    // Ada's rows are untouched.
    const stillAda = await ada.api.get(`/api/transactions/${adaTransactionId}`).expect(200);
    expect(stillAda.body.item.title).toBe('Apartment');

    // Bob cannot launder his own transactions into Ada's category.
    const smuggled = await bob.api
      .post('/api/transactions')
      .send({
        title: 'smuggle',
        amount: 5,
        currency: 'USD',
        date: dayInCurrentMonth(2),
        category_id: adaCategoryId,
      });
    expect(smuggled.status).toBe(404);

    // Budgets are scoped too: Bob cannot overwrite Ada's budget for the month.
    await bob.api.put('/api/budgets').send({ ...currentPeriod(), amount: 1 }).expect(200);
    const adaSummary = await ada.api.get('/api/budgets/summary').expect(200);
    expect(adaSummary.body.budget).toBe(null);
    const bobSummaryAfter = await bob.api.get('/api/budgets/summary').expect(200);
    expect(bobSummaryAfter.body.budget).toMatchObject({ amount: 1 });

    ada.close();
    bob.close();
  });

  it('requires authentication on every data endpoint', async () => {
    const app = testEnv();
    await app.api.get('/api/auth/me').expect(401);
    await app.api.get('/api/categories').expect(401);
    await app.api.get('/api/transactions').expect(401);
    await app.api.get('/api/budgets/summary').expect(401);
    await app.api.post('/api/categories').send({ name: 'Anonymous' }).expect(401);
    await app.api.post('/api/transactions').send({ title: 'x' }).expect(401);
    await app.api.put('/api/budgets').send({ year: 2025, month: 1, amount: 5 }).expect(401);
    app.close();
  });

  it('treats a forged session cookie as anonymous', async () => {
    const app = testEnv();
    const res = await app.api.get('/api/transactions').set('Cookie', 'et_session=eyJ1aWQiOjEsImV4cCI6OTk5OTk5OTk5OX0.forged');
    expect(res.status).toBe(401);
    app.close();
  });
});
