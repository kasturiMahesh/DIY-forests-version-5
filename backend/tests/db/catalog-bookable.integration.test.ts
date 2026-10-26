// Stage 3F: the public catalog's opt-in `bookable=true` filter must agree exactly with the booking API's
// 24-hour cutoff (bookings close at start - 24 hours, refused when now >= start - 24 hours). PGlite with
// all migrations; the catalog router gets a FIXED clock, so every boundary is deterministic.
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { seedCatalog } from '../../src/db/seed-catalog.js'
import { createAdminRepository } from '../../src/modules/admin/admin.repository.js'
import { BOOKING_CUTOFF_MS } from '../../src/modules/bookings/booking-holds.js'
import { createBookingRepository } from '../../src/modules/bookings/booking.repository.js'
import { createCatalogRepository } from '../../src/modules/catalog/catalog.repository.js'
import { catalogRouter } from '../../src/modules/catalog/catalog.routes.js'
import { HttpError } from '../../src/lib/http-error.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// A fixed "now" well in the future, so nothing else in the database interferes and no test depends on
// the real clock.
const NOW = new Date('2031-03-03T06:00:00.000Z')
const at = (offset: number) => new Date(NOW.getTime() + offset)

let database: TestDatabase
let prisma: PrismaClient
let app: express.Express
const ids: Record<string, string> = {}
let webinarProduct = ''

beforeAll(async () => {
  database = await startTestDatabase()
  await prismaCli(['migrate', 'deploy'], database.url)
  prisma = createPrismaClient(database.url, { maxConnections: 1 })
  await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
  await seedCatalog(prisma)
  webinarProduct = (await prisma.product.findUniqueOrThrow({ where: { slug: 'monthly-webinar' } })).id
  const trainingProduct = (await prisma.product.findUniqueOrThrow({ where: { slug: 'online-training' } })).id

  // Webinars around the cutoff boundary (NOW + 24h).
  const webinars: [string, number][] = [
    ['ended', -2 * DAY], ['started', -HOUR], ['inside', 23 * HOUR], ['exactlyAtCutoff', BOOKING_CUTOFF_MS],
    ['justOutside', BOOKING_CUTOFF_MS + 1], ['far', 10 * DAY],
  ]
  for (const [key, offset] of webinars) {
    ids[key] = (await prisma.session.create({
      data: { productId: webinarProduct, startsAt: at(offset), endsAt: new Date(at(offset).getTime() + HOUR), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity: 10 },
    })).id
  }
  // Online-training cohorts: closes 24 hours before the FIRST session.
  for (const [key, firstOffset] of [['cohortTooClose', 12 * HOUR], ['cohortOpen', 30 * HOUR]] as const) {
    const cohort = await prisma.trainingCohort.create({ data: { productId: trainingProduct, status: 'PUBLISHED', capacity: 10, timezone: 'Asia/Kolkata' } })
    for (const [sequence, offset] of [[1, firstOffset], [2, firstOffset + 7 * DAY]] as const) {
      await prisma.session.create({ data: { productId: trainingProduct, cohortId: cohort.id, cohortSequence: sequence, startsAt: at(offset), endsAt: new Date(at(offset).getTime() + 4 * HOUR), status: 'PUBLISHED', timezone: 'Asia/Kolkata' } })
    }
    ids[key] = cohort.id
  }

  app = express()
  app.use('/api/v1', catalogRouter(createCatalogRepository(prisma), () => NOW))
  app.use(((error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 500
    res.status(status).json({ error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' } })
  }) as express.ErrorRequestHandler)
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await database?.stop()
})

const webinarIds = async (query: string) => {
  const res = await request(app).get(`/api/v1/sessions?type=WEBINAR${query}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body.data as { id: string }[]).map((session) => session.id)
}

describe('GET /sessions?bookable=true', () => {
  it('lists only dates strictly after now + 24 hours: far and just-outside in, exactly-at-cutoff/inside/started/ended out', async () => {
    const listed = await webinarIds('&bookable=true')
    expect(listed).toEqual([ids.justOutside, ids.far])
  })

  it('the banner query (limit=1) returns the next BOOKABLE webinar, not an earlier one that is too close', async () => {
    expect(await webinarIds('&limit=1&bookable=true')).toEqual([ids.justOutside])
    // Before the fix the banner used this query and got a webinar the API refuses to book.
    expect(await webinarIds('&limit=1')).toEqual([ids.inside])
  })

  it('without bookable (or bookable=false) the listing is unchanged: every start from `from` onward', async () => {
    const expected = [ids.inside, ids.exactlyAtCutoff, ids.justOutside, ids.far]
    expect(await webinarIds('')).toEqual(expected)
    expect(await webinarIds('&bookable=false')).toEqual(expected)
    // An earlier `from` still returns past published sessions, as documented.
    expect(await webinarIds(`&from=${encodeURIComponent(at(-3 * DAY).toISOString())}`)).toEqual([ids.ended, ids.started, ...expected])
  })

  it('combines with `from`: the later of the two bounds applies', async () => {
    expect(await webinarIds(`&bookable=true&from=${encodeURIComponent(at(5 * DAY).toISOString())}`)).toEqual([ids.far])
  })

  it('an empty bookable result is a normal empty list', async () => {
    const res = await request(app).get(`/api/v1/sessions?type=WEBINAR&bookable=true&from=${encodeURIComponent(at(400 * DAY).toISOString())}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(res.body.meta.count).toBe(0)
  })

  it.each(['yes', '1', 'TRUE'])('rejects bookable=%s (400)', async (value) => {
    expect((await request(app).get(`/api/v1/sessions?bookable=${value}`)).status).toBe(400)
  })
})

