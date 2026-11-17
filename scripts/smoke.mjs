#!/usr/bin/env node
/**
 * End-to-end smoke check against a running server (no test doubles).
 *
 * It exercises the deployed artifact exactly as a browser would: cookie session
 * over REST, CSRF enforcement, per-user isolation, the documented category
 * deletion policy, and real budget alerts pushed over the WebSocket including
 * read-state replay after a reconnect.
 *
 * Usage:
 *   npm run dev            # or: npm run build && npm start
 *   node scripts/smoke.mjs [--url http://localhost:8787] [--keep]
 *
 * `--keep` leaves the created data in place; by default the check writes its own
 * throwaway identities so it can run repeatedly.
 */
import process from 'node:process';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const BASE = urlFlag === -1 ? 'http://localhost:8787' : args[urlFlag + 1];
const API = `${BASE}/api`;
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const CSRF = { 'X-Requested-With': 'expense-tracker', 'Content-Type': 'application/json' };

const results = [];
let cookie = null;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function assert(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  if (!condition) process.exitCode = 1;
}

async function call(method, path, body, options = {}) {
  const headers = { ...(options.rawHeaders ?? {}) };
  if (!options.noCsrf && method !== 'GET') Object.assign(headers, CSRF);
  if (cookie && !options.noCookie) headers.cookie = cookie;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, response };
}

function takeCookie(response) {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const session = cookies.find((entry) => entry.startsWith('et_session='));
  if (session) cookie = session.split(';')[0];
  return Boolean(session);
}

