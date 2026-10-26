# DIY Forests API

Backend for the DIY Forests training platform: a Node.js + TypeScript + Express modular monolith with a versioned REST API under `/api/v1`.

**Current (Revision 3 booking workflow):** the Stage 1 skeleton, the Stage 2 PostgreSQL catalog schema, migrations and development seed, the Stage 3 **read-only catalog API**, Stage 4A **customer and admin authentication**, Stage 4B **admin management**, and Stage 4C **bookings** (customer and admin booking APIs, seat counters, idempotent creation, cancellation). Authentication uses OIDC sign-in (Amazon Cognito, or a guarded local dev provider), server-side sessions in PostgreSQL, CSRF protection, rate limits, an operator CLI for admins, and an audit trail. On top of Stage 4C: the **payment simulator (development only)**: payment attempts, `CONFIRMED` bookings and a 30-minute payment hold with automatic expiry; and **Revision 3**: manual confirmation by staff (the default), a 24-hour booking cutoff, cancellation requests and refund *eligibility*. **No real payment provider, webhooks, refunds or email exist**; simulated payments are never money and never revenue. See "Authentication", "Bookings", "Payment simulator" and "Manual confirmation and cancellation requests" below.

> **Naming note.** "Stage 1"–"Stage 4C" are the original build stages (Stage 2 = the PostgreSQL catalog schema). The later payment-simulator work was planned as its own "Stage 2" of the booking roadmap, so in this README and in migration comments, **"Stage 2 payment simulator"** (migrations `20261026…`) means that later work, not the catalog-schema stage. **"Revision 3"** (migrations `20261027…`) is the manual-confirmation and cancellation-request workflow built on top of it.

> **Real PostgreSQL status for bookings: concurrency suite verified once, manually.** The booking migration, constraints, triggers and APIs are tested against PGlite (in-memory PostgreSQL with a single connection) on every `npm test`. Behaviour under truly concurrent connections is covered by `tests/db/bookings.postgres-concurrency.test.ts`, which runs only against a real, empty, disposable PostgreSQL database (see "Bookings" below). Recorded result (2026-10-22, local disposable `postgres:16-alpine` container, PostgreSQL 16.15, working tree on top of commit `3ca609b`): all six migrations applied to a fresh empty database, then **8 passed, 0 failed, 0 skipped**. Latest recorded result (2026-10-26, throwaway local `postgres:16-alpine` container, PostgreSQL 16.15, database `diyforests_test`, removed afterwards): all ten migrations applied, then **19 passed, 0 failed, 0 skipped**, including the payment-simulator and Revision 3 races. These are recorded past runs, not something `npm test` repeats; a plain `npm test` skips the suite. In CI it runs in the `backend-postgres` job. The suite refuses the development database (`diyforests_dev`, or any target matching the `backend/.env` connection) before connecting.

> **Live Cognito status: not verified.** Authentication has been tested with the local dev provider and against a fake OpenID provider that runs inside the test suite. No real Cognito user pool has been used yet.

> **Live Neon status: not yet verified.** All database testing so far has used in-memory PostgreSQL (PGlite). Neon counts as verified only after `npm run db:migrate:deploy`, `npm run db:seed` and `npm run db:migrate:status` succeed with your own `backend/.env`, and `GET /api/v1/products` then returns data. See "Checking a live database" below.

## Requirements

Node.js 22.18 or newer (developed on Node 24). Prisma 7.10 requires it.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # optional; the defaults work for local development
npm run dev            # http://localhost:3000, reloads on change
```

`backend/.env` is loaded automatically if it exists. It's git-ignored, so never commit real values.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with reload (tsx) |
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run the compiled server (`dist/server.js`) |
| `npm test` | Run the Vitest suite. It needs no network or external database; the database tests use an in-memory PostgreSQL (PGlite). |
| `npm run typecheck` | Type-check source and tests |
| `npm run lint` | Run oxlint |
| `npm run db:validate` | Validate `prisma/schema.prisma` (offline) |
| `npm run db:generate` | Generate the Prisma Client into `src/generated/prisma` (offline, git-ignored). Also runs automatically before `build`, `typecheck` and `test`. |
| `npm run db:migrate:deploy` | Apply pending migrations to the database in `DIRECT_DATABASE_URL` |
| `npm run db:migrate:status` | Show which migrations are applied |
| `npm run db:migrate:dev` | **Development only.** Create a new migration from schema changes. Needs a database you can throw away, and may offer to reset it. |
| `npm run db:seed` | Upsert the development catalog (safe to rerun; refuses when `NODE_ENV=production`) |

## Configuration

Configuration is validated at startup, and the process exits with code 1 and a clear message if anything is invalid.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `3000` | 1–65535 |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:4173` | Comma-separated origins. **Required in production.** |
| `DATABASE_URL` | none | Runtime PostgreSQL connection (on Neon, the **pooled** string). Secret. Needed by the seed and, in later stages, the API. |
| `DIRECT_DATABASE_URL` | none | Used only by the Prisma CLI for migrations (on Neon, the **direct** string). Secret. |
| `BOOKING_CONFIRMATION_MODE` | `manual` | `manual` or `payment`. `payment` is accepted **only with `NODE_ENV=development` and `PAYMENT_SIMULATOR=true`**; otherwise the API refuses to start. Never enables the simulator itself. See "Manual confirmation and cancellation requests". |
| `PAYMENT_SIMULATOR` | off | `true` or `false`. `true` enables the **development payment simulator** and is accepted **only with `NODE_ENV=development`**: with any other `NODE_ENV` the API refuses to start. See "Payment simulator". |

`npm run dev` and `npm start` work without a database. Without `DATABASE_URL`, `/api/v1/health` still answers, the catalog endpoints return `503 CATALOG_UNAVAILABLE`, and the startup log says "Database not configured".

## Database setup (Neon, development)

You create and own the Neon project, and the connection strings stay on your machine. Never paste them into chat, commits or issues.

1. In the Neon console, create a project, preferably in a region near you or your future AWS region. Create a database such as `diyforests`, or use the default `neondb`.
2. Open **Connect** for the branch. Copy the connection string **with connection pooling on** (the host contains `-pooler`) and **with it off** (the direct host).
3. Create the local config file and paste the two strings into it:
   ```bash
   cd backend
   cp .env.example .env
   # edit .env:  DATABASE_URL = pooled string,  DIRECT_DATABASE_URL = direct string
   ```
   Keep `sslmode=verify-full`, or the `sslmode=require` Neon gives you. If `pg` prints an SSL-mode warning with `require`, switch to `verify-full`.
4. Apply the schema, then seed and check it:
   ```bash
   npm run db:migrate:deploy
   npm run db:seed
   npm run db:migrate:status
   ```
   The seed prints only the host and database name, never the password.