describe('GET /cohorts?bookable=true', () => {
  it('uses the first session: a cohort starting in 12 hours is out, one in 30 hours is in', async () => {
    const res = await request(app).get('/api/v1/cohorts?product=online-training&bookable=true')
    expect(res.status).toBe(200)
    expect(res.body.data.map((cohort: { id: string }) => cohort.id)).toEqual([ids.cohortOpen])
    const all = await request(app).get('/api/v1/cohorts?product=online-training')
    expect(all.body.data.map((cohort: { id: string }) => cohort.id)).toEqual([ids.cohortTooClose, ids.cohortOpen])
  })
})

describe('agreement with the booking API and admin listings', () => {
  it('the booking API refuses exactly the dates the bookable listing hides, and accepts the ones it shows', async () => {
    const user = await prisma.user.create({ data: { identityPool: 'CUSTOMER', identityIssuer: 'test', identitySubject: 'bookable-check', email: 'bookable.check@example.test' } })
    const bookings = createBookingRepository(prisma, { confirmationMode: 'manual' })
    const book = (sessionId: string, key: string) => bookings.create(user.id, {
      productId: webinarProduct, target: { kind: 'session', id: sessionId }, contactName: 'Bookable Check',
      phone: { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }, idempotencyKey: `bookable-check-${key}`,
    }, { now: NOW, requestId: undefined })
    for (const hidden of ['exactlyAtCutoff', 'inside']) {
      await expect(book(ids[hidden]!, hidden)).rejects.toMatchObject({ code: 'BOOKING_CUTOFF_PASSED' })
    }
    await expect(book(ids.started!, 'started')).rejects.toMatchObject({ code: 'TARGET_STARTED' })
    const shown = await book(ids.justOutside!, 'justOutside')
    expect(shown.booking.status).toBe('AWAITING_CONFIRMATION')
  })

  it('admin session listings still include dates inside the cutoff (only the public bookable listing filters)', async () => {
    const admin = createAdminRepository(prisma)
    const listed = await admin.listSessions({ type: 'WEBINAR', from: at(0), to: at(2 * DAY) }, { page: 1, pageSize: 100 })
    const listedIds = listed.items.map((session) => session.id)
    expect(listedIds).toEqual(expect.arrayContaining([ids.inside, ids.exactlyAtCutoff, ids.justOutside]))
  })
})