function now() {
  const date = new Date();
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

function isoDay(day) {
  const { year, month } = now();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Collects server frames so a test can wait for a specific one. */
class SocketProbe {
  constructor() {
    this.frames = [];
    this.socket = new WebSocket(WS_URL, { headers: { cookie: cookie ?? '' } });
    this.socket.on('message', (raw) => this.frames.push(JSON.parse(String(raw))));
  }

  opened() {
    return new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(match, label, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const at = this.frames.findIndex(match);
      if (at !== -1) return { frame: this.frames[at], index: at };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(this.frames.map((f) => f.type))}`);
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  /* ------------------------------------------------------------------ health */

  const health = await call('GET', '/health');
  assert('health endpoint responds', health.status === 200 && health.json?.ok === true, `status=${String(health.status)}`);

  const providers = await call('GET', '/auth/providers');
  assert(
    'providers listed with configuration state',
    Array.isArray(providers.json?.providers) && providers.json.providers.length === 2,
    providers.json?.providers?.map((p) => `${p.name}:${String(p.configured)}`).join(' '),
  );

  /* -------------------------------------------------------------------- auth */

  // Everything below signs in through the stub, so a server whose .env sets
  // ALLOW_MOCK_AUTH=0 is not broken, merely untestable this way. Without this the
  // stub's 404 cascades into nine failures and the script's advice at the end is
  // "is the server running?" — which sends you off to look at the wrong thing.
  if (providers.json?.mock_auth_enabled !== true) {
    console.error(
      `\nSSO stub is off on ${BASE} (mock_auth_enabled=false), and every check after the first two signs in through it.\n` +
        'Point it at a server with the stub enabled, e.g.:\n' +
        '  ALLOW_MOCK_AUTH=1 DATABASE_PATH=/tmp/smoke.db npm run dev\n' +
        'or use --url to aim at one that already has it on.',
    );
    process.exit(2);
  }

  const stamp = Date.now();
  const first = await call('POST', '/auth/mock/login', { provider: 'google', mock_user: `smoke-${stamp}` });
  assert('stub SSO signs in and sets a session cookie', first.status === 200 && takeCookie(first.response), `status=${String(first.status)}`);
  assert('first sign-in provisions the account', first.json?.created === true);

  const me = await call('GET', '/auth/me');
  assert('session survives on a later request', me.status === 200 && me.json?.user?.provider === 'google');

  const again = await call('POST', '/auth/mock/login', { provider: 'google', mock_user: `smoke-${stamp}` });
  assert('repeat sign-in reuses the same account', again.json?.created === false);

  const anonymous = await call('GET', '/auth/me', undefined, { noCookie: true });
  assert('unauthenticated requests are rejected', anonymous.status === 401, `status=${String(anonymous.status)}`);

  const noCsrf = await call('POST', '/categories', { name: 'CSRF probe' }, { noCsrf: true });
  assert('state-changing request without the CSRF header is refused', noCsrf.status === 403, `status=${String(noCsrf.status)}`);

  /* -------------------------------------------------------------- categories */

  const grocery = await call('POST', '/categories', { name: 'Groceries' });
  const dining = await call('POST', '/categories', { name: 'Dining' });
  const empty = await call('POST', '/categories', { name: 'Unused' });
  assert(
    'categories created',
    grocery.status === 201 && dining.status === 201 && empty.status === 201,
  );

  const duplicate = await call('POST', '/categories', { name: 'groceries' });
  assert('duplicate category name is refused case-insensitively', duplicate.status === 409, `status=${String(duplicate.status)}`);

  const blank = await call('POST', '/categories', { name: '   ' });
  assert('blank category name is rejected', blank.status === 400, `code=${String(blank.json?.error?.code)}`);

  /* ---------------------------------------------------------------- budgets */

  const period = now();
  const badBudget = await call('PUT', '/budgets', { ...period, amount: '-5', currency: 'USD' });
  assert('negative budget is rejected', badBudget.status === 400, `status=${String(badBudget.status)}`);

  const budget = await call('PUT', '/budgets', { ...period, amount: '100.00', currency: 'USD' });
  assert('monthly budget saved', budget.status === 200, `amount=${String(budget.json?.budget?.amount)}`);

  /* --------------------------------------------------------------- web socket */

  const probe = new SocketProbe();
  await probe.opened();
  probe.send({ type: 'subscribe', channel: 'budget_alerts', period });

  const welcome = await probe.waitFor((frame) => frame.type === 'welcome', 'welcome frame');
  assert('websocket accepts the session cookie', welcome.frame.type === 'welcome');

  const initial = await probe.waitFor((frame) => frame.type === 'budget-alerts', 'initial snapshot');
  assert('subscribe returns the current ledger', Array.isArray(initial.frame.alerts), `alerts=${String(initial.frame.alerts.length)}`);

  /* ------------------------------------------- transactions drive live alerts */

  async function spend(amount, title, day, categoryId) {
    const created = await call('POST', '/transactions', {
      title,
      amount,
      currency: 'USD',
      date: isoDay(day),
      category_id: categoryId,
      notes: '',
    });
    if (created.status !== 201) throw new Error(`transaction failed: ${String(created.status)} ${created.text}`);
    return created.json.item;
  }

  await spend('60.00', 'Halfway there', 3, grocery.json.item.id);
  const at50 = await probe.waitFor(
    (frame) => frame.type === 'budget-alerts' && frame.alerts.some((a) => a.threshold === 50),
    '50% threshold push',
  );
  const pushed = at50.frame.alerts.find((a) => a.threshold === 50);
  assert('crossing 50% pushes an alert over the open socket', pushed?.new === true, `usage=${String(pushed?.usage_percent)}%`);

  await spend('25.00', 'Getting close', 4, grocery.json.item.id);
  const at80 = await probe.waitFor(
    (frame) => frame.type === 'budget-alerts' && frame.alerts.some((a) => a.threshold === 80),
    '80% threshold push',
    6000,
  );
  assert('crossing 80% pushes the next threshold once', at80.frame.alerts.some((a) => a.threshold === 80));

  await spend('30.00', 'Over the line', 5, dining.json.item.id);
  const at100 = await probe.waitFor(
    (frame) => frame.type === 'budget-alerts' && frame.alerts.some((a) => a.threshold === 100),
    '100% threshold push',
    6000,
  );
  assert('exceeding the budget pushes the 100% alert', at100.frame.alerts.some((a) => a.threshold === 100));

  const summary = await call('GET', `/budgets/summary?year=${String(period.year)}&month=${String(period.month)}`);
  assert(
    'summary reflects spend, budget and remaining',
    summary.json?.spent === 115 && summary.json?.remaining === -15,
    `spent=${String(summary.json?.spent)} remaining=${String(summary.json?.remaining)} usage=${String(summary.json?.usage_percent)}%`,
  );

  /* -------------------------------------------------- read state and reconnect */

  probe.send({ type: 'ack', channel: 'budget_alerts', period, threshold: 50 });
  const acked = await probe.waitFor((frame) => frame.type === 'alert-read' && frame.threshold === 50, 'ack confirmation');
  assert('ack is confirmed by the server', acked.frame.threshold === 50);

  probe.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const reopened = new SocketProbe();
  await reopened.opened();
  reopened.send({ type: 'subscribe', channel: 'budget_alerts', period });
  const replay = await reopened.waitFor(
    (frame) => frame.type === 'budget-alerts' && frame.alerts.length >= 3,
    'replayed ledger with three thresholds',
  );
  const replayed = replay.frame.alerts;
  assert(
    'alerts are not re-fired as new after a reconnect',
    replayed.every((a) => a.new === false),
    `new flags=${replayed.map((a) => String(a.new)).join(',')}`,
  );
  assert(
    'acknowledged read state is replayed',
    replayed.find((a) => a.threshold === 50)?.read === true && replayed.find((a) => a.threshold === 100)?.read === false,
  );
  reopened.close();

  /* ------------------------------------------------- search, filters, paging */

  const filtered = await call('GET', `/transactions?q=close&sort=amount_desc&limit=1&offset=0`);
  assert(
    'search matches title and notes',
    filtered.status === 200 && filtered.json?.items?.length === 1 && filtered.json.items[0].title === 'Getting close',
    `total=${String(filtered.json?.total)}`,
  );

  const byCategory = await call('GET', `/transactions?category_ids=${String(grocery.json.item.id)}`);
  assert(
    'category filter restricts the result set',
    byCategory.json?.total === 2,
    `total=${String(byCategory.json?.total)}`,
  );

  const range = await call('GET', `/transactions?min=30&max=50`);
  assert('amount range filter applies both bounds', range.json?.total === 1, `total=${String(range.json?.total)}`);

  const page1 = await call('GET', '/transactions?sort=amount_desc&limit=2&offset=0');
  const page2 = await call('GET', '/transactions?sort=amount_desc&limit=2&offset=2');
  const distinct =
    page1.json?.items?.length === 2 && page2.json?.items?.length === 1 && page1.json.items[0].id !== page2.json.items[0].id;
  assert('limit/offset paging returns distinct pages', distinct, `p1=${String(page1.json?.total)} p2=${String(page2.json?.total)}`);

  const sorted = await call('GET', '/transactions?sort=amount_desc');
  const amounts = (sorted.json?.items ?? []).map((item) => item.amount);
  assert('sorting orders by amount descending', amounts.every((value, i) => i === 0 || amounts[i - 1] >= value), amounts.join(','));

  const outsideMonth = await call('GET', '/transactions?from=2000-01-01&to=2000-12-31');
  assert('date range excludes unrelated dates', outsideMonth.json?.total === 0, `total=${String(outsideMonth.json?.total)}`);

  const invalidSort = await call('GET', '/transactions?sort=nope; drop table transactions');
  assert('unknown sort key is rejected rather than interpolated', invalidSort.status === 400, `status=${String(invalidSort.status)}`);

  /* ------------------------------------------------ deletion policy and edits */

  const inUse = await call('DELETE', `/categories/${String(grocery.json.item.id)}`);
  assert(
    'deleting an in-use category is blocked with the count',
    inUse.status === 409 && inUse.json?.error?.code === 'category_in_use',
    `status=${String(inUse.status)} message=${String(inUse.json?.error?.message)}`,
  );

  const unused = await call('DELETE', `/categories/${String(empty.json.item.id)}`);
  assert('an unused category deletes cleanly', unused.status === 204, `status=${String(unused.status)}`);

  const target = await spend('10.00', 'Correction target', 6, dining.json.item.id);
  const updated = await call('PUT', `/transactions/${String(target.id)}`, { amount: '12.34' });
  assert('transaction update changes only the given field', updated.json?.item?.amount === 12.34 && updated.json?.item?.title === 'Correction target');

  const removed = await call('DELETE', `/transactions/${String(target.id)}`);
  assert('transaction delete returns 204', removed.status === 204);

  const afterDelete = await call('GET', `/budgets/summary?year=${String(period.year)}&month=${String(period.month)}`);
  assert('budget usage recalculates after a delete', afterDelete.json?.spent === 115, `spent=${String(afterDelete.json?.spent)}`);

  /* ------------------------------------------------------------ user isolation */

  const otherCookie = cookie;
  const other = await call('POST', '/auth/mock/login', { provider: 'github', mock_user: `smoke-other-${stamp}` });
  takeCookie(other.response);
  const theirTransactions = await call('GET', '/transactions');
  const theirCategories = await call('GET', '/categories');
  const theirBudget = await call('GET', `/budgets/summary?year=${String(period.year)}&month=${String(period.month)}`);
  assert(
    'a second user sees none of the first user data',
    theirTransactions.json?.total === 0 && theirCategories.json?.items?.length === 0 && theirBudget.json?.budget === null,
    `tx=${String(theirTransactions.json?.total)} cats=${String(theirCategories.json?.items?.length)}`,
  );

  const foreignId = grocery.json.item.id;
  const crossRead = await call('GET', `/transactions/${String(target.id)}`);
  const crossDelete = await call('DELETE', `/categories/${String(foreignId)}`);
  assert(
    'another user record is not reachable by id',
    crossRead.status === 404 && (crossDelete.status === 404 || crossDelete.status === 403),
    `read=${String(crossRead.status)} delete=${String(crossDelete.status)}`,
  );

  cookie = otherCookie;
  const ownAgain = await call('GET', '/transactions');
  // 60 + 25 + 30 remain: the 10.00 correction row created earlier was deleted.
  assert('the original session is unchanged', ownAgain.status === 200 && ownAgain.json?.total === 3, `total=${String(ownAgain.json?.total)}`);

  /* ------------------------------------------------------------------ logout */

  const logout = await call('POST', '/auth/logout');
  assert('logout clears the session', logout.status === 200);
  const afterLogout = await call('GET', '/auth/me');
  assert(
    'a replayed cookie stops authenticating after logout',
    afterLogout.status === 401,
    `status=${String(afterLogout.status)} — the token itself must be revoked, not just the cookie`,
  );

  const replayWrite = await call('POST', '/categories', { name: 'After logout' });
  assert('a replayed cookie cannot write either', replayWrite.status === 401, `status=${String(replayWrite.status)}`);

  const relogin = await call('POST', '/auth/mock/login', { provider: 'google', mock_user: `smoke-${stamp}` });
  assert(
    'signing in again issues a working token',
    relogin.status === 200 && takeCookie(relogin.response),
    `status=${String(relogin.status)}`,
  );
  const afterRelogin = await call('GET', '/auth/me');
  assert('the new session reads the same account back', afterRelogin.status === 200 && afterRelogin.json?.user?.id === me.json?.user?.id);

  /* ---------------------------------------------------------------- summary */

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
  if (failed.length > 0) {
    console.log('failed:');
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail === '' ? '' : ` (${entry.detail})`}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nsmoke run aborted: ${String(error instanceof Error ? error.message : error)}`);
  console.error('Is the server running? Start it with: npm run dev');
  const failed = results.filter((entry) => !entry.ok);
  if (failed.length > 0) console.error(`${String(failed.length)} earlier check(s) already failed`);
  process.exitCode = 1;
});
