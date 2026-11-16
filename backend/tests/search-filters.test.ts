import { describe, expect, it } from 'vitest';
import { ApiError, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, parseLimit, parseOffset } from '../src/validation.js';
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
    // The bound has to be a date that exists: `YYYY-MM-31` used to be accepted
    // and worked by accident, because dates compare as strings. Day 31 in a
    // 30-day month is now refused the same way it is for a transaction date.
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const thisMonth = await app.api
      .get(`/api/transactions?from=${year}-${month}-01&to=${year}-${month}-${String(lastDay).padStart(2, '0')}`)
      .expect(200);
    expect(titles(thisMonth).sort()).toEqual(['Coffee beans', 'Flight to Lisbon']);

    const sentinel = await app.api.get(`/api/transactions?to=${year}-${month}-31`);
    expect(sentinel.status).toBe(400);
    expect(sentinel.body.error.code).toBe('date_invalid');
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

describe('list query contract', () => {
  it('refuses a non-date from or to instead of guessing', async () => {
    const { app } = await seed();
    // Both used to be accepted: a bad `from` matched nothing (an empty list that
    // looks like a real answer) and a bad `to` was dropped (a full list that
    // looks like the filter worked). Neither is a truthful response.
    const badFrom = await app.api.get('/api/transactions?from=garbage');
    expect(badFrom.status).toBe(400);
    expect(badFrom.body.error.code).toBe('date_invalid');

    const badTo = await app.api.get('/api/transactions?to=not-a-date');
    expect(badTo.status).toBe(400);
    expect(badTo.body.error.code).toBe('date_invalid');

    const emptyBound = await app.api.get('/api/transactions?from=&to=');
    expect(emptyBound.status).toBe(200);
    expect(emptyBound.body.total).toBe(5);
    app.close();
  });

  it('still treats a reversed date range as a real question', async () => {
    const { app } = await seed();
    const res = await app.api.get(`/api/transactions?from=${isoDate(-1)}&to=${isoDate(-60)}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    app.close();
  });

  it('refuses nonsense pagination rather than coercing it', async () => {
    const { app } = await seed();
    // `offset=1e400` parses to Infinity, reached SQLite as a bind value, and
    // surfaced as a 500 from the query layer.
    const infinity = await app.api.get('/api/transactions?offset=1e400');
    expect(infinity.status).toBe(400);
    expect(infinity.body.error.code).toBe('offset_invalid');

    for (const q of ['limit=abc', 'limit=0', 'limit=-5', 'limit=12.5', 'offset=-1', 'offset=1.5']) {
      const res = await app.api.get(`/api/transactions?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code, q).toBe(q.startsWith('limit') ? 'limit_invalid' : 'offset_invalid');
    }

    const stillPaging = await app.api.get('/api/transactions?sort=amount_asc&limit=2&offset=2').expect(200);
    expect(titles(stillPaging)).toEqual(['Taxi to airport', 'Supermarket']);
    app.close();
  });
});

describe('pagination parser', () => {
  const codeOf = (run: () => unknown): string => {
    try {
      run();
      return 'did not throw';
    } catch (err) {
      return err instanceof ApiError ? err.code : `not an ApiError: ${String(err)}`;
    }
  };

  it('defaults and clamps above the cap', () => {
    expect(parseLimit(undefined)).toBe(PAGE_SIZE_DEFAULT);
    expect(parseLimit('')).toBe(PAGE_SIZE_DEFAULT);
    expect(parseLimit(' 20 ')).toBe(20);
    expect(parseLimit('500')).toBe(PAGE_SIZE_MAX);
    // A finite ask above the cap is a polite "as much as you will give me".
    expect(parseLimit('501')).toBe(PAGE_SIZE_MAX);
    expect(parseLimit('100000')).toBe(PAGE_SIZE_MAX);
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset('2')).toBe(2);
    expect(parseOffset('2.0')).toBe(2);
  });

  it('rejects what it cannot honestly page with', () => {
    expect(codeOf(() => parseLimit('0'))).toBe('limit_invalid');
    expect(codeOf(() => parseLimit('-5'))).toBe('limit_invalid');
    expect(codeOf(() => parseLimit('12.5'))).toBe('limit_invalid');
    expect(codeOf(() => parseLimit('abc'))).toBe('limit_invalid');
    // Non-finite is the case that used to reach SQLite as Infinity.
    expect(codeOf(() => parseLimit('1e400'))).toBe('limit_invalid');
    expect(codeOf(() => parseOffset('-1'))).toBe('offset_invalid');
    expect(codeOf(() => parseOffset('1e400'))).toBe('offset_invalid');
    expect(codeOf(() => parseOffset('abc'))).toBe('offset_invalid');
    expect(codeOf(() => parseOffset('1.5'))).toBe('offset_invalid');
  });
});