**Why two URLs?** Neon's pooled endpoint runs PgBouncer in transaction mode. That suits many short app queries, but migrations need a direct, session-level connection. Prisma 7 reads the CLI connection from `prisma.config.ts`, which uses `DIRECT_DATABASE_URL`. The app passes `DATABASE_URL` to the `pg` driver adapter (`src/db/client.ts`).

**Moving to Amazon RDS later:** there's no code change, only different URLs. The schema uses plain PostgreSQL features (no Neon extensions), and the `pg` adapter works with any PostgreSQL. The migrating role must own the database, because the first migration runs `ALTER DATABASE … SET timezone`.

**Safety:** never point `DIRECT_DATABASE_URL` at a database you can't lose while running `db:migrate:dev`. Use `db:migrate:deploy` for any shared or production database.

## Schema (prisma/schema.prisma)

| Table | Contents |
|---|---|
| `products` | UUIDv7 `id`; unique kebab-case `slug`; `name`; `type` (`ONLINE_TRAINING`, `OFFLINE_WORKSHOP`, `WEBINAR`); display texts; `price_amount numeric(12,2)` with `currency char(3)`; `is_active`; `archived_at` (retired products kept only for their history; always inactive, hidden everywhere); timestamps |
| `sessions` | UUIDv7 `id`; `product_id`, which references `products` and blocks deleting a product that has sessions; `starts_at` / `ends_at` (`timestamptz`, end optional); IANA `timezone` (default `Asia/Kolkata`); optional `capacity`; `status` (`DRAFT`, `PUBLISHED`, `CANCELLED`); `internal_note`; optional `venue` (workshops); optional `cohort_id` + `cohort_sequence` (1 or 2) for online-training sessions; timestamps. Unique on (`product_id`, `starts_at`) and on (`cohort_id`, `cohort_sequence`). |
| `training_cohorts` | One online-training enrolment unit: two linked 4-hour sessions on consecutive Fridays. `product_id`, `status`, `timezone`, optional `capacity`, `internal_note`, timestamps. Added by migration `20261016120000_schedule_management` (additive only). |

These rules are enforced in the database by CHECK constraints written in the migration SQL, because Prisma's schema language can't express them:
- price ≥ 0
- currency matches `^[A-Z]{3}$`
- slug is kebab-case
- name and timezone aren't blank
- `ends_at` > `starts_at`
- capacity > 0
- a venue, if set, isn't blank
- `cohort_id` and `cohort_sequence` are set together, and the sequence is 1 or 2
- cohort capacity > 0 and cohort timezone isn't blank
- an archived product is never active

**Money:** amounts are exact decimals in major units (500.00 means USD 500), each with its own ISO 4217 currency. Nothing is converted between currencies, and no tax is applied or stored. PostgreSQL rounds input with more than two decimals, so validate amounts before writing them.

## Retired products (migration `20261016140000_retire_obsolete_products`)

The website sells three offerings: **Online Training** (USD 500), **Offline Workshop** (INR 100,000) and **Monthly Webinar** (INR 149). The earlier seed also created **Crash Course** and **Detailed Training** as inactive products. This migration retires them:
- If nothing references one, it is **deleted**.
- If sessions or training cohorts reference one, it can't be deleted (foreign keys) and its history must stay, so it is **archived**: `archived_at` is set and it's forced inactive.

Archived products don't appear in any admin list, count, filter or form. The admin API answers 404 for them, so they can't be edited, activated or scheduled. They never reach the public catalog. Sessions that referenced them stay readable for the record. Past `audit_events` rows are kept; `target_id` has no foreign key.

## Time zones

- A session is **one real instant**, stored as `timestamptz` (UTC internally).
- Organizers schedule in `Asia/Kolkata`. `zonedTimeToInstant()` in `src/lib/time.ts` turns "18:30 on 13 Oct in Asia/Kolkata" into `2026-10-13T13:00:00Z`.
- Visitors see that same instant converted to their own zone, using `instantToZonedTime()` / `formatInstantInZone()`. A visitor's zone never creates a different session time.
- Local times that a daylight-saving change skips or repeats are rejected rather than guessed. India has no DST; other zones do.
- **The database session must be UTC.** Prisma 7.10's `pg` adapter writes `DateTime` values without an offset and reads them ignoring it. In a non-UTC session, the stored instants would be silently shifted, even though Prisma reads would still look right. This was observed in testing.
  - The first migration sets the database default time zone to UTC.
  - `assertUtcSession()` (`src/db/timezone-guard.ts`) refuses to write in a non-UTC session. The seed calls it, and future write paths should too.

## Development seed (src/db/seed-catalog.ts)

The seed is transcribed from the current website and upserts by stable keys, so reruns don't create duplicates.
- **Active products:** Online Training (USD 500.00), Offline Workshop (INR 100,000.00) and Monthly Webinar (INR 149.00).
- **No other products.** Crash Course and Detailed Training were never offered on the page and have been retired (see below); the seed doesn't create them.
- **One session:** the Monthly Webinar on 13 Oct 2026, 18:30 IST, capacity 40. It's a **DRAFT** with a note, because:
  - its date has passed;
  - the site showed the time in each visitor's own zone, so "IST" is an assumption;
  - no end time is stated;
  - "12 seats left" was a placeholder.
- **Not seeded:** Friday training dates and workshop batches. Admins create them in the dashboard (see "Admin management" below); the site shows only what is published.

Re-running the seed resets these rows to the values above. Don't use it on a database where an organizer has edited the catalog.

## Endpoints

| Method and path | Response |
|---|---|
| `GET /api/v1/health` | **Liveness.** `200 {"status":"ok","service":"diy-forests-api","version","time","uptimeSeconds"}`. No caching, and no dependencies. |
| `GET /api/v1/ready` | **Readiness.** `200 {"status":"ready","checks":{"database":"ok","shuttingDown":false}}` only when the database answers within 2 s in a UTC session. Otherwise `503` with `"status":"not_ready"` and `database` set to `unavailable` or `not_configured`, or `shuttingDown: true` once SIGTERM/SIGINT has been received. Never includes error details. |
| `GET /api/v1/products` | Active products. |
| `GET /api/v1/products/:slug` | One active product. |
| `GET /api/v1/sessions` | Published, upcoming **standalone** sessions (webinars, workshop batches, including `venue`) of active products, soonest first. Online-training sessions are listed only as cohorts. Each has `seatsAvailable` (capacity minus active bookings; `null` = no limit). |
| `GET /api/v1/sessions/:id` | One published standalone session of an active product. |
| `GET /api/v1/cohorts?product=&from=&limit=` | Published, upcoming online-training cohorts of active products, each with both sessions (`sequence`, `startsAt`, `endsAt`). Fails closed: a cohort is hidden unless **both** of its sessions are published. |
| `GET /api/v1/cohorts/:id` | One such cohort, or 404 `COHORT_NOT_FOUND`. |

All catalog responses send `Cache-Control: public, max-age=15`, so an admin change reaches visitors within about 15 seconds.

The public catalog has no write endpoints. `POST`, `PUT` and `DELETE` return a JSON 404. Changes go through the admin API below.

