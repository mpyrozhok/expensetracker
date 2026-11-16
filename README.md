# Personal Expense Tracker

A full-stack MVP for tracking personal spending against a monthly budget:
SSO-only accounts (Google + GitHub), categories, transactions with
search/filter/sort/paging, monthly budgets, and budget-threshold alerts pushed
over a WebSocket.

Everything runs locally with one command and no cloud account. Real SSO needs
Google/GitHub credentials; an evaluation without them can use the built-in SSO
stub, which drives the same code path.

| | |
|---|---|
| Stack | TypeScript, Node >= 20, Express 4, SQLite (`better-sqlite3`), `ws`, React 18, Vite 5, plain CSS |
| Tests | `npm test` → **207 tests** (80 backend, 127 frontend), `npm run smoke` → **42 live checks** |
| Network in tests | none — SSO providers, tokens and userinfo are stubbed by injected `fetch` |
| Containers | `docker/Dockerfile` + `docker/docker-compose.yml`; the image builds and the 42 smoke checks pass against the running container ([Docker](#docker)) |

---

## 1. Run it locally

```bash
npm ci
npm run dev          # API on :8787, UI on :5173 with the API proxied through it
```

Open <http://localhost:5173>.

### Which port do I open?

`PORT` (8787) is always the Express **API origin**. What differs between the two
run modes is who serves the UI:

| Running | UI served by | Open |
|---|---|---|
| `npm run dev` | Vite dev server on `:5173`, proxying `/api` and `/ws` to `:8787` | <http://localhost:5173> |
| `npm run build` + `npm start` with `STATIC_DIR`, or the Docker image | the same Express process as the API | <http://localhost:8787> |

So `:8787` answers page requests in the built mode and returns a JSON `404`
for them in dev mode (Vite owns the pages then) — which is why the OAuth
redirect URIs below always point at `:8787`: the callback is handled by the
backend in both modes. `FRONTEND_ORIGIN` is the one that changes: `:5173` in
dev, `:8787` for the single-process build.

`ALLOW_MOCK_AUTH` defaults to on outside production, so the sign-in screen shows
a **"Stub identity"** form under the two provider buttons: type a name, press
**Stub as Google** or **Stub as GitHub**, and you are signed in. That path
provisions the local user record and issues the same session cookie a real
callback does — only the Google/GitHub HTTP calls are replaced. With no provider credentials configured, the "Continue
with Google/GitHub" buttons answer `501 oauth_not_configured` and the screen says
so instead of failing silently.

To run against real Google/GitHub, fill in `backend/.env` (see
[SSO setup](#4-sso-setup-google--github)) and restart.

### Commands

| Command | Does |
|---|---|
| `npm run dev` | Both dev servers with reload (`concurrently`); Vite proxies `/api` and `/ws` to `:8787` |
| `npm run dev:backend` / `npm run dev:frontend` | One side only |
| `npm run build` | `tsc` for the backend, `tsc && vite build` for the frontend |
| `npm start` | Run the built backend, which also serves `frontend/dist` when `STATIC_DIR` is set |
| `npm test` | Backend then frontend suites |
| `npm run test:all` | Both projects in one Vitest run (root `vitest.workspace.ts`) |
| `npm run test:backend` / `npm run test:frontend` | One workspace |
| `npm run smoke` | 42 end-to-end checks against a **running** server (REST + WebSocket) |
| `npm run typecheck` | `tsc --noEmit` over both workspaces |

Production-shaped single-process run (one origin for API, WS and SPA):

```bash
npm run build
NODE_ENV=production SESSION_SECRET=$(openssl rand -hex 32) \
  STATIC_DIR=$PWD/frontend/dist FRONTEND_ORIGIN=http://localhost:8787 npm start
# then: npm run smoke   (against http://localhost:8787)
```

The database is created on first boot at `DATABASE_PATH` (default
`./data/app.db`) and is plain SQLite, so you can inspect it with `sqlite3`.

---

## 2. Why this stack

* **SQLite via `better-sqlite3`** — synchronous, transactional, zero services to
  start, and the whole app state is one file that survives a restart. The
  per-user data volume of a personal expense tracker fits in it with room to
  spare; indexes cover the two hot paths (`user_id, date` and
  `user_id, category_id`).
* **Signed cookie sessions instead of a session store or JWT library** — the
  token is `base64url(json).hmac`, so there is no table to write on every login
  and nothing to migrate, while `HttpOnly` + `SameSite=Lax` keeps it out of JS.
  A `session_epoch` counter on the user row makes logout revoke issued tokens
  (see [Sessions](#3-sessions-and-logout)).
* **React + Vite with hand-written CSS** — the UI brief wants a specific,
  consistent look; design tokens in one stylesheet are lighter than a component
  library and leave every state (empty, loading, error, hover, focus) explicit.
* **npm workspaces monorepo** — the API types in `backend/src/types.ts` are the
  single source of truth; the frontend imports them as *type-only* imports, which
  Vite erases, so a wire-format change fails the frontend build instead of
  drifting.

---

## 3. Architecture

```
                 ┌────────────────────────── browser ──────────────────────────┐
                 │ React SPA (Vite, :5173 in dev, served by Express in prod)   │
                 │  REST + CSRF header ────────────► /api/*                     │
                 │  WebSocket /ws (cookie on upgrade) ──► BudgetHub            │
                 └─────────────────────────────────────────────────────────────┘
                                          │
   ┌──────────────────────────────────────▼──────────────────────────────────────┐
   │ Express app (backend/src/app.ts)                                            │
   │  security headers → loadUser → csrfGuard → router → SPA fallback → errors  │
   │  routes ─► services (users, categories, transactions, budgets, alerts)     │
   │  ws/hub.ts BudgetHub ─► AlertService ◄─ mutations notify the subscribed     │
   └──────────────────────────────────────┬──────────────────────────────────────┘
                                          ▼
                     SQLite (WAL): users, categories, transactions,
                                   budgets, budget_alert_fires
```

```
backend/src
  app.ts            middleware pipeline, security headers, SPA serving, errors
  config.ts         every setting from env, per-provider OAuth defaults
  db.ts             schema + additive column migrations
  session.ts        signed token mint/verify, cookie or Bearer extraction
  oauth.ts          authorization-code flow for Google + GitHub, injectable fetch
  middleware.ts     loadUser / requireUser / csrfGuard / cookie helpers
  redirect.ts       allow-listed redirects (no open redirect)
  routes.ts         REST surface, thin: validate → service → notify
  services/sql.ts   static SQL only; filters passed as sentinel parameters
  ws/hub.ts         BudgetHub: auth on upgrade, subscribe/ack, push, per-user fan-out
frontend/src
  App.tsx           boot → auth gate → workspace (tabs, month bar, modal, toasts)
  hooks/            useExpenseData (cancellation-safe loaders), useBudgetAlerts (WS)
  components/       Dashboard, Transactions, Categories, TransactionModal, AlertsPanel
  lib/              api client, formatting, client-side validation
scripts/smoke.mjs   live end-to-end checks against a running server
docker/             Dockerfile + docker-compose.yml
```

Every request handler resolves the caller through `requireUser(req)` and passes
`user.id` into the service call; services never accept a user id from a client.
That is the whole authorization story: there is no query in the codebase that can
return another user's row, which the test suite pins directly.

### Sessions and logout

* A session token asserts `{ uid, epoch, exp }`, HMAC-SHA256 signed with
  `SESSION_SECRET`, in the `et_session` cookie (`HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Secure` when `COOKIE_SECURE`). It survives refresh and restarts,
  which satisfies "authentication persists across page refresh".
* `POST /api/auth/logout` clears the cookie **and** increments
  `users.session_epoch`. Every later request compares the token's epoch with the
  row's, so a copied or replayed token is worth nothing after logout — clearing
  the cookie is not the security boundary. Signing in immediately afterwards
  mints a token in the new generation and works, because the rule is a counter
  equality test rather than a timestamp comparison.
* `Authorization: Bearer <token>` is accepted on the same routes, which is how
  the WebSocket tests and `scripts/smoke.mjs` drive the API.
* Revocation is per user (all devices), not per device — noted in
  [Limitations](#9-limitations-and-what-i-would-do-next).

### Other security choices

* **CSRF**: every non-`GET` call under `/api` must carry
  `X-Requested-With: expense-tracker`; a cross-site form cannot set it, and the
  cookie is `SameSite=Lax` on top of that. The SPA client always sends it.
* **Open redirect**: post-SSO redirects go through `redirectAllowlisted`, which
  only accepts the configured `FRONTEND_ORIGIN` or a same-origin relative path,
  and raises `redirect_refused` otherwise.
* **SQL injection**: every statement in `services/sql.ts` is a static string;
  filters are sentinel parameters and sorting is a `CASE` expression keyed by an
  allow-listed enum. An unknown `sort` value is a 400, never interpolated — the
  smoke check asserts exactly that.
* **OAuth state**: signed, provider-bound, nonce-carrying, and verified before
  the code is exchanged (`oauth_state_mismatch` on failure).
* **Headers**: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, and a CSP that keeps everything `'self'` plus
  `ws:`/`https:` image and socket sources.
* **Error shape**: `{"error":{"code","message","details?"}}` with real status
  codes (400 validation, 401 anonymous, 403 CSRF, 404 foreign or missing, 409
  policy conflict, 500 unexpected). Unknown paths under `/api` stay JSON even
  when the SPA is being served.

---

## 4. SSO setup (Google + GitHub)

Both providers use the authorization-code flow:
`GET /api/auth/:provider/login` → provider consent →
`GET /api/auth/:provider/callback` → local user upsert → session cookie →
redirect to `FRONTEND_ORIGIN/#signed-in`. Identity is keyed on
**(provider, provider_user_id)** because GitHub does not always expose an email.

Copy `backend/.env.example` to `backend/.env`; every variable below is read from
the environment.

### Google (OAuth 2.0 / OpenID Connect)

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials →
   OAuth client ID → Web application**.
2. Authorized JavaScript origin: `http://localhost:5173` (and
   `http://localhost:8787` if you run the single-process build).
3. Authorized redirect URI: `http://localhost:8787/api/auth/google/callback`.
4. Scopes `openid profile email`; the app reads `sub`, `email`, `name`,
   `picture` from the OIDC userinfo endpoint.

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=***
GOOGLE_REDIRECT_URI=http://localhost:8787/api/auth/google/callback
```

### GitHub (OAuth app)

1. <https://github.com/settings/developers> → **New OAuth App**.
2. Homepage URL: `http://localhost:5173`.
3. **Authorization callback URL**: `http://localhost:8787/api/auth/github/callback`.
4. Generate a client secret. Scopes `read:user user:email`; the app reads `id`,
   `login`, `name`, `avatar_url`, and falls back to the emails endpoint.

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=***
GITHUB_REDIRECT_URI=http://localhost:8787/api/auth/github/callback
```

### Core variables

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` requires `SESSION_SECRET` and refuses to boot without it |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | API origin; with `STATIC_DIR` set it also serves the SPA and `/ws` on this one port |
| `SESSION_SECRET` | insecure dev value | `openssl rand -hex 32`; required in production |
| `SESSION_TTL_SECONDS` | `2592000` | 30 days, so a refresh (and a restart) keeps you signed in |
| `DATABASE_PATH` | `./data/app.db` | created automatically; `:memory:` in tests |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | post-login redirect target and allow-list entry |
| `COOKIE_SECURE` | production only | set with https |
| `ALLOW_MOCK_AUTH` | on unless production | the SSO stub used by the UI form, the tests and the smoke script |
| `STATIC_DIR` | unset | when set, Express serves the built SPA too |

A provider whose id/secret pair is empty is reported as `configured: false` by
`GET /api/auth/providers` and its login route answers
`501 oauth_not_configured` with a message naming the variables to set — so a
half-configured provider is visible rather than mysterious.

`POST /api/auth/mock/login` (`{ "provider": "google", "mock_user": "ada" }`) is
the test-mode login: it returns 404 in production and, outside production, runs
the identical provisioning and session code. The required tests ("SSO login
success path in test mode using a mock provider response") use it plus a stubbed
`fetch` for the real callback route.

---

## 5. HTTP API

All routes are under `/api`. Bodies and responses are JSON. Reads are anonymous-
safe (401 when a session is required); writes need the CSRF header.

| Method + path | Purpose |
|---|---|
| `GET /api/health` | liveness: `{ok, env, time}` |
| `GET /api/auth/providers` | which providers are configured + whether the SSO stub is on |
| `GET /api/auth/me` | current user (401 when anonymous) |
| `GET /api/auth/:provider/login` | start the OAuth dance (302) |
| `GET /api/auth/:provider/callback` | code exchange, user upsert, set cookie, redirect; a provider refusal (Cancel, expired code) redirects with `?auth_error=<code>` and never becomes a session |
| `POST /api/auth/mock/login` | test-mode SSO (`ALLOW_MOCK_AUTH=1`) |
| `POST /api/auth/logout` | clear cookie **and** revoke the session generation |
| `GET /api/categories` | list with `transaction_count` and `in_use` per category |
| `POST /api/categories` | create (`{name}`, unique per user, case-insensitive) |
| `PUT /api/categories/:id` | rename |
| `DELETE /api/categories/:id` | delete — `409 category_in_use` while transactions use it |
| `GET /api/transactions` | search + filter + sort + page (below) |
| `POST /api/transactions` | create |
| `GET /api/transactions/:id` | one transaction (404 if not yours) |
| `PUT /api/transactions/:id` | edit any field (partial) |
| `DELETE /api/transactions/:id` | delete |
| `GET /api/budgets/summary?year&month` | spent, budget, remaining, usage %, count |
| `GET /api/budgets?year&month` | the budget for a month or `null` |
| `PUT /api/budgets` | set it (`{year, month, amount, currency}`) |
| `DELETE /api/budgets?year&month` | remove it |

`GET /api/transactions` accepts `q` (title and notes, case-insensitive),
`category_ids` (comma-separated), `from` / `to` (`YYYY-MM-DD`), `min` / `max`
(decimal amount), `sort` = `date_desc` (default) `| date_asc | amount_desc |
amount_asc`, `limit` (default 200, max 500) and `offset`. The response carries
the page plus aggregate context, so the footer and the category chips agree with
the filters rather than with the visible page:

```json
{ "items": [...], "total": 42, "total_amount": 1234.5,
  "by_category": [{ "category_id": 3, "name": "Groceries", "amount": 420.1, "count": 12 }] }
```

`GET /api/budgets/summary` returns `budget: null` and `usage_percent: null`
when no budget is set, which is what keeps the UI from inventing a percentage.

**Validation** (same rules on both sides): amount must parse with at most two
decimals, be greater than 0 and at most 100000000; title is required and at most
200 characters; date must be a real `YYYY-MM-DD` between 1900 and 2200; notes at
most 2000 characters; category name required, at most 60, unique per user
case-insensitively; currency must be `USD`. Amounts are stored as integer cents.

---

## 6. WebSocket and budget alerts

Endpoint `ws://localhost:8787/ws` (Vite proxies it in dev). The upgrade carries
the same credential as the API — the session cookie, or a Bearer header. A
refusal is a plain HTTP response rather than a half-written status line: `401`
(`X-WebSocket-Reject: 4401 unauthorized`) when the session is missing, bad, or
revoked, and `403` (`4403 origin_not_allowed`) when the request carries an
`Origin` from a host that is not this app's. The Origin rule is what stops a
page on another site from opening a socket into a signed-in visitor's alerts:
a browser always sends the header, ports are ignored so the dev frontend on
:5173 still reaches the API on :8787, and a non-browser client that sends no
`Origin` at all (the smoke script, a CLI) is allowed because it has no
cross-site model to enforce. A socket is bound to its user and only ever
receives that user's alerts.

### Client → server (all JSON)

| Message | Effect on the server |
|---|---|
| `{"type":"subscribe","channel":"budget_alerts","period":{"year":2026,"month":11}}` | arms the socket's period, evaluates it, and replays the ledger for it. **This is the message that changes what the server pushes**: without a subscription, nothing is ever sent to that socket, and a subscribe to a period arms evaluation for it |
| `{"type":"unsubscribe","channel":"budget_alerts"}` | stops pushing until the next subscribe |
| `{"type":"ack","channel":"budget_alerts","period":{...},"threshold":80}` | writes `read_at` on the ledger row (idempotent, and a no-op for a threshold that never fired), confirms with `alert-read`, and notifies the user's other tabs on that period |
| `{"type":"ping"}` | answered `pong` — keeps proxies from idling the socket |

### Server → client

`welcome` · `subscription` · `unsubscribed` · `budget-alerts` ·
`alert-read` · `pong` · `error{code,message}`

`budget-alerts` carries `ApiAlert[]`, where each alert has `period`, `threshold`,
`budget`, `spent`, `usage_percent`, `currency`, `fired_at`, and the two flags
that drive the UI: `new` (first crossing → toast) and `read` (acknowledged →
panel only). Malformed frames get an `error` frame (`invalid_json`,
`unknown_channel`, `unknown_message_type`, `alert_invalid`) and keep the socket.

### Alert rules

* Thresholds **50, 80 and 100** percent of the month's budget.
* Alerts are calculated for the **current calendar month only**. A mutation in
  another month updates the numbers but pushes nothing.
* A threshold fires **once per user + period + threshold**, ever. The ledger is
  the `budget_alert_fires` table with `UNIQUE(user_id, year, month, threshold)`
  filled by `INSERT OR IGNORE`, so it survives reconnects **and** restarts:
  editing or deleting transactions after a crossing cannot re-alert or spam.
* Alerts are generated when a client **subscribes** (which happens on connect and
  whenever the viewed month changes) and after a transaction is **created,
  updated or deleted** or a budget is set/removed.
* **No budget for the month → no alerts at all**, and the UI shows the explicit
  "No budget set" state instead of a percentage.
* Acknowledgement is durable too: `read_at` lives on the ledger row, so an alert
  you dismissed is still dismissed after a server restart.
* The client reconnects with capped exponential backoff and re-subscribes, so a
  dropped socket does not silently stop alerts; the panel shows the connection
  state.

In the UI, a `new` alert raises a toast and every alert appears in the alerts
panel with its threshold, spend and budget; dismissing sends the `ack`.

---

## 7. Category deletion: blocked, not reassigned

**Chosen approach: deletion is blocked while transactions still use the
category.**

```
DELETE /api/categories/:id
409 { "error": { "code": "category_in_use",
                 "message": "Cannot delete: 2 transactions still use this category. Move them first." } }
```

Why blocking over auto-reassign:

1. **No invented data.** Silent reassignment needs a catch-all category with
   meaning the user never chose, and it rewrites rows the user did not ask to
   touch. A budget report that suddenly contains rows under "Uncategorized" is a
   worse outcome than a refused delete.
2. **Reversible intent.** The user can reclassify deliberately (edit the
   transactions, or move them to another category) and then delete. The error
   names the count, so the work is bounded and visible.
3. **Referential honesty.** Categories are a grouping axis for reports; keeping
   every referenced id alive means a historical month never changes shape
   underneath the user.

The list endpoint returns `transaction_count` and `in_use` per category, so the
UI disables the Delete button *before* the user clicks it and explains why.
Renaming is always allowed and never touches transactions. A category in use
therefore can only be removed by reclassifying its transactions first, and the
API insists on a category at creation (`category_id` is validated on both sides,
with *"Choose a category"` inline and `400` server-side) — the nullable column
plus an *Uncategorized* label exists for rows that arrive from elsewhere, not as
a target the app deletes into. Deleting a **user** cascades to their categories,
transactions, budgets and alert ledger.

---

## 8. Tests

```bash
npm test          # 207 tests, no network, no browser
npm run smoke     # 42 checks against a running server
```

Backend (80) — Vitest + supertest against the real Express app and a real SQLite
database, with `fetch` injected so no provider call can leave the process:

| File | Covers |
|---|---|
| `auth.test.ts` | stubbed **Google and GitHub code exchange → user upsert → cookie**, identity keyed on provider+id, email lower-cased, second sign-in reuses the row, state mismatch rejected, **logout revokes a replayed token** and re-login works, pressing **Cancel at the provider** bounces to the sign-in screen with the reason (and state is still validated first) |
| `session.test.ts` | the signing primitive itself: round-trip, expiry, wrong secret, tampered and forged signatures, malformed input that must not throw, legacy tokens read as generation 0, and **epoch-based revocation** |
| `ws-alerts.test.ts` | **50/80/100 pushed over a real WebSocket**, once-per-month across reconnects, ledger replay with read flags, `ack` → `alert-read`, **a second window hears the ack**, anonymous sockets refused before any frame, **a socket revoked by logout refused**, **refused upgrades answered as readable 401/403** and a foreign `Origin` refused, malformed frames, ping/pong |
| `authorization.test.ts` | user B cannot read or write user A's categories, transactions or budgets; a foreign id is 404; anonymous is 401; CSRF required |
| `transactions.test.ts`, `search-filters.test.ts` | **create category + create transaction**, edit any field, delete, validation rejections, q/category/date-range/amount-range filters, sorting, paging, aggregates |
| `budgets.test.ts` | set/get/remove per month, summary math, no-budget → null usage |
| `alert-evaluation.test.ts` | exact 50/80/100 boundaries, no-budget silence, ledger once per month, independent months, **durable idempotent ack surviving a reopen** |
| `categories.test.ts` | create, rename, unique-per-user case-insensitive, **409 while in use**, delete when unused |
| `static-serving.test.ts` | production single-origin mode: SPA document, hashed assets, client-route fallback, `/api` errors still JSON |
| `schema-migration.test.ts` | opening a **release-one database file upgrades it in place** — adds `session_epoch` and `read_at`, keeps every row, idempotent on the next open, and a fresh database is untouched |

Frontend (127) — Vitest + Testing Library + `jsdom`, with `fetch` and
`WebSocket` replaced by recording fakes: pure logic (`format` — including the
copy shown when a provider refuses a sign-in, which is mapped from the URL rather
than echoed — and `validation`), `LoginScreen`, `Dashboard` (totals, no-budget
state, budget save/clear),
`Transactions` (table, empty states, filters, paging), `Categories` (create,
rename, in-use delete), `useBudgetAlerts` (subscribe, ack, reconnect with
backoff, cross-tab read), and an `App` integration suite that boots the whole
component tree through sign-in, a sign-in the provider refused, CRUD, budget save
and a live alert.

`scripts/smoke.mjs` is not a unit test: it drives a **running, built** server
exactly as a browser does — cookie session, CSRF header, category policy, budget
math, three threshold alerts over a real socket, ack, reconnect replay,
search/sort/paging, per-user isolation, and logout revocation.

---

## 9. UI

Light theme only, one stylesheet with design tokens (spacing scale, type scale,
radii, shadows).

* **Sign-in** — `Continue with Google`, `Continue with GitHub`, per-provider
  availability, and the `Stub identity` form (`Stub as Google` / `Stub as
  GitHub`) when `ALLOW_MOCK_AUTH` is on. A sign-in the provider refused — Cancel
  on the consent sheet, an account never chosen, an expired code — comes back as
  `?auth_error=<code>` on this page and is shown as a plain-language reason, once:
  the parameter is consumed so a reload does not raise it again.
* **Dashboard** — for the selected month: total spent, budget, remaining, usage
  percentage with a step progress bar, transaction count, over-budget styling,
  inline budget set/clear. With no budget: an explicit
  *"No budget for `<Month>` yet — set one below to enable 50% / 80% / 100%
  alerts"* state and no percentage.
* **Transactions** — table on desktop, cards under 720 px; search input, category
  chips with counts, date-range presets (this month / last month / custom),
  min/max amount, sort, pagination; create/edit in a modal with client-side
  validation and dirty-state protection; delete behind a confirm.
* **Categories** — inline rename, create, delete disabled with an explanation
  while in use.
* **Alerts** — toast for a newly crossed threshold, panel for the month's ledger,
  connection badge with reconnect.
* **States** — skeletons on the first load of each data block, inline errors with
  retry, and distinct empty states with their own copy: *No transactions in this
  month*, *No transactions match those filters*, *No categories yet*,
  *No budget for … yet*, *No alerts for this month*. Hover, `:focus`,
  `:focus-visible` and `:active` are styled (15 hover and 12 focus rules in the
  built sheet); the app is keyboard navigable and uses ARIA labels on icon-only
  buttons. The production bundle contains no inline `style` attributes — width
  steps, tones and progress bars are all classes.
* Currency is explicit and single: **USD**, labelled in the amount inputs and
  every figure. Amounts are integer cents server-side, so no float drift.

---

## Docker

Provided as an optional deliverable, **built and run on this machine**:

* `docker/Dockerfile` — multi-stage (build stage with the native-module
  toolchain, then a slim Node 22 runtime running as `node`), `HEALTHCHECK` on
  `/api/health`, SQLite on a `/data` volume, one origin for API + WS + SPA.
* `docker/docker-compose.yml` — one service, port mapping, named volume, env
  passthrough for the SSO credentials.

```bash
# build (see the --load note below) and run without compose
docker buildx build --load -f docker/Dockerfile -t expense-tracker:local .
docker run --rm -p 8787:8787 -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e ALLOW_MOCK_AUTH=1 -v expense-data:/data expense-tracker:local

# or via compose
cd docker && SESSION_SECRET=$(openssl rand -hex 32) docker compose up --build
```

### Verified with the container running

| Check | Result |
|---|---|
| `docker buildx build` | exit 0, image `expense-tracker:local` at 249 MB |
| `docker run` | starts as `node`, healthcheck reports `(healthy)` |
| `npm run smoke -- --url http://localhost:8791` | **42/42** against the container: session cookie, CSRF, category policy, budget math, 50/80/100 alerts over the WebSocket, ack, reconnect replay, search/sort/paging, per-user isolation, logout revocation |
| `GET /` on the container | 200 `text/html`, the SPA document, with `/api/*` still answering JSON |
| `ls /data` inside the container | `app.db`, `app.db-shm`, `app.db-wal` — WAL works on the mounted volume as the non-root user |
| `docker restart` | the row created before it, and the session issued before it, are both still there afterwards |

Building it found two real problems, both now fixed in the Dockerfile:

1. **`COPY tsconfig.json …` referenced a root tsconfig that does not exist** (each
   workspace carries its own), so the very first layer that needed sources failed.
   An unrun Dockerfile reads fine and breaks on the first build; this one had never
   been built.
2. **`docker build` silently produces no image on this machine.** The active buildx
   builder is driver `docker-container` (see `docker buildx ls`), which keeps the
   result in the builder and exports nothing to the image store unless asked:
   `docker build` returned 0 with every step `DONE` and `docker images` stayed
   empty. `docker buildx build --load` is what actually lands the image — hence the
   header comment in the Dockerfile.

> **Still unverified:** `docker compose` itself — neither the v2 plugin nor the v1
> standalone binary is installed here, so `docker compose up` and even
> `docker compose config` cannot run. What was verified instead is the exact thing
> the compose file describes: this image, the same environment
> (`SESSION_SECRET`, `ALLOW_MOCK_AUTH`, `FRONTEND_ORIGIN`, `DATABASE_PATH`), the
> same port mapping and a named volume at `/data`. The compose file's YAML was
> checked structurally, but treat the `compose up` path as untested until it runs
> where compose exists.

---

## 10. Limitations and what I would do next

* **Revocation is per user, not per device** — one epoch per account means
  logging out anywhere logs every session out. A `sessions` table with per-device
  rows would give device-level sign-out and an admin kill switch.
* **No PKCE** on the OAuth code flow (state + nonce + a server-side code exchange
  are there, but PKCE is what Google recommends for public clients) and no ID
  token signature validation — the userinfo endpoint is trusted over
  `id_token`. Both are the first things I would add before deploying anywhere.
* **USD only.** Amounts are cents and `currency` is stored per row, so enabling
  a second currency is a UI and validation change plus a per-month currency
  constraint on budgets.
* **No account linking** (explicitly optional in the brief): signing in with
  Google and GitHub creates two accounts.
* **SQLite is single-writer.** Fine for a personal app and for the test suite;
  a Postgres swap is contained in `services/sql.ts` and `db.ts`.
* **Alert thresholds are fixed** at 50/80/100 and pushes are live-only —
  a threshold crossed while every socket was closed is delivered on the next
  subscribe (the ledger is durable), but there is no email/push notification.
* **No rate limiting, no audit log, no CSP `report-to`**, and the CSP still allows
  inline styles because Vite injects them in dev.
* The WebSocket `Origin` rule compares **hostnames, ignoring ports**, so that the
  dev frontend on :5173 can reach the API on :8787. That is right for a local
  run and still refuses any other host; a real deployment would pin the exact
  origin including the port once the front door is one origin anyway.
* Pagination is `limit`/`offset`; at very large row counts a keyset cursor would
  be steadier.
* The frontend relies on the WS reconnect loop plus re-fetch on focus; a
  service worker and offline queue would make it resilient to a dead backend.
