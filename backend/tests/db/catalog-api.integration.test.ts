import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadEnv } from '../../src/config/env.js'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { seedCatalog } from '../../src/db/seed-catalog.js'
import { SessionStatus } from '../../src/generated/prisma/enums.js'
import { createCatalogRepository } from '../../src/modules/catalog/catalog.repository.js'
import { memoryLogger, type LoggedLine } from '../helpers.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

let database: TestDatabase
let prisma: PrismaClient
const env = loadEnv({ NODE_ENV: 'test' })
const appWith = (prismaClient: PrismaClient, lines: LoggedLine[] = []) =>
  createApp({ env, version: 'test', logger: memoryLogger(lines), catalog: createCatalogRepository(prismaClient) })

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Whole-minute instants relative to the real clock, so "upcoming" means upcoming whenever the suite runs.
const at = (offsetMs: number) => new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)

const ids: Record<string, string> = {}
const startsAt: Record<string, Date> = {}

beforeAll(async () => {
  database = await startTestDatabase()
  await prismaCli(['migrate', 'deploy'], database.url)
  prisma = createPrismaClient(database.url, { maxConnections: 1 })
  // Deliberately non-UTC first (see "UTC guard" below); the fixtures switch to UTC.
  await prisma.$executeRawUnsafe(`SET TIME ZONE 'Etc/GMT-5'`)
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await database?.stop()
})

describe('UTC guard', () => {
  it('serves 503 instead of misreading times when the database session is not UTC', async () => {
    const lines: LoggedLine[] = []
    const res = await request(appWith(prisma, lines)).get('/api/v1/sessions')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('CATALOG_UNAVAILABLE')
    expect(JSON.stringify(lines)).toMatch(/must be UTC/) // the reason is logged server-side only
    expect(JSON.stringify(res.body)).not.toMatch(/UTC|Etc\/GMT/)
  })
})