### Catalog API

Successful responses use one envelope: `{ "data": … }` for single items, and `{ "data": [ … ] }` for lists (sessions add `meta`).

**`GET /api/v1/products`** accepts one optional query parameter, `type` (`ONLINE_TRAINING`, `OFFLINE_WORKSHOP` or `WEBINAR`). Products are ordered by type, then name.

```json
{
  "data": [
    {
      "id": "0199…",
      "slug": "online-training",
      "name": "Online Training",
      "type": "ONLINE_TRAINING",
      "summary": "Know everything about the Method — spread over 2 days.",
      "description": "A complete live training to understand the method and learn how to create a native forest from start to finish.",
      "audience": "Anyone who wants to know the full method, start to finish.",
      "durationLabel": "8 hours · 2 days",
      "price": { "amount": "500.00", "currency": "USD" }
    }
  ]
}
```

**`GET /api/v1/sessions`** accepts these optional query parameters:

| Parameter | Meaning | Default |
|---|---|---|
| `type` | Product type, as above | — |
| `product` | Product slug | — |
| `from` | ISO 8601 instant **with `Z` or an offset**. Sessions starting at or after it are returned. | The server's current time |
| `limit` | 1–100 | 50 |
| `bookable` | `true`: only dates that can still be booked, i.e. starting **more than 24 hours** after the server's current time (bookings close 24 hours before the start, the same rule the booking API enforces). Also accepted by `GET /cohorts`, where the cohort's first session counts. The website uses `bookable=true`. | `false` (the plain listing above) |

```json
{
  "data": [
    {
      "id": "0199…",
      "startsAt": "2026-11-06T13:00:00.000Z",
      "endsAt": null,
      "timezone": "Asia/Kolkata",
      "capacity": 40,
      "product": { "id": "0199…", "slug": "monthly-webinar", "name": "Monthly Webinar", "type": "WEBINAR", "price": { "amount": "149.00", "currency": "INR" } }
    }
  ],
  "meta": { "from": "2026-10-16T04:51:31.917Z", "limit": 50, "count": 1 }
}
```

An empty schedule returns `200` with `"data": []`. With today's seed data that's the expected result, because the only seeded session is the expired DRAFT webinar.

**Contract rules:**
- **Prices:** `price.amount` is an exact decimal string with two decimals, and `price.currency` is an ISO 4217 code. No currency conversion and no tax.
- **Times:** `startsAt` and `endsAt` are UTC ISO strings ending in `Z`. Each is one fixed instant; clients format it in the visitor's time zone. `timezone` is the organizer's zone.
- **What's public:** inactive products and DRAFT or CANCELLED sessions never appear. Neither do `internal_note`, `is_active`, `status` or timestamps. An inactive or unknown slug gets the same `404 PRODUCT_NOT_FOUND`; a hidden or unknown session id gets `404 SESSION_NOT_FOUND`.
- **Past sessions:** `GET /sessions/:id` also returns a *past* published session, so clients compare `startsAt` with the current time. The list hides past sessions unless you pass an earlier `from`.
- **Unknown query parameters** are rejected with `400 INVALID_QUERY` rather than ignored, which catches typos.
- **Malformed path values** (a bad slug, a non-UUID id) return `400 INVALID_PATH`. Error messages name the parameter and the rule but never echo the submitted value.
- **Database failures** return `503 CATALOG_UNAVAILABLE` with a generic message. This covers no database configured, an unreachable database, a missing migration, and a non-UTC session refused by the time-zone guard. The underlying error is logged server-side only, under `cause`.

Code: `src/modules/catalog/` contains `catalog.routes.ts` (HTTP and validation), `catalog.repository.ts` (all Prisma queries, plus the UTC check before the first query), `catalog.serializers.ts` (explicit public fields) and `catalog.types.ts` (the contract).

