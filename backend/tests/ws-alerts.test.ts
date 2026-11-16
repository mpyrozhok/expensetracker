import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  currentPeriod,
  dayInCurrentMonth,
  liveApp,
  sleep,
  TestSocket,
  type LiveApp,
  type TestApp,
} from './helpers.js';
import type { ApiAlert, ServerMessage } from '../src/types.js';

type AlertsFrame = Extract<ServerMessage, { type: 'budget-alerts' }>;

async function setupLive(): Promise<LiveApp & { categoryId: number; socket: TestSocket }> {
  const app = await liveApp();
  await app.api.login('ada');
  const category = await app.api.post('/api/categories').send({ name: 'Living' }).expect(201);
  const socket = new TestSocket(app.wsUrl, app.api.token());
  await socket.opened();
  await socket.waitForType('welcome');
  return Object.assign(app, { categoryId: category.body.item.id as number, socket });
}

async function spend(app: TestApp, categoryId: number, amount: number, date: string): Promise<void> {
  await app.api
    .post('/api/transactions')
    .send({ title: `Spend ${amount}`, amount, currency: 'USD', date, category_id: categoryId, notes: '' })
    .expect(201);
}

function newThresholds(frame: AlertsFrame): ApiAlert[] {
  return frame.alerts.filter((alert) => alert.new);
}