describe('catalog API', () => {
  let app: ReturnType<typeof appWith>

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`) // what a fresh Neon/RDS session gets from the migration
    await seedCatalog(prisma) // 5 products (2 inactive) + the expired DRAFT webinar
    const product = async (slug: string) => (await prisma.product.findUniqueOrThrow({ where: { slug } })).id
    const fixtures: [string, string, number, SessionStatus, Partial<{ capacity: number; endsAfterMs: number }>][] = [
      ['webinarSoon', 'monthly-webinar', 2 * DAY, SessionStatus.PUBLISHED, { capacity: 40, endsAfterMs: HOUR }],
      ['trainingNext', 'online-training', 9 * DAY, SessionStatus.PUBLISHED, { endsAfterMs: 4 * HOUR }],
      ['workshopLater', 'offline-workshop', 20 * DAY, SessionStatus.PUBLISHED, { capacity: 12, endsAfterMs: 4 * DAY }],
      ['webinarPast', 'monthly-webinar', -3 * DAY, SessionStatus.PUBLISHED, {}],
      ['webinarCancelled', 'monthly-webinar', 5 * DAY, SessionStatus.CANCELLED, {}],
      ['webinarDraft', 'monthly-webinar', 6 * DAY, SessionStatus.DRAFT, {}],
      ['inactiveProductSession', 'crash-course', 4 * DAY, SessionStatus.PUBLISHED, {}],
    ]
    for (const [key, slug, offset, status, extra] of fixtures) {
      const start = at(offset)
      const row = await prisma.session.create({
        data: {
          productId: await product(slug), startsAt: start, status, internalNote: `secret note ${key}`,
          ...(extra.capacity ? { capacity: extra.capacity } : {}),
          ...(extra.endsAfterMs ? { endsAt: new Date(start.getTime() + extra.endsAfterMs) } : {}),
        },
      })
      ids[key] = row.id
      startsAt[key] = start
    }
    app = appWith(prisma)
  }, 60_000)

  describe('GET /api/v1/products', () => {
    it('lists active products only, ordered by type then name, with exact prices', async () => {
      const res = await request(app).get('/api/v1/products')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=15') // Stage 4B: short, so admin changes show quickly
      expect(res.headers['x-request-id']).toBeTruthy()
      expect(res.body.data.map((p: { slug: string }) => p.slug)).toEqual(['online-training', 'offline-workshop', 'monthly-webinar'])
      expect(res.body.data.map((p: { price: unknown }) => p.price)).toEqual([
        { amount: '500.00', currency: 'USD' },
        { amount: '100000.00', currency: 'INR' },
        { amount: '149.00', currency: 'INR' },
      ])
    })

    it('returns exactly the documented public fields', async () => {
      const res = await request(app).get('/api/v1/products')
      expect(res.body).toEqual({ data: expect.any(Array) })
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['audience', 'description', 'durationLabel', 'id', 'name', 'price', 'slug', 'summary', 'type'])
      expect(res.body.data[0]).toMatchObject({
        slug: 'online-training', name: 'Online Training', type: 'ONLINE_TRAINING', durationLabel: '8 hours · 2 days',
        summary: 'Know everything about the Method — spread over 2 days.', id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      })
      expect(JSON.stringify(res.body)).not.toMatch(/isActive|createdAt|updatedAt|Crash Course|Detailed Training/)
    })

    it('filters by type', async () => {
      const res = await request(app).get('/api/v1/products?type=WEBINAR')
      expect(res.body.data.map((p: { slug: string }) => p.slug)).toEqual(['monthly-webinar'])
    })

    it.each([
      ['an unknown type', '?type=webinar', /type/],
      ['an unknown parameter', '?colour=green', /unknown query parameter\(s\): colour/],
      ['a repeated parameter', '?type=WEBINAR&type=WEBINAR', /type/],
    ])('rejects %s with 400', async (_label, query, message) => {
      const res = await request(app).get(`/api/v1/products${query}`)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'INVALID_QUERY', message: expect.stringMatching(message) })
    })
  })

  describe('GET /api/v1/products/:slug', () => {
    it('returns an active product', async () => {
      const res = await request(app).get('/api/v1/products/offline-workshop')
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ slug: 'offline-workshop', type: 'OFFLINE_WORKSHOP', price: { amount: '100000.00', currency: 'INR' } })
    })

    it.each(['crash-course', 'detailed-training', 'no-such-product'])('hides %s (inactive or unknown) with the same 404', async (slug) => {
      const res = await request(app).get(`/api/v1/products/${slug}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' })
    })

    it('rejects a malformed slug with 400', async () => {
      const res = await request(app).get('/api/v1/products/Online%20Training')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('INVALID_PATH')
    })
  })

  describe('GET /api/v1/sessions', () => {
    it('lists only published, upcoming sessions of active products, soonest first', async () => {
      const res = await request(app).get('/api/v1/sessions')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=15')
      expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([ids.webinarSoon, ids.trainingNext, ids.workshopLater])
      expect(res.body.meta).toMatchObject({ limit: 50, count: 3 })
      expect(Math.abs(Date.parse(res.body.meta.from) - Date.now())).toBeLessThan(60_000) // "now" on the server
    })

    it('excludes the expired seeded webinar, drafts, cancelled, past and inactive-product sessions', async () => {
      const body = JSON.stringify((await request(app).get('/api/v1/sessions')).body)
      for (const hidden of ['webinarPast', 'webinarCancelled', 'webinarDraft', 'inactiveProductSession']) expect(body).not.toContain(ids[hidden])
      expect(body).not.toContain('2026-10-13T13:00:00.000Z') // the Stage 2 DRAFT webinar
    })

    it('serializes instants as UTC ISO strings and never leaks internal fields', async () => {
      const res = await request(app).get('/api/v1/sessions')
      const first = res.body.data[0]
      expect(Object.keys(first).sort()).toEqual(['capacity', 'endsAt', 'id', 'product', 'startsAt', 'timezone', 'venue'])
      expect(Object.keys(first.product).sort()).toEqual(['id', 'name', 'price', 'slug', 'type'])
      expect(first).toEqual({
        id: ids.webinarSoon,
        startsAt: startsAt.webinarSoon!.toISOString(),
        endsAt: new Date(startsAt.webinarSoon!.getTime() + HOUR).toISOString(),
        timezone: 'Asia/Kolkata',
        capacity: 40,
        venue: null,
        product: { id: expect.any(String), slug: 'monthly-webinar', name: 'Monthly Webinar', type: 'WEBINAR', price: { amount: '149.00', currency: 'INR' } },
      })
      expect(first.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(res.body.data[1].capacity).toBeNull()
      expect(JSON.stringify(res.body)).not.toMatch(/secret note|internalNote|status|DRAFT|PUBLISHED/)
    })

    it('filters by type and by product', async () => {
      const byType = await request(app).get('/api/v1/sessions?type=WEBINAR')
      expect(byType.body.data.map((s: { id: string }) => s.id)).toEqual([ids.webinarSoon])
      const byProduct = await request(app).get('/api/v1/sessions?product=offline-workshop')
      expect(byProduct.body.data.map((s: { id: string }) => s.id)).toEqual([ids.workshopLater])
      const inactive = await request(app).get('/api/v1/sessions?product=crash-course')
      expect(inactive.body).toMatchObject({ data: [], meta: { count: 0 } })
    })

    it('treats `from` as an instant: the same moment written in UTC or IST gives the same result', async () => {
      const cutoff = new Date(startsAt.trainingNext!.getTime() - 60_000) // one minute before the training
      const ist = new Date(cutoff.getTime() + 5.5 * HOUR).toISOString().replace('Z', '+05:30')
      const utc = await request(app).get(`/api/v1/sessions?from=${encodeURIComponent(cutoff.toISOString())}`)
      const inIst = await request(app).get(`/api/v1/sessions?from=${encodeURIComponent(ist)}`)
      expect(utc.body.data.map((s: { id: string }) => s.id)).toEqual([ids.trainingNext, ids.workshopLater])
      expect(inIst.body.data).toEqual(utc.body.data)
      expect(inIst.body.meta.from).toBe(cutoff.toISOString())
    })

    it('can include past published sessions when asked with an earlier `from`', async () => {
      const res = await request(app).get(`/api/v1/sessions?from=${encodeURIComponent(at(-10 * DAY).toISOString())}&type=WEBINAR`)
      expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([ids.webinarPast, ids.webinarSoon])
    })

    it('respects limit', async () => {
      const res = await request(app).get('/api/v1/sessions?limit=1')
      expect(res.body.data).toHaveLength(1)
      expect(res.body.meta).toMatchObject({ limit: 1, count: 1 })
    })

    it('returns an empty list (200) when nothing is scheduled', async () => {
      const res = await request(app).get(`/api/v1/sessions?from=${encodeURIComponent(at(365 * DAY).toISOString())}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ data: [], meta: { from: expect.any(String), limit: 50, count: 0 } })
    })

    it.each([
      ['a local time without offset', '?from=2026-11-01T10:00:00', /from: must be an ISO 8601 instant/],
      ['a date only', '?from=2026-11-01', /from/],
      ['limit 0', '?limit=0', /limit/],
      ['limit 101', '?limit=101', /limit/],
      ['a non-numeric limit', '?limit=ten', /limit/],
      ['a malformed product slug', '?product=Bad_Slug', /product/],
      ['an unknown parameter', '?status=DRAFT', /unknown query parameter\(s\): status/],
    ])('rejects %s with 400', async (_label, query, message) => {
      const res = await request(app).get(`/api/v1/sessions${query}`)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'INVALID_QUERY', message: expect.stringMatching(message) })
    })
  })

  describe('GET /api/v1/sessions/:id', () => {
    it('returns a published session', async () => {
      const res = await request(app).get(`/api/v1/sessions/${ids.trainingNext}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ id: ids.trainingNext, startsAt: startsAt.trainingNext!.toISOString(), product: { slug: 'online-training', price: { amount: '500.00', currency: 'USD' } } })
      expect(JSON.stringify(res.body)).not.toContain('secret note')
    })

    it('returns a past published session (clients compare startsAt with the current time)', async () => {
      const res = await request(app).get(`/api/v1/sessions/${ids.webinarPast}`)
      expect(res.status).toBe(200)
      expect(Date.parse(res.body.data.startsAt)).toBeLessThan(Date.now())
    })

    it.each(['webinarDraft', 'webinarCancelled', 'inactiveProductSession'])('hides the %s session with 404', async (key) => {
      const res = await request(app).get(`/api/v1/sessions/${ids[key]}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'SESSION_NOT_FOUND', message: 'Session not found' })
    })

    it('hides the seeded DRAFT webinar and unknown ids with 404', async () => {
      const draft = await prisma.session.findFirstOrThrow({ where: { startsAt: new Date('2026-10-13T13:00:00.000Z') } })
      expect((await request(app).get(`/api/v1/sessions/${draft.id}`)).status).toBe(404)
      expect((await request(app).get('/api/v1/sessions/01990000-0000-7000-8000-000000000000')).status).toBe(404)
    })

    it('rejects a non-UUID id with 400', async () => {
      const res = await request(app).get('/api/v1/sessions/123')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'INVALID_PATH', message: expect.stringMatching(/id: must be a UUID/) })
    })
  })

  it('made no writes: catalog reads leave the data unchanged', async () => {
    expect(await prisma.product.count()).toBe(5)
    expect(await prisma.session.count()).toBe(8)
  })
})
