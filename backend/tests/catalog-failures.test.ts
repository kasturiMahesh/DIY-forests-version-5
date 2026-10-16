// Catalog endpoints without a database, and with a failing one (no PostgreSQL needed).
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadEnv } from '../src/config/env.js'
import type { CatalogRepository } from '../src/modules/catalog/catalog.repository.js'
import { memoryLogger, type LoggedLine } from './helpers.js'

const env = loadEnv({ NODE_ENV: 'test' })
const ENDPOINTS = ['/api/v1/products', '/api/v1/products/online-training', '/api/v1/sessions', '/api/v1/sessions/01990000-0000-7000-8000-000000000000', '/api/v1/cohorts', '/api/v1/cohorts/01990000-0000-7000-8000-000000000000']

// Simulates a driver failure whose message contains things that must never reach a client.
const failing: CatalogRepository = {
  listProducts: () => Promise.reject(new Error('connect ECONNREFUSED postgresql://app:hunter2@db.internal:5432/diy')),
  findProduct: () => Promise.reject(new Error('relation "products" does not exist')),
  listUpcomingSessions: () => Promise.reject(Object.assign(new Error('Invalid `prisma.session.findMany()` invocation'), { code: 'P1001' })),
  findSession: () => Promise.reject(new Error('timeout exceeded when trying to connect')),
  listUpcomingCohorts: () => Promise.reject(new Error('connect ECONNREFUSED postgresql://app:hunter2@db.internal:5432/diy')),
  findCohort: () => Promise.reject(new Error('relation "training_cohorts" does not exist')),
}

describe('catalog without a configured database', () => {
  it.each(ENDPOINTS)('GET %s → 503 CATALOG_UNAVAILABLE', async (path) => {
    const res = await request(createApp({ env, version: 'test', logger: memoryLogger() })).get(path)
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: { code: 'CATALOG_UNAVAILABLE', message: expect.stringMatching(/temporarily unavailable/), requestId: res.headers['x-request-id'] } })
  })

  it('still validates input first (400, not 503)', async () => {
    const res = await request(createApp({ env, version: 'test', logger: memoryLogger() })).get('/api/v1/sessions?limit=0')
    expect(res.status).toBe(400)
  })

  it('leaves health and 404 handling unchanged', async () => {
    const app = createApp({ env, version: 'test', logger: memoryLogger() })
    expect((await request(app).get('/api/v1/health')).status).toBe(200)
    expect((await request(app).get('/api/v1/bookings')).body.error.code).toBe('NOT_FOUND')
    expect((await request(app).post('/api/v1/products').send({})).status).toBe(404) // no write endpoints
  })
})

describe('catalog with a failing database', () => {
  it.each(ENDPOINTS)('GET %s → client-safe 503, details logged server-side only', async (path) => {
    const lines: LoggedLine[] = []
    const res = await request(createApp({ env, version: 'test', logger: memoryLogger(lines), catalog: failing })).get(path)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('CATALOG_UNAVAILABLE')
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|postgresql:|ECONNREFUSED|relation|prisma|P1001|timeout|stack/i)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', fields: { requestId: res.headers['x-request-id'], cause: { message: expect.any(String) } } })
  })
})