describe('budget alerts over WebSocket', () => {
  it('pushes 50%, 80% and 100% alerts as the month progresses', async () => {
    const ctx = await setupLive();
    const period = currentPeriod();
    ctx.socket.subscribe(period);
    await ctx.socket.waitForType('subscription');

    // Budget set for the current month: still nothing to alert about.
    await ctx.api.put('/api/budgets').send({ ...period, amount: 100 }).expect(200);

    await spend(ctx, ctx.categoryId, 50, dayInCurrentMonth(2));
    const at50 = await ctx.socket.waitFor((m) => m.type === 'budget-alerts' && newThresholds(m as AlertsFrame).length > 0);
    expect(newThresholds(at50 as AlertsFrame).map((a) => a.threshold)).toEqual([50]);
    expect(newThresholds(at50 as AlertsFrame)[0]).toMatchObject({
      budget: 100,
      spent: 50,
      usage_percent: 50,
      currency: 'USD',
      period,
    });

    await spend(ctx, ctx.categoryId, 30, dayInCurrentMonth(3));
    const at80 = await ctx.socket.waitFor(
      (m) => m.type === 'budget-alerts' && newThresholds(m as AlertsFrame).some((a) => a.threshold === 80),
    );
    expect(newThresholds(at80 as AlertsFrame).map((a) => a.threshold)).toEqual([80]);

    await spend(ctx, ctx.categoryId, 20, dayInCurrentMonth(4));
    const at100 = await ctx.socket.waitFor(
      (m) => m.type === 'budget-alerts' && newThresholds(m as AlertsFrame).some((a) => a.threshold === 100),
    );
    const alert = newThresholds(at100 as AlertsFrame)[0];
    expect(alert).toMatchObject({ threshold: 100, usage_percent: 100, budget: 100, spent: 100 });
    expect(ctx.socket.firedThresholds()).toEqual([50, 80, 100]);
    // A threshold is never repeated: each appeared in exactly one frame.
    expect(ctx.socket.firedThresholds()).toHaveLength(new Set(ctx.socket.firedThresholds()).size);

    ctx.socket.close();
    await ctx.closeLive();
  });

  it('never re-fires a threshold for the same month, even after edits or reconnects', async () => {
    const ctx = await setupLive();
    const period = currentPeriod();
    ctx.socket.subscribe(period);
    await ctx.api.put('/api/budgets').send({ ...period, amount: 100 }).expect(200);

    // One large transaction crosses all three thresholds at once.
    await spend(ctx, ctx.categoryId, 150, dayInCurrentMonth(5));
    const frame = await ctx.socket.waitFor(
      (m) => m.type === 'budget-alerts' && (m as AlertsFrame).alerts.length > 0,
    );
    expect(newThresholds(frame as AlertsFrame).map((a) => a.threshold)).toEqual([50, 80, 100]);

    // More spending, an edit and a delete must stay silent: the month already fired.
    await spend(ctx, ctx.categoryId, 40, dayInCurrentMonth(6));
    const list = await ctx.api.get('/api/transactions').expect(200);
    const firstId = (list.body.items[0] as { id: number }).id;
    await ctx.api.put(`/api/transactions/${firstId}`).send({ amount: 999 }).expect(200);
    await ctx.api.del(`/api/transactions/${firstId}`).expect(204);
    await sleep(250);
    expect(ctx.socket.firedThresholds()).toEqual([50, 80, 100]);

    // A second connection in the same month replays state without re-alerting.
    const second = new TestSocket(ctx.wsUrl, ctx.api.token());
    await second.opened();
    await second.waitForType('welcome');
    second.subscribe(period);
    const replay = await second.waitForType('budget-alerts');
    const replayed = replay as AlertsFrame;
    expect(replayed.alerts.map((a) => a.threshold)).toEqual([50, 80, 100]);
    expect(replayed.alerts.every((a) => !a.new)).toBe(true);

    ctx.socket.close();
    second.close();
    await ctx.closeLive();
  });

  it('announces a threshold crossed while nobody was listening on the next subscribe, once', async () => {
    const ctx = await setupLive();
    const period = currentPeriod();
    // No socket is subscribed yet, so nothing is delivered and nothing is
    // written to the ledger: an alert is never silently consumed.
    await ctx.api.put('/api/budgets').send({ ...period, amount: 100 }).expect(200);
    await spend(ctx, ctx.categoryId, 55, dayInCurrentMonth(7));
    await sleep(100);
    expect(ctx.socket.alerts()).toHaveLength(0);

    const socket = new TestSocket(ctx.wsUrl, ctx.api.token());
    await socket.opened();
    await socket.waitForType('welcome');
    socket.subscribe(period);
    const frame = (await socket.waitForType('budget-alerts')) as AlertsFrame;
    expect(frame.alerts.map((a) => a.threshold)).toEqual([50]);
    expect(frame.alerts[0]?.new).toBe(true);

    // A third connection in the same month replays the ledger without re-alerting.
    const later = new TestSocket(ctx.wsUrl, ctx.api.token());
    await later.opened();
    await later.waitForType('welcome');
    later.subscribe(period);
    const replay = (await later.waitForType('budget-alerts')) as AlertsFrame;
    expect(replay.alerts.map((a) => a.threshold)).toEqual([50]);
    expect(replay.alerts[0]?.new).toBe(false);

    socket.close();
    later.close();
    ctx.socket.close();
    await ctx.closeLive();
  });

  it('stays silent while the month has no budget, then evaluates once one is set', async () => {
    const ctx = await setupLive();
    const period = currentPeriod();
    ctx.socket.subscribe(period);
    const empty = (await ctx.socket.waitForType('budget-alerts')) as AlertsFrame;
    expect(empty.alerts).toEqual([]);

    // Spend far past any threshold: with no budget there is nothing to compare.
    await spend(ctx, ctx.categoryId, 999, dayInCurrentMonth(8));
    await sleep(250);
    expect(ctx.socket.alerts()).toHaveLength(1);

    // Setting the budget starts evaluation, and the month is already over the
    // top: all three thresholds become known at once, each announced once.
    await ctx.api.put('/api/budgets').send({ ...period, amount: 100 }).expect(200);
    const frame = await ctx.socket.waitFor(
      (m) => m.type === 'budget-alerts' && newThresholds(m as AlertsFrame).length > 0,
    );
    expect(newThresholds(frame as AlertsFrame).map((a) => a.threshold)).toEqual([50, 80, 100]);

    // Further spending must not repeat any of them.
    await spend(ctx, ctx.categoryId, 5, dayInCurrentMonth(9));
    await sleep(250);
    expect(ctx.socket.firedThresholds()).toEqual([50, 80, 100]);

    ctx.socket.close();
    await ctx.closeLive();
  });

  it('only delivers to sockets that subscribed: client to server message drives server behaviour', async () => {
    const ctx = await setupLive();
    const period = currentPeriod();

    // A connected but unsubscribed socket gets no alert frames at all.
    const other = new TestSocket(ctx.wsUrl, ctx.api.token());
    await other.opened();
    await other.waitForType('welcome');

    await ctx.api.put('/api/budgets').send({ ...period, amount: 100 }).expect(200);
    await spend(ctx, ctx.categoryId, 50, dayInCurrentMonth(10));
    await sleep(250);
    expect(other.alerts()).toHaveLength(0);
    expect(ctx.socket.alerts()).toHaveLength(0);

    // The subscribe message arms delivery for that period.
    ctx.socket.subscribe(period);
    await ctx.socket.waitForType('subscription');
    const replay = (await ctx.socket.waitForType('budget-alerts')) as AlertsFrame;
    expect(replay.alerts.map((a) => a.threshold)).toEqual([50]);
    expect(other.alerts()).toHaveLength(0);

    // Unsubscribing stops delivery again, server-side.
    ctx.socket.send({ type: 'unsubscribe', channel: 'budget_alerts' });
    await ctx.socket.waitForType('unsubscribed');
    await spend(ctx, ctx.categoryId, 60, dayInCurrentMonth(11));
    await sleep(250);
    expect(ctx.socket.alerts()).toHaveLength(1);

    ctx.socket.close();
    other.close();
    await ctx.closeLive();
  });

  it('confirms an ack and reports the alert as read', async () => {
    const ctx = await setupLive();
    const period = currentPeriod();
    ctx.socket.subscribe(period);
    await ctx.api.put('/api/budgets').send({ ...period, amount: 100 }).expect(200);
    await spend(ctx, ctx.categoryId, 50, dayInCurrentMonth(12));
    const frame = await ctx.socket.waitFor(
      (m) => m.type === 'budget-alerts' && newThresholds(m as AlertsFrame).length > 0,
    );
    const alert = newThresholds(frame as AlertsFrame)[0];
    expect(alert?.read).toBe(false);

    ctx.socket.send({ type: 'ack', channel: 'budget_alerts', period, threshold: alert?.threshold ?? 0 });
    const readAck = await ctx.socket.waitForType('alert-read');
    expect(readAck).toMatchObject({ channel: 'budget_alerts', period, threshold: 50 });

    // Re-subscribing replays the ledger with the read flag the ack just set.
    const mark = ctx.socket.messages.length;
    ctx.socket.send({ type: 'unsubscribe', channel: 'budget_alerts' });
    ctx.socket.subscribe(period);
    const replay = (await ctx.socket.waitForType('budget-alerts', 4000, mark)) as AlertsFrame;
    expect(replay.alerts.find((a) => a.threshold === 50)?.read).toBe(true);

    ctx.socket.close();
    await ctx.closeLive();
  });

  it('rejects unauthenticated sockets before any application frame', async () => {
    const ctx = await liveApp();
    const anonymous = new WebSocket(ctx.wsUrl);
    // The upgrade must be refused: the harness answers 4401, so the client can
    // only ever see an error or a closed socket - never "open".
    const outcome = await Promise.race([
      new Promise<string>((resolve) => anonymous.once('error', () => resolve('error'))),
      new Promise<string>((resolve) => anonymous.once('close', () => resolve('closed'))),
      new Promise<string>((resolve) => anonymous.once('open', () => resolve('open'))),
    ]);
    expect(outcome).not.toBe('open');
    anonymous.terminate();
    await ctx.closeLive();
  });

  it('refuses a socket whose session was revoked by a logout', async () => {
    const ctx = await liveApp();
    await ctx.api.login('ada');
    const stolen = ctx.api.token();

    // Proof the credential works to begin with: it opens a socket.
    const before = new TestSocket(ctx.wsUrl, stolen);
    await before.opened();
    await before.waitForType('welcome');
    before.close();

    await ctx.api.post('/api/auth/logout').expect(200);

    // Same credential, same secret, same signature - but a retired session
    // generation, so the upgrade is refused exactly as an anonymous one would be.
    const after = new TestSocket(ctx.wsUrl, stolen);
    const outcome = await Promise.race([
      new Promise<string>((resolve) => after.socket.once('error', () => resolve('error'))),
      new Promise<string>((resolve) => after.socket.once('close', () => resolve('closed'))),
      new Promise<string>((resolve) => after.socket.once('open', () => resolve('open'))),
    ]);
    expect(outcome).not.toBe('open');
    after.socket.terminate();
    await ctx.closeLive();
  });

  it('answers ping and refuses malformed messages without dropping the socket', async () => {
    const ctx = await setupLive();
    ctx.socket.send({ type: 'ping' });
    await ctx.socket.waitForType('pong');

    ctx.socket.socket.send('not json at all');
    const err = await ctx.socket.waitForType('error');
    expect(err).toMatchObject({ code: 'invalid_json' });

    ctx.socket.send({ type: 'subscribe', channel: 'nope', period: currentPeriod() });
    const channelErr = await ctx.socket.waitFor((m) => m.type === 'error' && (m as { code?: string }).code === 'unknown_channel');
    expect(channelErr).toBeTruthy();

    ctx.socket.send({ type: 'nonsense' });
    const typeErr = await ctx.socket.waitFor((m) => m.type === 'error' && (m as { code?: string }).code === 'unknown_message_type');
    expect(typeErr).toBeTruthy();

    // Still alive after the bad frames.
    ctx.socket.close();
    await ctx.closeLive();
  });

  it('accepts the session cookie as well as a bearer token', async () => {
    const ctx = await setupLive();
    const period = currentPeriod();
    ctx.socket.subscribe(period);
    // Same user, cookie credential instead of the Authorization header.
    const cookieSocket = new TestSocket(ctx.wsUrl, undefined, `et_session=${ctx.api.token()}`);
    await cookieSocket.opened();
    await cookieSocket.waitForType('welcome');
    expect(cookieSocket.messages[0]).toMatchObject({ type: 'welcome' });
    cookieSocket.close();
    ctx.socket.close();
    await ctx.closeLive();
  });
});