Every error uses one JSON shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "No route for GET /api/v1/x", "requestId": "…" } }
```

| Status | Code |
|---|---|
| 404 | `NOT_FOUND`, `PRODUCT_NOT_FOUND`, `SESSION_NOT_FOUND` |
| 400 | `INVALID_JSON`, `INVALID_QUERY`, `INVALID_PATH` |
| 413 | `PAYLOAD_TOO_LARGE` (bodies over 100 kb) |
| 415 | `UNSUPPORTED_ENCODING` |
| 500 | `INTERNAL_ERROR` |
| 503 | `CATALOG_UNAVAILABLE` |

Unexpected errors are logged server-side with their stack trace. Clients get only a generic message.

## Payment simulator (Stage 2, development only)

**Simulated payments are not real money and never count as revenue.** No card number, CVV, bank credential or other payment detail is ever collected or stored. There is no real payment provider, webhook, refund or reconciliation: those are out of scope.

**Turning it on** (local development only):

```bash
# backend/.env
NODE_ENV=development
PAYMENT_SIMULATOR=true
```

Three layers keep it out of production:
1. `loadEnv` refuses to start when `PAYMENT_SIMULATOR=true` and `NODE_ENV` is anything but `development`. Any value other than `true`/`false` is rejected too.
2. The payment **write** routes are not registered unless the simulator is enabled (they answer 404).
3. Each simulator request re-checks `NODE_ENV` at runtime and answers 404 outside `development` (or the automated `test` runs).

The website shows simulator controls only in a **Vite dev build** (`import.meta.env.DEV`) **and** when `GET /api/v1/payments/config` reports `simulator.enabled: true`. Production builds contain neither the controls nor the simulator requests. Every simulated confirmation is shown as **"Confirmed — simulated payment, no money received."**

**Migrations** (additive):
- `20261026090000_payment_states_enum` adds `CONFIRMED` to `booking_status` and `SYSTEM` to `booking_canceller`. These are in their own migration because PostgreSQL can't use a new enum value in the same transaction that adds it.
- `20261026090100_payment_simulator` adds:
  - `bookings.payment_due_at` and `bookings.confirmed_at` (nullable; existing rows keep NULL);
  - the `payment_attempts` table;
  - CHECKs, partial unique indexes, and replaced `bookings_check_target` / `bookings_maintain_seats` functions (same names);
  - new triggers (two of them deferred to commit).

**Database rules** (enforced by PostgreSQL, not just the API):
- A new booking must be `PENDING_PAYMENT` with `payment_due_at = created_at + 30 minutes`. The deadline can never be changed or added later.
- `CONFIRMED` only from `PENDING_PAYMENT`, only with a `SUCCEEDED` attempt. It is final (never back to pending, never cancelled).
- A `SYSTEM` cancellation (expiry) needs a deadline that has passed, so grandfathered bookings can't be expired.
- Payment attempts:
  - A new attempt needs a `PENDING_PAYMENT` booking and exactly the booking's `price_amount` and `currency`. The provider is `DEV_SIMULATOR` with `is_simulated = true`.
  - The snapshot fields are immutable. The status can change once, `CREATED` → `SUCCEEDED` | `FAILED` | `CANCELLED`, then is final.
  - At most one `SUCCEEDED` and one open (`CREATED`) attempt per booking.
  - Success is accepted only while the booking is pending and inside its payment window.
- At commit:
  - a `SUCCEEDED` attempt's booking is `CONFIRMED`;
  - a booking that is no longer pending has no open attempt.
- One active (pending **or** confirmed) booking per customer per session/cohort.

**Customer API** (under `/api/v1/me/bookings`, same guards as bookings: customer session, CSRF + Origin for writes; staff sessions get 403; another customer's booking is 404):

| Method and path | Purpose |
|---|---|
| `GET /:id/payment-attempts` | The booking's attempts, newest first (always available, read-only) |
| `POST /:id/payment-attempts` | **Simulator only.** Header `Idempotency-Key`, empty body. 201 with `{ attempt, booking }`. Same key again: 200 and `Idempotent-Replayed: true`. Errors: `PAYMENT_ATTEMPT_OPEN`, `BOOKING_ALREADY_CONFIRMED`, `BOOKING_NOT_PAYABLE`, `PAYMENT_WINDOW_EXPIRED` (409). |
| `POST /:id/payment-attempts/:attemptId/simulate` | **Simulator only.** Body `{ outcome: "SUCCEEDED" \| "FAILED" }` (nothing else is accepted). Success confirms the booking in the same transaction (seat counts unchanged). Failure leaves it pending with its seat held; another attempt may be started within the window. The same outcome again is a 200 replay; a different final outcome is 409 `PAYMENT_ATTEMPT_COMPLETED`. |
| `POST /:id/payment-attempts/:attemptId/cancel` | **Simulator only.** Cancels that attempt only; the booking stays pending and keeps its seat. |
| `GET /api/v1/payments/config` | Public: `{ simulator: { enabled }, realPayments: false }` |

A result that arrives after the booking was cancelled or expired is **rejected** (409 `BOOKING_NOT_PAYABLE` or `PAYMENT_WINDOW_EXPIRED`) and audited as `PAYMENT_RESULT_REJECTED`; it never confirms the booking. If the deadline has passed when a payment call arrives, the booking is expired in the same transaction.

**Admins** can see a booking's attempts read-only (`payment.attempts` on `GET /admin/bookings/:id`), filter by `status=CONFIRMED`, and see `confirmedSimulated` on the dashboard. That count is kept separate from `confirmedPaid`, which is always 0 in this stage. There is **no** admin route to confirm a booking or simulate a payment.

**Expiry** (`src/modules/bookings/booking-holds.ts`). Overdue holds are released:
- every 60 s by a background timer (started after `listen`, unref'd, stopped on shutdown before the database pool closes);
- before availability reads (catalog sessions/cohorts; throttled to one sweep per 5 s per process, and failures never break the read);
- before each booking for the same dates.

Each expiry is a short transaction: lock the target, then a conditional `UPDATE … WHERE status = 'PENDING_PAYMENT' AND payment_due_at <= now`. That makes it idempotent and race-safe: concurrent sweeps, cancellations and payments can't double-release a seat.

**Lock order** (everywhere: create, cancel, expire, pay): target row `FOR UPDATE` → booking row → its payment attempts.

**Audit events:**
- `PAYMENT_ATTEMPT_CREATED`, `PAYMENT_ATTEMPT_SUCCEEDED`, `PAYMENT_ATTEMPT_FAILED`, `PAYMENT_ATTEMPT_CANCELLED`;
- `BOOKING_CONFIRMED` (with `simulated: true, noMoneyReceived: true`);
- `BOOKING_EXPIRED` (actor label `system`, no user);
- `PAYMENT_RESULT_REJECTED`.

## Manual confirmation and cancellation requests (Revision 3)

While no payment provider exists, bookings are confirmed by staff. **Manual confirmation is not proof of payment, and nothing here is revenue.** No refund is ever processed or claimed by the website.

**Booking states**

| From → to | Who | Rule (enforced by the database trigger `bookings_check_target`) |
|---|---|---|
| new → `AWAITING_CONFIRMATION` | customer (manual mode, default) | before `start − 24h`; `confirmation_due_at = min(created_at + 48h, start − 24h)` |
| new → `PENDING_PAYMENT` | customer (payment mode: development + simulator) | before `start − 24h`; `payment_due_at = created_at + 30m` |
| `AWAITING_CONFIRMATION` → `CONFIRMED` | active admin | method `MANUAL`, reason, note required for `OTHER`, `confirmed_at < confirmation_due_at` |
| `PENDING_PAYMENT` → `CONFIRMED` | simulator success | method `PAYMENT` with a successful attempt |
| `AWAITING_CONFIRMATION` / `PENDING_PAYMENT` → `CANCELLED` | customer, admin (reason), or `SYSTEM` once the deadline passed | seat released once |
| `CONFIRMED` → `CANCELLED` | admin only, through an **approved cancellation request** | in the same transaction as the approval |

`CANCELLED` is final. Confirmation history (`confirmed_at`, method, admin, reason, note) is written once and kept after an approved cancellation. Start = the session start, or the first session of an online-training cohort. Start times, and so deadlines and refund tiers, can't move while seats are held (admins can't reschedule a session or cohort that holds seats).

**Clock.** Each operation uses one API-server timestamp written into the row; the database compares stored timestamps with stored deadlines. Manual confirmation and cancellation requests sample the clock *after* taking their locks. Confirmation is allowed while `now < confirmation_due_at`; expiry applies from `confirmation_due_at <= now`, so at exactly the deadline the booking has expired. The database also refuses a `confirmed_at` or `requested_at` more than 5 minutes older than its own clock, which assumes the API and database clocks are NTP-synchronized.

**Admin API** (under `/api/v1/admin`, behind the admin guards):

| Method and path | Purpose |
|---|---|
| `POST /bookings/:id/confirm` | Body `{ reason: PAYMENT_ARRANGED_OFFLINE \| COMPLIMENTARY \| OTHER, note? }` (note ≤ 500, required ≥ 3 for `OTHER`, no 12+ digit runs). After the deadline the booking is expired instead and the answer is `409 CONFIRMATION_WINDOW_EXPIRED`. An identical repeat is a 200 replay; anything else non-confirmable is `409 BOOKING_NOT_CONFIRMABLE`. |
| `POST /bookings/:id/cancel` | Existing: also **declines** an awaiting booking (reason required). |
| `POST /bookings/:id/cancellation-request/approve` | Body `{ reason }` (3–500). Approves the pending request **and** cancels the booking in one transaction; `409 ALREADY_DECIDED` if already decided. |
| `POST /bookings/:id/cancellation-request/reject` | Body `{ reason }`. The booking stays confirmed; the customer may request again. |
| `GET /bookings?view=AWAITING_CONFIRMATION\|MANUALLY_CONFIRMED\|SIMULATED_CONFIRMED\|CANCELLATION_REQUESTED` | List shortcuts. The dashboard counts each category separately; `confirmedPaid` stays 0. |

**Customer API**: `POST /me/bookings/:id/cancellation-request` with `{ reason? }`, for the owner of a `CONFIRMED` booking before its start (`409 REQUEST_AFTER_START` after). A request while one is pending returns it again (200, `Idempotent-Replayed`). Direct cancellation of a `CONFIRMED` booking is refused; awaiting and pending bookings can still be cancelled directly.

**Refund eligibility** (fixed at the server time the request is submitted; exact milliseconds; also computed and checked by the database functions `refund_policy_for` / `refund_percent_for`):
- `TRAINING_V1` (online training, offline workshops, other training): ≥ 7 × 24h before the start 100%; ≥ 3 × 24h 50%; otherwise 0%.
- `WEBINAR_V1`: 100% strictly before the start.
- The percentage is eligibility only, never a money amount. On approval the database-checked `refund_outcome` records what the website did: `NO_REFUND_SIMULATED_PAYMENT`, `NO_REFUND_COMPLIMENTARY`, or `NOT_PROCESSED_BY_WEBSITE` (payment arranged offline / other: anything arranged with staff is handled outside the website). There is no "refunded" value. Real-provider refunds, captured amounts and an "offline payment received" action are deferred.

**Integrity**: one pending request per booking; the database recomputes the policy, percentage and outcome; decisions are final; and a deferred check at commit refuses an approved request whose booking is not cancelled. Together with "`CONFIRMED` → `CANCELLED` only with an approved request", approval and cancellation can only commit together.

**Audit events**: `BOOKING_CREATED` (mode, deadline), `BOOKING_CONFIRMED_MANUALLY` (reason code, whether a note exists — never the note), `BOOKING_CONFIRMATION_REJECTED_LATE`, `BOOKING_EXPIRED` (which deadline), `BOOKING_CANCELLED` (`kind: DECLINED` / `REQUEST_APPROVED`), `BOOKING_CANCELLATION_REQUESTED` (policy, percentage — never the customer's text), `BOOKING_CANCELLATION_APPROVED` (outcome), `BOOKING_CANCELLATION_REJECTED`.

**Migrations** (additive):
- `20261027090000_awaiting_confirmation_enum`: the new status only (PostgreSQL can't use a new enum value in the transaction that adds it).
- `20261027090100_manual_confirmation_cancellation_requests`: new types, nullable booking columns, the `booking_cancellation_requests` table, constraints, partial indexes, functions and the replaced trigger functions. **It stops (and changes nothing) if any booking was already confirmed before it**, because such rows have no confirmation method; no existing row is rewritten.

## Request handling

Each request passes through these steps, in order:

1. **Request ID:** taken from the caller's `X-Request-Id` header if it's short and plain (`[A-Za-z0-9._-]`, at most 128 characters); otherwise a new UUID. It's returned in the `X-Request-Id` header and in error bodies.
2. **Helmet:** sets the security headers.
3. **CORS:** applies the `CORS_ORIGINS` allow-list.
4. **JSON body parser:** 100 kb limit.
5. **Routes.**
6. **404 handler.**
7. **Error handler.**

## Layout

```
prisma.config.ts         Prisma 7 CLI config (schema path, migrations, seed command, DIRECT_DATABASE_URL)
prisma/
  schema.prisma          products, sessions
  migrations/            SQL migrations (the first one adds CHECK constraints and the UTC default)
  seed.ts                seed entry point (prisma db seed)
