import { describe, expect, it } from 'vitest';
import { testEnv, type TestApp } from './helpers.js';

async function categoryId(app: TestApp): Promise<number> {
  const res = await app.api.post('/api/categories').send({ name: 'Food' }).expect(201);
  return res.body.item.id as number;
}

/**
 * The JSON body limit and the two ways a body can fail to be usable: it is too
 * big, or it is not JSON. They deserve distinct answers, because a client that
 * sent valid JSON that was merely large needs to send less, not to start
 * generating JSON differently.
 */
describe('request body limits', () => {
  it('answers 413 when a valid JSON body is over the limit', async () => {
    const app = testEnv();
    await app.api.login('ada');
    const category = await categoryId(app);

    // Comfortably past the 100kb express.json limit, and structurally valid.
    const res = await app.api.post('/api/transactions').send({
      title: 'x'.repeat(1024 * 1024),
      amount: '5.00',
      category_id: category,
      date: '2026-01-05',
    });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
    expect(res.body.error.message).toMatch(/100/);
    app.close();
  });

  it('answers 400 when the body is not JSON at all', async () => {
    const app = testEnv();
    await app.api.login('ada');
    const res = await app.api
      .post('/api/categories')
      .set('content-type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
    app.close();
  });

  it('accepts a body well inside the limit', async () => {
    const app = testEnv();
    await app.api.login('ada');
    const category = await categoryId(app);
    const res = await app.api.post('/api/transactions').send({
      title: 'Normal size',
      amount: '5.00',
      notes: 'n'.repeat(2000),
      category_id: category,
      date: '2026-01-05',
    });
    // Notes are capped at 2000 characters by field validation, and 2000 of them
    // is a legal request — so the size limit must not be what rejects it.
    expect(res.status).toBe(201);
    app.close();
  });
});
