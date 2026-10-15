# DIY Forests API

Backend for the DIY Forests training platform: a Node.js + TypeScript + Express modular monolith with a versioned REST API under `/api/v1`.

**Stage 2 (current):** the Stage 1 skeleton plus the PostgreSQL catalog schema (products and sessions), migrations and a development seed. There are no catalog endpoints, authentication, bookings, payments or email yet, and the React frontend doesn't call this API.

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

`npm run dev` and `npm start` don't need a database yet.

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
| `products` | UUIDv7 `id`; unique kebab-case `slug`; `name`; `type` (`ONLINE_TRAINING`, `OFFLINE_WORKSHOP`, `WEBINAR`); display texts; `price_amount numeric(12,2)` with `currency char(3)`; `is_active`; timestamps |
| `sessions` | UUIDv7 `id`; `product_id`, which references `products` and blocks deleting a product that has sessions; `starts_at` / `ends_at` (`timestamptz`, end optional); IANA `timezone` (default `Asia/Kolkata`); optional `capacity`; `status` (`DRAFT`, `PUBLISHED`, `CANCELLED`); `internal_note`; timestamps. Unique on (`product_id`, `starts_at`). |

These rules are enforced in the database by CHECK constraints written in the migration SQL, because Prisma's schema language can't express them:
- price ≥ 0
- currency matches `^[A-Z]{3}$`
- slug is kebab-case
- name and timezone aren't blank
- `ends_at` > `starts_at`
- capacity > 0

**Money:** amounts are exact decimals in major units (500.00 means USD 500), each with its own ISO 4217 currency. Nothing is converted between currencies, and no tax is applied or stored. PostgreSQL rounds input with more than two decimals, so validate amounts before writing them.

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
- **Inactive products:** Crash Course (INR 3,500.00) and Detailed Training (INR 5,500.00). They're in the site's data but never offered on the page.
- **One session:** the Monthly Webinar on 13 Oct 2026, 18:30 IST, capacity 40. It's a **DRAFT** with a note, because:
  - its date has passed;
  - the site showed the time in each visitor's own zone, so "IST" is an assumption;
  - no end time is stated;
  - "12 seats left" was a placeholder.
- **Not seeded:** Friday training dates and workshop batches. The site generates them in the browser and they aren't a real schedule.

Re-running the seed resets these rows to the values above. Don't use it on a database where an organizer has edited the catalog.

## Endpoints

| Method and path | Response |
|---|---|
| `GET /api/v1/health` | `200 {"status":"ok","service":"diy-forests-api","version","time","uptimeSeconds"}`. No caching, and no dependencies. |

Every error uses one JSON shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "No route for GET /api/v1/x", "requestId": "…" } }
```

| Status | Code |
|---|---|
| 404 | `NOT_FOUND` |
| 400 | `INVALID_JSON` |
| 413 | `PAYLOAD_TOO_LARGE` (bodies over 100 kb) |
| 415 | `UNSUPPORTED_ENCODING` |
| 500 | `INTERNAL_ERROR` |

Unexpected errors are logged server-side with their stack trace. Clients get only a generic message.

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
  routes/health.ts
tests/                   Vitest + Supertest; tests/db/* run against in-memory PGlite
```

Database access stays in `src/db/`, separate from HTTP routes. No route uses the database yet.

Business modules (catalog, booking, identity, notifications, admin) will go under `src/modules/` in later stages.
