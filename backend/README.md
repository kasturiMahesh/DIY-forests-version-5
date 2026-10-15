# DIY Forests API

Backend for the DIY Forests training platform: a Node.js + TypeScript + Express modular monolith with a versioned REST API under `/api/v1`.

**Stage 1 (current):** the skeleton only. There's no database, authentication, payments or email yet, and the React frontend does not call this API yet.

## Requirements

Node.js 22 or newer (developed on Node 24).

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
| `npm test` | Run the Vitest suite (no network or database needed) |
| `npm run typecheck` | Type-check source and tests |
| `npm run lint` | Run oxlint |

## Configuration

Configuration is validated at startup, and the process exits with code 1 and a clear message if anything is invalid.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `PORT` | `3000` | 1–65535 |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:4173` | Comma-separated origins. **Required in production.** |

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
src/
  server.ts              process entry: env loading, listen, graceful shutdown
  app.ts                 createApp(): middleware and routes (used by tests)
  config/env.ts          zod-validated configuration
  lib/                   logger (JSON lines), HttpError
  middleware/            request-id, not-found, error-handler
  routes/health.ts
tests/                   Vitest + Supertest
```

Business modules (catalog, booking, identity, notifications, admin) will go under `src/modules/` in later stages.