src/
  server.ts              process entry: env loading, listen, graceful shutdown
  app.ts                 createApp(): middleware and routes (used by tests)
  config/env.ts          zod-validated configuration
  config/database.ts     DATABASE_URL validation (errors never echo the URL)
  db/client.ts           createPrismaClient() over the pg driver adapter
  db/timezone-guard.ts   assertUtcSession()
  db/seed-catalog.ts     development catalog data and the idempotent upsert
  generated/prisma/      generated Prisma Client (git-ignored)
  lib/                   logger (JSON lines), HttpError, time-zone helpers
  middleware/            request-id, not-found, error-handler
  modules/catalog/       read-only catalog: routes, repository (Prisma), serializers, contract types
  modules/auth/          sign-in (OIDC + dev provider), sessions, CSRF, rate limits, /me, /admin, operator CLI logic
scripts/admin.ts         operator CLI entry point (npm run admin -- …)
  routes/health.ts
tests/                   Vitest + Supertest; tests/db/* run against in-memory PGlite
```

HTTP handlers never call Prisma directly. Routes validate input and go through a repository interface, which `createApp({ catalog })` receives, so tests can inject a real PGlite-backed repository or a failing stub.

## Running the backend and frontend together

```bash
# terminal 1: API on http://localhost:3000
cd backend
npm run dev

# terminal 2: site on http://localhost:5173, with /api proxied to :3000
cd frontend
npm run dev
```

- **Without `backend/.env`:** the site still renders, using the existing static prices. The webinar banner shows "Schedule unavailable" with a **Try again** button, because the catalog returns 503.
- **With a database but no published session:** the banner shows "Next date to be announced". This is the expected result with today's seed.

## Checking a live database (Neon)

These steps tell you whether Neon has actually been verified. Run them after the steps in "Database setup":

```bash
npm run db:migrate:status          # "Database schema is up to date!"
npm run db:seed                    # "Seeded 5 products and 1 session(s) into <host>/<db>."
npm run dev                        # log line "Database configured" (host and database name only)
curl http://localhost:3000/api/v1/products   # three products, prices as decimal strings
```

A `503 CATALOG_UNAVAILABLE` response means the API could not use the database. The server log shows why, in the entry's `cause` field. Typical causes are a wrong URL, unapplied migrations, or a non-UTC session.

Business modules live under `src/modules/`: `catalog` (Stage 3) and `auth` (Stage 4A) so far. Booking and notification modules come in later stages.

## Authentication

Customers and staff sign in through the identity provider's own pages. This app never sees or stores passwords. After sign-in, the backend keeps a **server-side session** in PostgreSQL, and the browser holds only an `HttpOnly` cookie that JavaScript can't read.

### How it works

- **Two identity pools.**
  - **Customer pool:** self sign-up, email verification and password reset, all on the provider's pages.
  - **Admin pool:** no self sign-up, and MFA **required**. Cognito sets MFA per user pool, so admins need a pool of their own to enforce it.
- **Sign-in flow:** OIDC authorization code with PKCE, run by the backend (`openid-client`).
  - The backend validates `state`, `nonce`, the PKCE verifier, and the ID token's **signature** against the issuer's keys, plus its issuer, audience and expiry.
  - Signature checking is switched on explicitly (`enableNonRepudiationChecks`). The library's default trusts TLS alone.
  - The one-time login state is kept in a signed, 10-minute `HttpOnly` cookie.
  - `returnTo` accepts only same-site paths, so sign-in can't be used as an open redirect.
- **Accounts:** stored in `users`, keyed by (issuer, subject).
  - New customer-pool identities always get role `CUSTOMER`.
  - Sign-in through the admin pool **never creates an account**. Only identities an operator has provisioned as `ADMIN` may sign in there.
  - A database CHECK makes it impossible for a customer-pool account to hold the `ADMIN` role.
  - **Account-linking policy:** accounts are never linked automatically by email. The same email in both pools means two separate accounts.
- **Admin access requires all of these at once:**
  - an `ADMIN` session (issued only by the admin-pool sign-in);
  - an admin-pool account with role `ADMIN` and status `ACTIVE` in PostgreSQL;
  - the currently configured admin issuer.

  Nothing in the request (headers, body or query) can grant a role.
- **Sessions:**
  - **Tokens:** random 256-bit; only their SHA-256 hash is stored.
  - **Rotation:** a new token is issued on every sign-in and the previous one is revoked.
  - **Expiry:** idle and absolute limits. Customers: 12 hours idle, 7 days absolute. Admins: 1 hour idle, 12 hours absolute. All configurable.
  - **Revocation:** on logout, on account disablement, or by an operator.
  - **Trade-off:** shorter lifetimes limit the damage from a stolen device or cookie, but customers have to sign in more often.
- **Cookies:** `HttpOnly`, `SameSite=Lax`, `Path=/`. On https they are also `Secure` and named with the `__Host-` prefix.
- **CSRF:** every state-changing request needs both:
  - an allowed `Origin` (or `Referer`);
  - a session-bound `X-CSRF-Token` header (the token comes from `GET /auth/me`).
- **Rate limits:** on sign-in and session endpoints, answering `429 RATE_LIMITED` with `Retry-After`. **The limiter is in-memory**: with several API instances, each counts separately, so add a shared store (e.g. Redis) before scaling out.
- **Logs and errors:** logs never contain cookies, tokens, codes or secrets. Values under secret-looking keys are redacted as a second line of defence. Provider and database errors reach clients only as generic messages.

### Endpoints

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/v1/auth/login?returnTo=` | anyone | Start customer sign-in (redirects to the provider) |
| `GET /api/v1/auth/register?returnTo=` | anyone | Same, opening the sign-up screen |
| `GET /api/v1/auth/callback` | provider | Finish sign-in; set the session cookie; redirect to `returnTo` |
| `GET /api/v1/admin/auth/login?returnTo=` | anyone | Start staff sign-in (admin pool) |
| `GET /api/v1/admin/auth/callback` | provider | Finish staff sign-in |
| `GET /api/v1/auth/me` | signed in | `{ data: { user, session, csrfToken } }`, or 401 |
| `POST /api/v1/auth/logout` | signed in, CSRF | Revoke the session; returns `{ data: { logoutUrl } }` (the provider's sign-out page, or `null`) |
| `GET /api/v1/me/profile` | signed in | Own profile |
| `PATCH /api/v1/me/profile` | signed in, CSRF | `{ "displayName": "…" }` (or `null`) only. Any other field is a 400. |
| `GET /api/v1/admin/me` | admin | Confirms admin access |
| `/api/v1/admin/…` | admin, CSRF on writes | Product and schedule management (see "Admin management") |

Customer data is reachable only through `/me` routes scoped to the session. No route takes another user's id.

**Sign-in failures** redirect to the website's `/sign-in?error=<code>` (plus `&pool=admin` for staff), with no provider details. The codes are:
- `auth_unavailable`, `provider_unavailable`, `service_unavailable`
- `login_expired`, `invalid_state`, `invalid_response`, `cancelled`
- `email_unverified`, `account_disabled`, `not_authorized`

**API errors:**

| Status | Code |
|---|---|
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `CSRF_FAILED` |
| 400 | `INVALID_REQUEST`, `INVALID_QUERY` |
| 429 | `RATE_LIMITED` |
| 503 | `AUTH_UNAVAILABLE` |

### Local development with test identities (no AWS)

Add these lines to `backend/.env`:

```bash
NODE_ENV=development
AUTH_MODE=dev
AUTH_DEV_LOGIN=true
AUTH_PUBLIC_ORIGIN=http://localhost:5173
SESSION_SECRET=<output of: openssl rand -base64 48>
```

`DATABASE_URL` is also required. Then run `npm run db:migrate:deploy` and start the backend and frontend (see "Running the backend and frontend together").

"Sign in" now opens a page labelled **DEVELOPMENT SIGN-IN**. It lists test identities on `example.test` addresses:

| Identity | Behaviour |
|---|---|
| Test Customer One, Test Customer Two | Verified test customers |
| Unverified Customer | Refused (email not verified) |
| Test Admin | Must be provisioned first (below) |
| Unprovisioned Staff | Uses Test Customer One's email; never provisioned, so refused |

The dev provider still goes through `state`, `nonce` and PKCE, and it never decides roles. It refuses to start unless `NODE_ENV=development` **and** `AUTH_DEV_LOGIN=true`, and it is impossible to enable when `NODE_ENV=production`. The server logs a warning at startup whenever it's on.

### Provisioning the first admin and managing accounts (operator CLI)

Admin rights can only be granted from a terminal with database access, never over HTTP. Every command writes an audit event.

```bash
npm run admin -- grant --subject <sub> --email <email> --name "Display Name"   # cognito mode (--name optional)
npm run admin -- grant --dev-identity dev-admin-1                              # dev mode
npm run admin -- find --email person@example.com           # list accounts (both pools) and their ids
npm run admin -- disable --user-id <uuid>                   # block sign-in and revoke all sessions now
npm run admin -- enable --user-id <uuid>
npm run admin -- revoke-sessions --user-id <uuid>           # sign out everywhere
```

To add an admin in Cognito:
1. In the **admin** user pool, create the user (an invitation email is sent). Copy the user's **sub** (User ID).
2. Run `grant` with that sub and email.
3. The admin signs in at `/admin` → **Staff sign-in** and sets up MFA on first sign-in.

Disabling the account in Cognito stops new sign-ins there. `disable` here also ends any active session immediately.

### Cognito setup (when you're ready; not done by this project)

1. Create **two** user pools in your region on the Essentials plan:
   - **customer pool:** self-registration on, sign-in with email, email verification on, MFA optional;
   - **admin pool:** self-registration **off**, MFA **required** (authenticator app).

   Keep the `email` attribute required in both, so password reset works.
2. In each pool:
   - Add a managed-login domain.
   - Create an app client with a **client secret**, the authorization code grant, and scopes `openid email profile`.
   - Callback URL `https://<site>/api/v1/auth/callback` (customer) or `https://<site>/api/v1/admin/auth/callback` (admin).
   - Sign-out URL `https://<site>/`.
3. Put the issuers (`https://cognito-idp.<region>.amazonaws.com/<pool id>`), client ids, client secrets and domains into `backend/.env` (or AWS Secrets Manager in production) with `AUTH_MODE=cognito`. Never commit them.
4. Optionally style managed login with Cognito's branding editor to match the site.

**Not yet verified against real AWS:**
- Cognito sign-in and sign-up;
- MFA enrolment;
- the managed-login `/signup` and `/logout` endpoints;
- Cognito's `email_verified` claim format.

The automated tests use a local fake OpenID provider with throwaway signing keys.

### Database tables (migration `20261016090000_auth_foundation`)

| Table | Contents |
|---|---|
| `users` | Pool, issuer and subject (unique pair), lower-cased email (not unique), email_verified, display_name, role (`CUSTOMER` or `ADMIN`), status (`ACTIVE` or `DISABLED`), timestamps |
| `auth_sessions` | User, token hash (unique), kind, idle and absolute expiry, last seen, revocation time and reason, truncated user agent |
| `audit_events` | Actor, action (e.g. `ADMIN_GRANTED`, `ADMIN_SIGNED_IN`, `ADMIN_SIGN_IN_DENIED`, `ACCOUNT_DISABLED`, `SESSIONS_REVOKED`, `CUSTOMER_REGISTERED`, `PROFILE_UPDATED`), target, request id, details. Never tokens or secrets; denied admin identities are stored only as an opaque hash. |

The CHECK constraints are:
- **users:** role ↔ pool, email format, disabled status ↔ timestamp;
- **auth_sessions:** expiry order, revocation completeness, token-hash format;
- **audit_events:** action format.

Every write runs through the UTC time-zone guard.

## Admin management (Stage 4B)

All routes sit under `/api/v1/admin` behind the admin guards from Stage 4A:
- an admin session;
- `X-CSRF-Token` plus an Origin check on writes;
- `Cache-Control: no-store`;
- rate limiting.

Request bodies are strict, so unknown fields are a 400. Lists return `{ data, meta: { page, pageSize, total } }`, with `pageSize` capped at 100. Creates return 201. Nothing is ever hard-deleted. Every change writes an `audit_events` row (`PRODUCT_*`, `SESSION_*`, `COHORT_*`).

| Method and path | Purpose |
|---|---|
| `GET /dashboard` | Product counts; per schedule type, upcoming published/draft counts and the next dates; and `bookings: { pendingPayment, cancelled }` |
| `GET, POST /products` | List (`?type=&active=&page=&pageSize=`) / create. New products start **inactive**. |
| `GET, PATCH /products/:id` | Read (with schedule counts) / edit texts, slug or price (`{ amount: "149.00", currency: "INR" }`). The type is fixed after creation. |
| `POST /products/:id/activate`, `/deactivate` | Show on, or hide from, the public catalog |
| `GET, POST /sessions` | Webinars and workshop batches (`?type=WEBINAR\|OFFLINE_WORKSHOP&status=`). Online-training products are refused with `USE_COHORTS`. |
| `GET, PATCH /sessions/:id` | Read / edit or reschedule. Cohort sessions are refused with `COHORT_MANAGED`, and cancelled ones with `INVALID_STATE`. |
| `POST /sessions/:id/publish`, `/cancel` | DRAFT → PUBLISHED (needs an active product and a future start) / → CANCELLED (final, optional `reason`) |
| `GET, POST /cohorts` | Online-training cohorts. Body: `{ productId, firstSessionStartsAt, secondSessionStartsAt?, capacity?, internalNote? }` |
| `GET, PATCH /cohorts/:id` | Read / reschedule both sessions together |
| `POST /cohorts/:id/publish`, `/cancel` | Publish or cancel the cohort **and both of its sessions** in one transaction |

**Scheduling rules** (`src/modules/admin/schedule-rules.ts`), checked on the server; the dashboard mirrors them only for faster feedback:
- Times are exact instants with an offset, for example `2026-11-06T18:30:00+05:30`. The organizer zone is `Asia/Kolkata`.
- **Webinars:** the end time is optional and must be after the start. Capacity is optional (1–100000).
- **Workshops:** the end time and a venue (up to 200 characters) are required.
- **Online training:**
  - The first session must be a **Friday** in IST, and in the future.
  - Session 2 is always the first session + 7 calendar days at the same local time. A supplied `secondSessionStartsAt` must match, or the request fails with `SECOND_SESSION_MISMATCH`.
  - Each session lasts 4 hours.
  - Publishing re-checks that both sessions exist and still follow the rule, or fails with `COHORT_INCOMPLETE`.
- New sessions can't start in the past. Two sessions of one product can't start at the same instant (409 `SESSION_CONFLICT`). The whole cohort write rolls back if either session collides.

**Effect on the website:**
- Drafts, cancelled items, past dates and anything belonging to an inactive product are never public.
- Publishing, rescheduling or cancelling shows up on the public catalog within the 15-second cache window.

**Since Stage 4C:** sessions and cohorts show `seatsHeld`. While a session or cohort holds seats it can't be rescheduled (dates, end or venue) or cancelled (409 `HAS_ACTIVE_BOOKINGS`; cancel its bookings first), and its capacity can't go below `seatsHeld` (409 `CAPACITY_BELOW_HELD`). These checks run under a row lock, and the database CHECK `seats_held <= capacity` enforces the capacity rule too. Deactivating a product keeps all of its bookings.

**Migration:** `20261016120000_schedule_management` is additive (new nullable columns, the new table, constraints). Apply it with `npm run db:migrate:deploy` against a development database. It hasn't been applied to any live database by this project.

## Bookings (Stage 4C)

Migration `20261018090000_booking_foundation` adds the `bookings` table, `seats_held` counters on `sessions` and `training_cohorts`, CHECK constraints, partial unique indexes and two triggers:
- `bookings_check_target` checks that the target matches the product and blocks changes to customer, target, product name, price, currency and reference, and any reinstatement. (Product name was added by the follow-up migration `20261022090000_booking_snapshot_immutable`, which only replaces this function.)
- `bookings_maintain_seats` keeps the counters in step with active bookings.

**Rules**
- One booking is one seat for one customer on exactly one target. A webinar or offline-workshop booking takes a `sessionId`. An online-training booking takes the `cohortId`, which covers both Friday sessions; booking a single cohort session is refused.
- The target must be **published**, belong to the chosen **active, non-archived** product, and not have started. Workshops also need their venue and end date. Cohorts must still be two valid 4-hour Fridays exactly 7 days apart.
- Name, price and currency are **snapshotted** when the booking is made. No tax is added. Later admin changes never alter existing bookings.
- **Revision 3: bookings close 24 hours before the start** (both modes; `409 BOOKING_CUTOFF_PASSED`). In **manual mode (the default)** a new booking is `AWAITING_CONFIRMATION` until staff confirm or decline it (see "Manual confirmation and cancellation requests").
- **Payment hold (Stage 2, payment mode only: development + simulator).** A new booking is `PENDING_PAYMENT` with `payment_due_at = created_at + 30 minutes`. If it is not `CONFIRMED` by then it **expires**: `CANCELLED` by `SYSTEM` with reason "Payment not completed in time", seat released, `BOOKING_EXPIRED` audited. Bookings made before migration `20261026090100_payment_simulator` have no deadline (**grandfathered**): they never expire and can never be confirmed manually.
- `PENDING_PAYMENT` and `CONFIRMED` both hold one seat; pending → confirmed never changes the counters. `CONFIRMED` is final: it can't return to pending and **can't be cancelled** (customer or admin) until an approved refund policy exists.
- Customers can cancel their own pending booking until the dates start. Admins can cancel any pending booking, and must give a reason (3–500 characters). Cancelling also cancels the booking's open payment attempt.
- Phone numbers are validated and normalized **on the server** (`src/modules/bookings/phone.ts`). They're stored as country, dialing code, national number and E.164. The project has no phone-number library, so only the countries listed in that file are accepted: IN, US, CA, GB, AU, NZ, AE, SG, DE, FR, NL and AM. Any other country gets `400 PHONE_COUNTRY_UNSUPPORTED` rather than a guessed number.

**Customer API** (under `/api/v1/me`). These routes need a signed-in **customer** session; staff sessions get 403 `CUSTOMER_ACCOUNT_REQUIRED`. Writes need CSRF + Origin, and responses are `no-store`.

| Method and path | Purpose |
|---|---|
| `POST /me/bookings` | Body `{ productId, sessionId \| cohortId, contactName, phone: { country, number } }`, plus header `Idempotency-Key` (16–64 of `A-Z a-z 0-9 _ -`). Returns 201 with the booking. A retry with the same key and the same details returns 200, the same booking and `Idempotent-Replayed: true`. The same key with different details is 409 `IDEMPOTENCY_KEY_REUSED`. Extra limit: `AUTH_RATE_LIMIT_MAX` attempts per window per IP. |
| `GET /me/bookings?status=&page=&pageSize=` | The customer's own bookings, newest first |
| `GET /me/bookings/:id` | One of the customer's own bookings. Someone else's booking is 404, so its existence is never revealed. |
| `POST /me/bookings/:id/cancel` | Body `{ reason? }`. Releases the seat. A `CONFIRMED` booking is 409 `BOOKING_NOT_CANCELLABLE`. |

Errors: `TARGET_TYPE_MISMATCH`, `TARGET_PRODUCT_MISMATCH`, `PHONE_INVALID`, `PHONE_COUNTRY_UNSUPPORTED`, `IDEMPOTENCY_KEY_REQUIRED` (400); `PRODUCT_NOT_FOUND`, `SESSION_NOT_FOUND`, `COHORT_NOT_FOUND`, `BOOKING_NOT_FOUND` (404); `PRODUCT_UNAVAILABLE`, `TARGET_NOT_BOOKABLE`, `TARGET_STARTED`, `ALREADY_BOOKED`, `SOLD_OUT`, `BOOKING_NOT_CANCELLABLE`, `IDEMPOTENCY_KEY_REUSED` (409); `BOOKINGS_UNAVAILABLE` (503).

**Admin API** (under `/api/v1/admin`, behind the admin guards):

| Method and path | Purpose |
|---|---|
| `GET /bookings?status=&productId=&sessionId=&cohortId=&q=&createdFrom=&createdTo=&page=&pageSize=` | List. `q` is an exact reference or part of the customer's email. The list doesn't include phone numbers. |
| `GET /bookings/:id` | Detail, including the contact phone |
| `POST /bookings/:id/cancel` | Body `{ reason }` (required). Audited as `BOOKING_CANCELLED`. |

**Audit:** `BOOKING_CREATED` and `BOOKING_CANCELLED` events record the reference, the target and, for cancellations, who cancelled and why. They never record phone numbers.

**Concurrency.** Creating a booking locks the product `FOR SHARE` and the target row `FOR UPDATE`, then re-reads its status and seats. As a result:
- competing requests for the last seat are serialized;
- an admin capacity change or cancellation of that target waits for the booking, and vice versa;
- a same-key request that was waiting is replayed instead of booked twice.

Cancellation is a conditional update (`WHERE status = 'PENDING_PAYMENT'`), so only one of several concurrent cancellations (or a cancellation racing a payment or an expiry) succeeds. Database failures are logged by code and constraint name only, never with row data.

**Testing levels**
- `tests/bookings/*.test.ts`: unit tests.
- `tests/db/bookings.integration.test.ts`: HTTP + PGlite. These use real constraints, triggers and transactions over **one** connection, so competing requests are serialized and this is not proof of behaviour under concurrency.
- `tests/db/payments.integration.test.ts` (HTTP + PGlite, injected clock) and `tests/db/payment-hold.migration.test.ts` (the Stage 2 migrations applied on top of existing Stage 4C rows): see "Payment simulator".
- `tests/db/manual-confirmation.integration.test.ts`, `tests/db/cancellation-requests.integration.test.ts` (HTTP + PGlite, injected clock) and `tests/db/manual-confirmation.migration.test.ts` (the Revision 3 migrations on existing Stage 4C/Stage 2 rows): see "Manual confirmation and cancellation requests".
- `tests/db/bookings.postgres-concurrency.test.ts`: **real PostgreSQL only**. It is skipped unless `TEST_POSTGRES_URL` is set. It refuses any database that isn't empty or whose name doesn't contain `test`, applies all migrations, then runs 19 tests:
  - 20 connections race for the last seat, and for 5 seats (no overbooking);
  - the same submission sent 8 times at once creates one booking;
  - 8 concurrent cancellations release the seat once;
  - capacity reductions racing bookings never leave more seats held than capacity;
  - one idempotency key sent at once with US and CA phone numbers (both +1, same digits) gives one booking and one `409 IDEMPOTENCY_KEY_REUSED`;
  - the product name, price and currency snapshot cannot be changed in the database (trigger);
  - Stage 2: simulated payment success racing the customer's cancellation (each booking ends CONFIRMED or CANCELLED, never both); success just inside the window racing the expiry sweep (exactly one wins); 8 identical simulated successes at once (one confirmation, 7 replays); 8 concurrent payment starts (one open attempt); overlapping expiry sweeps (each booking expired once);
  - Revision 3: 20 customers racing for the last seat in manual mode; manual confirmation 1 ms before the deadline racing the expiry sweep at the deadline (exactly one wins); confirmation racing the customer cancelling; approve racing reject; 4 concurrent approvals (one wins, seat released once); 8 identical cancellation requests at once (one request);
  - afterwards every seat counter equals its active (pending, awaiting or confirmed) bookings.

  CI (`backend-postgres` job) requires exactly 19 tests, all passed; update that count in `.github/workflows/ci.yml` when adding or removing a test here.

  ```bash
  TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/diyforests_test npx vitest run tests/db/bookings.postgres-concurrency.test.ts
  ```

  Never point it at a shared or production database.
