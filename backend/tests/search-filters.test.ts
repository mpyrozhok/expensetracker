import { describe, expect, it } from 'vitest';
import { dayInCurrentMonth, isoDate, testEnv, type TestApp } from './helpers.js';

interface Fixture {
  app: TestApp;
  food: number;
  travel: number;
}

async function seed(): Promise<Fixture> {
  const app = testEnv();
  await app.api.login('ada');
  const food = (await app.api.post('/api/categories').send({ name: 'Food' }).expect(201)).body.item.id as number;
  const travel = (await app.api.post('/api/categories').send({ name: 'Travel' }).expect(201)).body.item
    .id as number;

  const rows: Array<[string, number, string, number, string]> = [
    ['Coffee beans', 18.5, dayInCurrentMonth(1), food, 'fair trade'],
    ['Flight to Lisbon', 240, dayInCurrentMonth(2), travel, 'conference trip'],
    ['Taxi to airport', 42, isoDate(-40), travel, ''],
    ['Supermarket', 96.4, isoDate(-41), food, 'monthly shop'],
    ['Train ticket', 12.75, isoDate(-200), travel, 'last year'],
  ];
  for (const [title, amount, date, category_id, notes] of rows) {
    await app.api
      .post('/api/transactions')
      .send({ title, amount, currency: 'USD', date, category_id, notes })
      .expect(201);
  }
  return { app, food, travel };
}

const titles = (res: { body: { items: { title: string }[] } }): string[] =>
  res.body.items.map((item) => item.title);

describe('search and filters', () => {
  it('searches title and notes', async () => {
    const { app } = await seed();
    const byTitle = await app.api.get('/api/transactions?q=lisbon').expect(200);
    expect(titles(byTitle)).toEqual(['Flight to Lisbon']);

    const byNotes = await app.api.get('/api/transactions?q=conference').expect(200);
    expect(titles(byNotes)).toEqual(['Flight to Lisbon']);

    const noMatch = await app.api.get('/api/transactions?q=zzzz');
    expect(noMatch.body.items).toEqual([]);
    expect(noMatch.body.total).toBe(0);
    app.close();
  });

  it('escapes LIKE wildcards so a bare % does not match everything', async () => {
    const { app } = await seed();
    await app.api
      .post('/api/transactions')
      .send({ title: '100% off', amount: 1, currency: 'USD', date: dayInCurrentMonth(3), category_id: 1 })
      .expect(201);
    const res = await app.api.get('/api/transactions?q=%25').expect(200);
    expect(titles(res)).toEqual(['100% off']);
    app.close();
  });

  it('filters by one or more categories', async () => {
    const { app, food, travel } = await seed();
    const foodOnly = await app.api.get(`/api/transactions?category_ids=${food}`).expect(200);
    expect(titles(foodOnly).sort()).toEqual(['Coffee beans', 'Supermarket']);

    const both = await app.api.get(`/api/transactions?category_ids=${food},${travel}`).expect(200);
    expect(both.body.total).toBe(5);

    const byCategoryTotals = await app.api.get(`/api/transactions?category_ids=${travel}`).expect(200);
    expect(byCategoryTotals.body.by_category).toEqual([{ category_id: travel, total: 294.75 }]);
    app.close();
  });

  it('filters by an explicit date range and by month boundaries', async () => {
    const { app } = await seed();
    const from = isoDate(-45);
    const to = isoDate(-30);
    const ranged = await app.api.get(`/api/transactions?from=${from}&to=${to}`).expect(200);
    expect(titles(ranged).sort()).toEqual(['Supermarket', 'Taxi to airport']);

    const stamp = dayInCurrentMonth(1);
    const year = stamp.slice(0, 4);
    const month = stamp.slice(5, 7);
    const thisMonth = await app.api.get(`/api/transactions?from=${year}-${month}-01&to=${year}-${month}-31`).expect(200);
    expect(titles(thisMonth).sort()).toEqual(['Coffee beans', 'Flight to Lisbon']);
    app.close();
  });

  it('filters by an amount range', async () => {
    const { app } = await seed();
    const res = await app.api.get('/api/transactions?min=20&max=100').expect(200);
    expect(titles(res).sort()).toEqual(['Supermarket', 'Taxi to airport']);

    const minOnly = await app.api.get('/api/transactions?min=200').expect(200);
    expect(titles(minOnly)).toEqual(['Flight to Lisbon']);
    app.close();
  });

  it('combines search, category, date and amount filters', async () => {
    const { app, travel } = await seed();
    const res = await app.api
      .get(`/api/transactions?q=to&category_ids=${travel}&min=40&max=100&from=${isoDate(-60)}&to=${isoDate(-1)}`)
      .expect(200);
    expect(titles(res)).toEqual(['Taxi to airport']);
    expect(res.body.total_amount).toBe(42);
    app.close();
  });

  it('sorts and paginates', async () => {
    const { app } = await seed();
    const desc = await app.api.get('/api/transactions?sort=amount_desc').expect(200);
    expect(titles(desc)[0]).toBe('Flight to Lisbon');

    const page1 = await app.api.get('/api/transactions?sort=amount_asc&limit=2').expect(200);
    const page2 = await app.api.get('/api/transactions?sort=amount_asc&limit=2&offset=2').expect(200);
    expect(titles(page1)).toEqual(['Train ticket', 'Coffee beans']);
    expect(titles(page2)).toEqual(['Taxi to airport', 'Supermarket']);
    // total is the full match count, not the page size.
    expect(page2.body.total).toBe(5);
    app.close();
  });

  it('rejects a malformed filter value', async () => {
    const { app } = await seed();
    const badSort = await app.api.get('/api/transactions?sort=sideways');
    expect(badSort.status).toBe(400);
    const badCategory = await app.api.get('/api/transactions?category_ids=abc');
    expect(badCategory.status).toBe(400);
    const badMin = await app.api.get('/api/transactions?min=abc');
    expect(badMin.status).toBe(400);
    app.close();
  });
});
