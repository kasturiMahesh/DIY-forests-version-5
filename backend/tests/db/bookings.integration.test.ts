// Stage 4C booking APIs, end to end over HTTP against PGlite (in-memory PostgreSQL compiled to WASM)
// with all migrations applied: real constraints, triggers and transactions, but ONE connection, so
// requests are serialized. These tests do NOT prove behaviour under real concurrent connections;
// see bookings.postgres-concurrency.test.ts, which runs only against a real PostgreSQL server.
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadEnv } from '../../src/config/env.js'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { seedCatalog } from '../../src/db/seed-catalog.js'
import { zonedTimeToInstant } from '../../src/lib/time.js'
import { createAdminRepository } from '../../src/modules/admin/admin.repository.js'
import { adminManagementRouter } from '../../src/modules/admin/admin.routes.js'
import { runAdminCommand } from '../../src/modules/auth/admin-cli.js'
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js'
import { DEV_ISSUERS } from '../../src/modules/auth/dev-provider.js'
import { createAuthModule } from '../../src/modules/auth/index.js'
import { hashSessionToken, newSessionToken } from '../../src/modules/auth/session.js'
import { createBookingRepository } from '../../src/modules/bookings/booking.repository.js'
import { adminBookingsRouter, customerBookingsRouter } from '../../src/modules/bookings/booking.routes.js'
import { createCatalogRepository } from '../../src/modules/catalog/catalog.repository.js'
import { csrfFor, devAuthConfig, PUBLIC_ORIGIN, signIn, withSession } from '../auth/helpers.js'
import { memoryLogger, type LoggedLine } from '../helpers.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

let database: TestDatabase
let prisma: PrismaClient
const env = loadEnv({ NODE_ENV: 'test' })
const config = devAuthConfig()
const DAY = 86_400_000
const lines: LoggedLine[] = []
let app: ReturnType<typeof createApp>

function buildApp() {
  const logger = memoryLogger(lines)
  const bookings = createBookingRepository(prisma)
  const auth = createAuthModule({
    config, logger, repository: createAuthRepository(prisma),
    adminManagement: adminManagementRouter(createAdminRepository(prisma)),
    adminBookings: adminBookingsRouter(bookings),
    customerBookings: customerBookingsRouter(bookings),
  })
  return createApp({ env, version: 'test', logger, catalog: createCatalogRepository(prisma), auth })
}

/** A real future Friday at 18:30 IST, at least `weeks` weeks from now. */
function fridayIst(weeks: number): Date {
  const ist = new Date(Date.now() + 5.5 * 3_600_000 + weeks * 7 * DAY)
  const daysToFriday = (5 - ist.getUTCDay() + 7) % 7 || 7
  const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysToFriday))
  return zonedTimeToInstant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 18, minute: 30 }, 'Asia/Kolkata')
}

type Who = { cookie: string; csrf: string; userId: string }
const people: Record<'admin' | 'asha' | 'ben' | 'chen', Who> = {} as never
const key = () => randomUUID()
const PHONE = { country: 'IN', number: '098765 43210' }

const as = (who: Who, method: 'get' | 'post' | 'patch', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const req = request(app)[method](`/api/v1${path}`).set('Cookie', who.cookie)
  if (method !== 'get') req.set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', who.csrf)
  for (const [name, value] of Object.entries(headers)) req.set(name, value)
  return body === undefined ? req : req.send(body as object)
}
const book = (who: Who, body: Record<string, unknown>, idempotencyKey: string | null = key()) =>
  as(who, 'post', '/me/bookings', { contactName: 'Asha Rao', phone: PHONE, ...body }, idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey })
const admin = (method: 'get' | 'post' | 'patch', path: string, body?: unknown) => as(people.admin, method, `/admin${path}`, body)

const products: Record<'webinar' | 'workshop' | 'training', string> = {} as never
const ids = { webinar: '', workshop: '', cohort: '', draftWebinar: '', cancelledWebinar: '', cohortSession: '' }
const seats = async (sessionId: string) => (await prisma.session.findUniqueOrThrow({ where: { id: sessionId } })).seatsHeld
const cohortSeats = async (cohortId: string) => (await prisma.trainingCohort.findUniqueOrThrow({ where: { id: cohortId } })).seatsHeld
const activeBookings = (where: { sessionId?: string; cohortId?: string }) => prisma.booking.count({ where: { ...where, status: 'PENDING_PAYMENT' } })

beforeAll(async () => {
  database = await startTestDatabase()
  await prismaCli(['migrate', 'deploy'], database.url) // all five migrations
  prisma = createPrismaClient(database.url, { maxConnections: 1 })
  // PGlite serves every connection from one backend session, which never picks up the migration's
  // database-level UTC default; set it explicitly (the repositories refuse to run otherwise).
  await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
  await seedCatalog(prisma)
  app = buildApp()

  await runAdminCommand(['grant', '--dev-identity', 'dev-admin-1'], { repository: createAuthRepository(prisma), authConfig: config, actorLabel: 'operator-cli:test', print: () => {} })
  const signed = async (pool: 'ADMIN' | 'CUSTOMER', subject: string): Promise<Who> => {
    const result = await signIn(app, config, { pool, subject })
    const userId = (await prisma.user.findFirstOrThrow({ where: { identitySubject: subject, identityPool: pool } })).id
    return { cookie: withSession(config, result.session!), csrf: await csrfFor(app, config, result.session!), userId }
  }
  people.admin = await signed('ADMIN', 'dev-admin-1')
  people.asha = await signed('CUSTOMER', 'dev-customer-1')
  people.ben = await signed('CUSTOMER', 'dev-customer-2')
  // The dev provider has only two customer identities; a third account is created through the same
  // repository calls the sign-in callback makes (issuer = the dev customer issuer, so it validates).
  const authRepository = createAuthRepository(prisma)
  const third = await authRepository.signInCustomer({ issuer: DEV_ISSUERS.CUSTOMER, subject: 'test-customer-3', email: 'test.customer.three@example.test', emailVerified: true, name: 'Test Customer Three' }, new Date())
  if (third.kind !== 'ok') throw new Error('third customer sign-in failed')
  const token = newSessionToken()
  await authRepository.createSession({ userId: third.user.id, kind: 'CUSTOMER', tokenHash: hashSessionToken(token), policy: config.policies.CUSTOMER, userAgent: null, now: new Date() })
  people.chen = { cookie: withSession(config, token), csrf: await csrfFor(app, config, token), userId: third.user.id }

  for (const [name, slug] of [['webinar', 'monthly-webinar'], ['workshop', 'offline-workshop'], ['training', 'online-training']] as const) {
    products[name] = (await prisma.product.findUniqueOrThrow({ where: { slug } })).id
  }
  const created = async (path: string, body: object) => {
    const res = await admin('post', path, body)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.data.id as string
  }
  const publish = async (path: string) => expect((await admin('post', `${path}/publish`)).status).toBe(200)
  const soon = new Date(Date.now() + 10 * DAY)

  ids.webinar = await created('/sessions', { productId: products.webinar, startsAt: soon.toISOString(), endsAt: new Date(soon.getTime() + 3_600_000).toISOString(), capacity: 2 })
  await publish(`/sessions/${ids.webinar}`)
  ids.draftWebinar = await created('/sessions', { productId: products.webinar, startsAt: new Date(soon.getTime() + DAY).toISOString(), capacity: 5 })
  ids.cancelledWebinar = await created('/sessions', { productId: products.webinar, startsAt: new Date(soon.getTime() + 2 * DAY).toISOString(), capacity: 5 })
  await publish(`/sessions/${ids.cancelledWebinar}`)
  expect((await admin('post', `/sessions/${ids.cancelledWebinar}/cancel`, {})).status).toBe(200)
  const workshopStart = new Date(Date.now() + 30 * DAY)
  ids.workshop = await created('/sessions', { productId: products.workshop, startsAt: workshopStart.toISOString(), endsAt: new Date(workshopStart.getTime() + 4 * DAY).toISOString(), venue: 'Afforestt Farm, Kashipur', capacity: 12 })
  await publish(`/sessions/${ids.workshop}`)
  const first = fridayIst(3)
  ids.cohort = await created('/cohorts', { productId: products.training, firstSessionStartsAt: first.toISOString(), capacity: 1 })
  await publish(`/cohorts/${ids.cohort}`)
  ids.cohortSession = (await prisma.session.findFirstOrThrow({ where: { cohortId: ids.cohort, cohortSequence: 1 } })).id
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await database?.stop()
})

describe('authentication and authorization', () => {
  it('customer booking routes need a session (401) and CSRF + Origin for writes (403)', async () => {
    expect((await request(app).get('/api/v1/me/bookings')).status).toBe(401)
    expect((await request(app).post('/api/v1/me/bookings').set('Origin', PUBLIC_ORIGIN).send({})).status).toBe(401)
    const noCsrf = await request(app).post('/api/v1/me/bookings').set('Cookie', people.asha.cookie).set('Origin', PUBLIC_ORIGIN).set('Idempotency-Key', key()).send({})
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED')
    const badOrigin = await request(app).post('/api/v1/me/bookings').set('Cookie', people.asha.cookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', people.asha.csrf).send({})
    expect(badOrigin.body.error.code).toBe('CSRF_FAILED')
    expect(await prisma.booking.count()).toBe(0)
  })

  it.each([['get', '/admin/bookings'], ['get', `/admin/bookings/${randomUUID()}`], ['post', `/admin/bookings/${randomUUID()}/cancel`]] as const)('%s %s → 401 signed out, 403 for a customer', async (method, path) => {
    expect((await request(app)[method](`/api/v1${path}`).set('Origin', PUBLIC_ORIGIN).send({})).status).toBe(401)
    const res = await as(people.asha, method, path, method === 'post' ? { reason: 'test reason' } : undefined)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('staff (admin-pool) sessions cannot book or list bookings as a customer', async () => {
    const res = await book(people.admin, { productId: products.webinar, sessionId: ids.webinar })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('CUSTOMER_ACCOUNT_REQUIRED')
    expect((await as(people.admin, 'get', '/me/bookings')).body.error.code).toBe('CUSTOMER_ACCOUNT_REQUIRED')
    expect(await prisma.booking.count()).toBe(0)
  })

  it('responses are never cached', async () => {
    expect((await as(people.asha, 'get', '/me/bookings')).headers['cache-control']).toBe('no-store')
    expect((await admin('get', '/bookings')).headers['cache-control']).toBe('no-store')
  })
})

describe('request validation', () => {
  it.each([
    ['no Idempotency-Key', null, {}, 'IDEMPOTENCY_KEY_REQUIRED'],
    ['a malformed Idempotency-Key', 'short', {}, 'IDEMPOTENCY_KEY_INVALID'],
    ['both a session and a cohort', undefined, { cohortId: 'COHORT' }, 'INVALID_REQUEST'],
    ['no target', undefined, { sessionId: undefined }, 'INVALID_REQUEST'],
    ['a client-supplied price', undefined, { price: { amount: '1.00', currency: 'INR' } }, 'INVALID_REQUEST'],
    ['a client-supplied status', undefined, { status: 'PAID' }, 'INVALID_REQUEST'],
    ['an invalid phone number', undefined, { phone: { country: 'IN', number: '12345' } }, 'PHONE_INVALID'],
    ['an unsupported phone country', undefined, { phone: { country: 'BR', number: '11912345678' } }, 'PHONE_COUNTRY_UNSUPPORTED'],
    ['a blank contact name', undefined, { contactName: ' ' }, 'INVALID_REQUEST'],
  ] as const)('400 for %s, and nothing is reserved', async (_label, idempotencyKey, override, code) => {
    const body: Record<string, unknown> = { productId: products.webinar, sessionId: ids.webinar, ...override }
    if (body.cohortId === 'COHORT') body.cohortId = ids.cohort
    const res = await book(people.asha, body, idempotencyKey === undefined ? key() : idempotencyKey)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(code)
    expect(JSON.stringify(res.body)).not.toContain('12345')
    expect(await seats(ids.webinar)).toBe(0)
  })

  it('400 for a malformed booking id; 404 for an unknown one', async () => {
    expect((await as(people.asha, 'get', '/me/bookings/not-a-uuid')).body.error.code).toBe('INVALID_PATH')
    expect((await as(people.asha, 'get', `/me/bookings/${randomUUID()}`)).body.error.code).toBe('BOOKING_NOT_FOUND')
  })
})

describe('product and target rules', () => {
  it.each([
    ['webinar product with a cohort', () => ({ productId: products.webinar, cohortId: ids.cohort }), 400, 'TARGET_TYPE_MISMATCH'],
    ['online training with a session', () => ({ productId: products.training, sessionId: ids.webinar }), 400, 'TARGET_TYPE_MISMATCH'],
    ['online training with one of its cohort sessions', () => ({ productId: products.training, sessionId: ids.cohortSession }), 400, 'TARGET_TYPE_MISMATCH'],
    ['webinar product with a cohort session', () => ({ productId: products.webinar, sessionId: ids.cohortSession }), 400, 'TARGET_TYPE_MISMATCH'],
    ['webinar product with a workshop batch', () => ({ productId: products.webinar, sessionId: ids.workshop }), 400, 'TARGET_PRODUCT_MISMATCH'],
    ['workshop product with a webinar session', () => ({ productId: products.workshop, sessionId: ids.webinar }), 400, 'TARGET_PRODUCT_MISMATCH'],
    ['a draft session', () => ({ productId: products.webinar, sessionId: ids.draftWebinar }), 409, 'TARGET_NOT_BOOKABLE'],
    ['a cancelled session', () => ({ productId: products.webinar, sessionId: ids.cancelledWebinar }), 409, 'TARGET_NOT_BOOKABLE'],
    ['an unknown session', () => ({ productId: products.webinar, sessionId: randomUUID() }), 404, 'SESSION_NOT_FOUND'],
    ['an unknown cohort', () => ({ productId: products.training, cohortId: randomUUID() }), 404, 'COHORT_NOT_FOUND'],
    ['an unknown product', () => ({ productId: randomUUID(), sessionId: ids.webinar }), 404, 'PRODUCT_NOT_FOUND'],
  ])('%s → %i %s', async (_label, body, status, code) => {
    const res = await book(people.asha, body())
    expect(res.status).toBe(status)
    expect(res.body.error.code).toBe(code)
    expect(await prisma.booking.count()).toBe(0)
  })

  it('a session that has already started cannot be booked', async () => {
    // Moved into the past directly in the database: the admin API rightly refuses past starts.
    const past = await prisma.session.create({ data: { productId: products.webinar, startsAt: new Date(Date.now() - 60_000), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity: 5 } })
    const res = await book(people.asha, { productId: products.webinar, sessionId: past.id })
    expect(res.body.error.code).toBe('TARGET_STARTED')
  })

  it('a published workshop without its venue or end date is not bookable', async () => {
    const incomplete = await prisma.session.create({ data: { productId: products.workshop, startsAt: new Date(Date.now() + 40 * DAY), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity: 5 } })
    expect((await book(people.asha, { productId: products.workshop, sessionId: incomplete.id })).body.error.code).toBe('TARGET_NOT_BOOKABLE')
  })

  it('inactive and retired (archived) offerings cannot be booked', async () => {
    const retired = await prisma.product.create({ data: { slug: 'crash-course', name: 'Crash Course', type: 'WEBINAR', priceAmount: '99', currency: 'INR', isActive: false, archivedAt: new Date() } })
    const session = await prisma.session.create({ data: { productId: retired.id, startsAt: new Date(Date.now() + 5 * DAY), timezone: 'Asia/Kolkata', status: 'PUBLISHED' } })
    expect((await book(people.asha, { productId: retired.id, sessionId: session.id })).body.error.code).toBe('PRODUCT_UNAVAILABLE')
    expect(await prisma.booking.count()).toBe(0)
  })
})

let ashaWebinarId = ''
const ashaWebinarKey = key()

describe('creating bookings', () => {
  it('webinar: 201 PENDING_PAYMENT with price/name snapshots, normalized phone, a seat held and an audit event', async () => {
    const res = await book(people.asha, { productId: products.webinar, sessionId: ids.webinar }, ashaWebinarKey)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const booking = res.body.data
    ashaWebinarId = booking.id
    expect(booking).toMatchObject({
      status: 'PENDING_PAYMENT', reference: expect.stringMatching(/^DF-[0-9A-Z]{8}$/),
      product: { id: products.webinar, slug: 'monthly-webinar', type: 'WEBINAR', name: 'Monthly Webinar' },
      // Exactly the configured price: no GST or other tax is added.
      price: { amount: '149.00', currency: 'INR' },
      target: { kind: 'session', id: ids.webinar, timezone: 'Asia/Kolkata', status: 'PUBLISHED' },
      contact: { name: 'Asha Rao', phone: { country: 'IN', dialingCode: '91', nationalNumber: '9876543210', e164: '+919876543210' } },
      cancellation: null, canCancel: true,
    })
    expect(booking).not.toHaveProperty('idempotencyKey')
    expect(booking).not.toHaveProperty('userId')
    expect(await seats(ids.webinar)).toBe(1)
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'BOOKING_CREATED', targetId: booking.id } })
    expect(audit).toMatchObject({ actorUserId: people.asha.userId, actorLabel: 'self', targetType: 'booking', requestId: expect.any(String) })
    expect(JSON.stringify(audit.details)).not.toContain('9876543210') // no phone numbers in the audit trail
  })

  it('the public catalog shows the server-computed seats left', async () => {
    const res = await request(app).get(`/api/v1/sessions/${ids.webinar}`)
    expect(res.body.data).toMatchObject({ capacity: 2, seatsAvailable: 1 })
  })

  it('a retry with the same Idempotency-Key returns the same booking (200, replayed) and holds no extra seat', async () => {
    const res = await book(people.asha, { productId: products.webinar, sessionId: ids.webinar }, ashaWebinarKey)
    expect(res.status).toBe(200)
    expect(res.headers['idempotent-replayed']).toBe('true')
    expect(res.body.data.id).toBe(ashaWebinarId)
    expect(await seats(ids.webinar)).toBe(1)
    expect(await prisma.booking.count({ where: { userId: people.asha.userId } })).toBe(1)
  })

  it('the same key with a different booking is refused (409), not silently replayed', async () => {
    const res = await book(people.asha, { productId: products.workshop, sessionId: ids.workshop }, ashaWebinarKey)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(await seats(ids.workshop)).toBe(0)
  })

  it('the same key from another customer is a separate booking (keys are per customer)', async () => {
    const res = await book(people.ben, { productId: products.webinar, sessionId: ids.webinar, contactName: 'Ben Ode' }, ashaWebinarKey)
    expect(res.status).toBe(201)
    expect(res.body.data.id).not.toBe(ashaWebinarId)
    expect(await seats(ids.webinar)).toBe(2)
  })

  it('a second active booking for the same dates (new key) is refused', async () => {
    const res = await book(people.asha, { productId: products.webinar, sessionId: ids.webinar })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ALREADY_BOOKED')
  })

  it('capacity exhaustion: the next customer gets SOLD_OUT and the counter stays at capacity', async () => {
    const res = await book(people.chen, { productId: products.webinar, sessionId: ids.webinar, contactName: 'Chen Li' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('SOLD_OUT')
    expect(await seats(ids.webinar)).toBe(2)
    expect(await activeBookings({ sessionId: ids.webinar })).toBe(2)
    expect((await request(app).get(`/api/v1/sessions/${ids.webinar}`)).body.data.seatsAvailable).toBe(0)
  })

  it('online training: one booking for the cohort (both Fridays), USD 500', async () => {
    const res = await book(people.asha, { productId: products.training, cohortId: ids.cohort })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const { target, price } = res.body.data
    expect(price).toEqual({ amount: '500.00', currency: 'USD' })
    expect(target.kind).toBe('cohort')
    expect(target.sessions).toHaveLength(2)
    expect(Date.parse(target.sessions[1].startsAt) - Date.parse(target.sessions[0].startsAt)).toBe(7 * DAY)
    expect(await cohortSeats(ids.cohort)).toBe(1)
    // The cohort's sessions never hold seats themselves.
    expect(await seats(ids.cohortSession)).toBe(0)
    expect((await book(people.ben, { productId: products.training, cohortId: ids.cohort })).body.error.code).toBe('SOLD_OUT')
  })

  it('offline workshop: INR 100,000 with the batch venue and end date', async () => {
    const res = await book(people.ben, { productId: products.workshop, sessionId: ids.workshop, phone: { country: 'US', number: '(202) 555-0123' } })
    expect(res.status).toBe(201)
    expect(res.body.data.price).toEqual({ amount: '100000.00', currency: 'INR' })
    expect(res.body.data.target).toMatchObject({ venue: 'Afforestt Farm, Kashipur', endsAt: expect.any(String) })
    expect(res.body.data.contact.phone.e164).toBe('+12025550123')
  })

  it('later price and name changes never alter existing bookings', async () => {
    expect((await admin('patch', `/products/${products.webinar}`, { name: 'Monthly Webinar (new)', price: { amount: '199', currency: 'INR' } })).status).toBe(200)
    const res = await as(people.asha, 'get', `/me/bookings/${ashaWebinarId}`)
    expect(res.body.data.price).toEqual({ amount: '149.00', currency: 'INR' })
    expect(res.body.data.product.name).toBe('Monthly Webinar')
    await admin('patch', `/products/${products.webinar}`, { name: 'Monthly Webinar', price: { amount: '149', currency: 'INR' } })
  })

  it('stored rows match the schema rules (price snapshot, E.164 built from its parts)', async () => {
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: ashaWebinarId } })
    expect(row).toMatchObject({ priceAmount: expect.anything(), currency: 'INR', phoneCountry: 'IN', phoneDialingCode: '91', phoneNational: '9876543210', phoneE164: '+919876543210', idempotencyKey: ashaWebinarKey })
    expect(row.priceAmount.toFixed(2)).toBe('149.00')
  })
})

describe('ownership', () => {
  it('lists only the signed-in customer’s bookings, newest first, with pagination', async () => {
    const res = await as(people.asha, 'get', '/me/bookings?pageSize=1')
    expect(res.status).toBe(200)
    expect(res.body.meta).toEqual({ page: 1, pageSize: 1, total: 2 })
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].product.type).toBe('ONLINE_TRAINING') // newest first
    const all = await as(people.asha, 'get', '/me/bookings')
    expect(all.body.data.map((b: { id: string }) => b.id)).toContain(ashaWebinarId)
    expect((await as(people.asha, 'get', '/me/bookings?status=PAID')).body.error.code).toBe('INVALID_QUERY')
    expect((await as(people.asha, 'get', '/me/bookings?userId=x')).body.error.code).toBe('INVALID_QUERY')
  })

  it('another customer can neither read nor cancel it (404, existence not revealed)', async () => {
    expect((await as(people.ben, 'get', `/me/bookings/${ashaWebinarId}`)).status).toBe(404)
    const cancel = await as(people.ben, 'post', `/me/bookings/${ashaWebinarId}/cancel`, {})
    expect(cancel.status).toBe(404)
    expect(cancel.body.error.code).toBe('BOOKING_NOT_FOUND')
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: ashaWebinarId } })).status).toBe('PENDING_PAYMENT')
    expect((await as(people.ben, 'get', '/me/bookings')).body.data.map((b: { id: string }) => b.id)).not.toContain(ashaWebinarId)
  })
})

describe('admin capacity safety', () => {
  it('capacity cannot drop below the seats held; equal is fine; the audit trail is untouched by refusals', async () => {
    const before = await prisma.auditEvent.count()
    const res = await admin('patch', `/sessions/${ids.webinar}`, { capacity: 1 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CAPACITY_BELOW_HELD')
    expect(await prisma.auditEvent.count()).toBe(before)
    expect((await admin('patch', `/sessions/${ids.webinar}`, { capacity: 2 })).status).toBe(200)
    expect((await admin('patch', `/cohorts/${ids.cohort}`, { capacity: null })).body.data.capacity).toBeNull() // no limit is always ≥ held
    expect((await admin('patch', `/cohorts/${ids.cohort}`, { capacity: 1 })).status).toBe(200)
  })

  it('admin views show seatsHeld', async () => {
    expect((await admin('get', `/sessions/${ids.webinar}`)).body.data).toMatchObject({ capacity: 2, seatsHeld: 2 })
    expect((await admin('get', `/cohorts/${ids.cohort}`)).body.data).toMatchObject({ capacity: 1, seatsHeld: 1 })
  })

  it('the database CHECK enforces it too, even if the application check were bypassed', async () => {
    await expect(prisma.session.update({ where: { id: ids.webinar }, data: { capacity: 1 } })).rejects.toThrow(/sessions_seats_held_within_capacity/)
    await expect(prisma.trainingCohort.update({ where: { id: ids.cohort }, data: { seatsHeld: 5 } })).rejects.toThrow(/training_cohorts_seats_held_within_capacity/)
  })

  it('booked sessions and cohorts cannot be rescheduled or cancelled out from under customers', async () => {
    const later = Date.now() + 12 * DAY
    const moved = await admin('patch', `/sessions/${ids.webinar}`, { startsAt: new Date(later).toISOString(), endsAt: new Date(later + 3_600_000).toISOString() })
    expect(moved.body.error.code).toBe('HAS_ACTIVE_BOOKINGS')
    expect((await admin('patch', `/sessions/${ids.workshop}`, { venue: 'Somewhere else' })).body.error.code).toBe('HAS_ACTIVE_BOOKINGS')
    expect((await admin('post', `/sessions/${ids.webinar}/cancel`, {})).body.error.code).toBe('HAS_ACTIVE_BOOKINGS')
    expect((await admin('patch', `/cohorts/${ids.cohort}`, { firstSessionStartsAt: fridayIst(5).toISOString() })).body.error.code).toBe('HAS_ACTIVE_BOOKINGS')
    expect((await admin('post', `/cohorts/${ids.cohort}/cancel`, {})).body.error.code).toBe('HAS_ACTIVE_BOOKINGS')
    // Non-schedule edits are still allowed.
    expect((await admin('patch', `/sessions/${ids.webinar}`, { internalNote: 'two booked' })).status).toBe(200)
  })
})

describe('customer cancellation', () => {
  it('cancels the customer’s own pending booking, releases the seat and records who and why', async () => {
    const res = await as(people.asha, 'post', `/me/bookings/${ashaWebinarId}/cancel`, { reason: 'Cannot attend' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', canCancel: false, cancellation: { by: 'CUSTOMER', reason: 'Cannot attend', at: expect.any(String) } })
    expect(await seats(ids.webinar)).toBe(1)
    expect(await prisma.auditEvent.count({ where: { action: 'BOOKING_CANCELLED', targetId: ashaWebinarId, actorUserId: people.asha.userId } })).toBe(1)
  })

  it('a second cancellation is refused and releases nothing', async () => {
    const res = await as(people.asha, 'post', `/me/bookings/${ashaWebinarId}/cancel`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BOOKING_NOT_CANCELLABLE')
    expect(await seats(ids.webinar)).toBe(1)
  })

  it('the freed seat can be booked again, and the cancelled booking stays in history', async () => {
    expect((await book(people.chen, { productId: products.webinar, sessionId: ids.webinar, contactName: 'Chen Li' })).status).toBe(201)
    expect(await seats(ids.webinar)).toBe(2)
    const history = await as(people.asha, 'get', '/me/bookings?status=CANCELLED')
    expect(history.body.data.map((b: { id: string }) => b.id)).toEqual([ashaWebinarId])
  })

  it('a booking whose dates have started can no longer be cancelled by the customer', async () => {
    const session = await prisma.session.create({ data: { productId: products.webinar, startsAt: new Date(Date.now() + 5 * DAY), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity: 5 } })
    const created = await book(people.ben, { productId: products.webinar, sessionId: session.id })
    expect(created.status).toBe(201)
    await prisma.session.update({ where: { id: session.id }, data: { startsAt: new Date(Date.now() - 60_000) } })
    const res = await as(people.ben, 'post', `/me/bookings/${created.body.data.id}/cancel`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BOOKING_NOT_CANCELLABLE')
    expect((await as(people.ben, 'get', `/me/bookings/${created.body.data.id}`)).body.data.canCancel).toBe(false)
    expect(await seats(session.id)).toBe(1)
  })
})

describe('admin bookings', () => {
  it('lists bookings with filters and pagination, without phone numbers', async () => {
    const res = await admin('get', `/bookings?productId=${products.webinar}&pageSize=2`)
    expect(res.status).toBe(200)
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 2 })
    expect(res.body.meta.total).toBeGreaterThanOrEqual(3)
    expect(res.body.data[0]).toMatchObject({ customer: { email: expect.any(String) }, contactName: expect.any(String) })
    expect(JSON.stringify(res.body)).not.toMatch(/e164|nationalNumber|\+91|9876543210/)
    const cancelled = await admin('get', '/bookings?status=CANCELLED')
    expect(cancelled.body.data.map((b: { id: string }) => b.id)).toEqual([ashaWebinarId])
    const byReference = await admin('get', `/bookings?q=${cancelled.body.data[0].reference.toLowerCase()}`)
    expect(byReference.body.data.map((b: { id: string }) => b.id)).toEqual([ashaWebinarId])
    expect((await admin('get', `/bookings?cohortId=${ids.cohort}`)).body.meta.total).toBe(1)
    expect((await admin('get', '/bookings?status=PAID')).body.error.code).toBe('INVALID_QUERY')
  })

  it('shows the contact phone on the detail view only', async () => {
    const res = await admin('get', `/bookings/${ashaWebinarId}`)
    expect(res.body.data.contact.phone.e164).toBe('+919876543210')
    expect(res.body.data.customer).toEqual({ id: people.asha.userId, email: expect.any(String), displayName: expect.any(String) })
    expect((await admin('get', `/bookings/${randomUUID()}`)).body.error.code).toBe('BOOKING_NOT_FOUND')
  })

  it('cancelling needs a reason, releases the seat and is audited', async () => {
    const target = (await prisma.booking.findFirstOrThrow({ where: { cohortId: ids.cohort, status: 'PENDING_PAYMENT' } })).id
    expect((await admin('post', `/bookings/${target}/cancel`, {})).body.error.code).toBe('INVALID_REQUEST')
    expect((await admin('post', `/bookings/${target}/cancel`, { reason: ' ' })).body.error.code).toBe('INVALID_REQUEST')
    const res = await admin('post', `/bookings/${target}/cancel`, { reason: 'Trainer unavailable' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', canCancel: false, cancellation: { by: 'ADMIN', reason: 'Trainer unavailable' } })
    expect(await cohortSeats(ids.cohort)).toBe(0)
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'BOOKING_CANCELLED', targetId: target } })
    expect(audit).toMatchObject({ actorUserId: people.admin.userId, actorLabel: 'admin', details: expect.objectContaining({ by: 'ADMIN', reason: 'Trainer unavailable' }) })
    expect((await admin('post', `/bookings/${target}/cancel`, { reason: 'again' })).body.error.code).toBe('BOOKING_NOT_CANCELLABLE')
    // The customer sees the admin's reason.
    expect((await as(people.asha, 'get', `/me/bookings/${target}`)).body.data.cancellation.reason).toBe('Trainer unavailable')
    // With no active bookings left, the cohort can be rescheduled again.
    expect((await admin('patch', `/cohorts/${ids.cohort}`, { firstSessionStartsAt: fridayIst(5).toISOString() })).status).toBe(200)
  })

  it('the dashboard reports real booking counts', async () => {
    const res = await admin('get', '/dashboard')
    expect(res.body.data.bookings).toEqual({ pendingPayment: await prisma.booking.count({ where: { status: 'PENDING_PAYMENT' } }), cancelled: 2 })
  })
})

describe('deactivation keeps history', () => {
  it('a deactivated product keeps its bookings visible and refuses new ones', async () => {
    expect((await admin('post', `/products/${products.workshop}/deactivate`)).status).toBe(200)
    const history = await as(people.ben, 'get', '/me/bookings')
    expect(history.body.data.some((b: { product: { type: string }; status: string }) => b.product.type === 'OFFLINE_WORKSHOP' && b.status === 'PENDING_PAYMENT')).toBe(true)
    expect((await book(people.chen, { productId: products.workshop, sessionId: ids.workshop })).body.error.code).toBe('PRODUCT_UNAVAILABLE')
    expect((await admin('get', `/bookings?productId=${products.workshop}`)).body.meta.total).toBe(1)
    await admin('post', `/products/${products.workshop}/activate`)
  })

  it('a product with bookings can never be deleted (foreign key RESTRICT)', async () => {
    await expect(prisma.product.delete({ where: { id: products.workshop } })).rejects.toThrow()
    await expect(prisma.session.delete({ where: { id: ids.workshop } })).rejects.toThrow()
  })
})

describe('transaction rollback (real database failure inside the transaction)', () => {
  // A temporary trigger makes the audit insert — the LAST statement of each transaction — fail,
  // so the booking insert and the seat-counter trigger have already run when the error occurs.
  const failAudits = (action: string) => prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_fail_audit();`)
  const restore = () => prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_audit ON audit_events; DROP FUNCTION IF EXISTS test_fail_audit();')

  it('a failed booking leaves no booking row and no held seat, and logs no customer data', async () => {
    const session = await prisma.session.create({ data: { productId: products.webinar, startsAt: new Date(Date.now() + 6 * DAY), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity: 3 } })
    await failAudits('BOOKING_CREATED')
    const logged = lines.length
    try {
      const res = await book(people.chen, { productId: products.webinar, sessionId: session.id })
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('BOOKINGS_UNAVAILABLE')
      expect(JSON.stringify(res.body)).not.toMatch(/injected|audit|SQLSTATE/)
    } finally {
      await restore()
    }
    expect(await prisma.booking.count({ where: { sessionId: session.id } })).toBe(0)
    expect(await seats(session.id)).toBe(0)
    const newLines = JSON.stringify(lines.slice(logged))
    expect(newLines).toContain('Unhandled error')
    expect(newLines).not.toMatch(/9876543210|Asha Rao|Failing row/)
    // And the same request succeeds once the failure is gone.
    expect((await book(people.chen, { productId: products.webinar, sessionId: session.id })).status).toBe(201)
    expect(await seats(session.id)).toBe(1)
  })

  it('a failed cancellation leaves the booking pending and its seat held', async () => {
    const booking = await prisma.booking.findFirstOrThrow({ where: { userId: people.chen.userId, status: 'PENDING_PAYMENT', sessionId: ids.webinar } })
    await failAudits('BOOKING_CANCELLED')
    try {
      expect((await as(people.chen, 'post', `/me/bookings/${booking.id}/cancel`, {})).status).toBe(503)
      expect((await admin('post', `/bookings/${booking.id}/cancel`, { reason: 'Testing rollback' })).status).toBe(503)
    } finally {
      await restore()
    }
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('PENDING_PAYMENT')
    expect(await seats(ids.webinar)).toBe(2)
  })
})

describe('serialized competing requests (PGlite: one connection — NOT a real concurrency test)', () => {
  it('two simultaneous requests for the last seat: exactly one booking, counter = capacity', async () => {
    const session = await prisma.session.create({ data: { productId: products.webinar, startsAt: new Date(Date.now() + 7 * DAY), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity: 1 } })
    const results = await Promise.all([people.asha, people.ben].map((who) => book(who, { productId: products.webinar, sessionId: session.id })))
    expect(results.map((res) => res.status).sort()).toEqual([201, 409])
    expect(results.find((res) => res.status === 409)!.body.error.code).toBe('SOLD_OUT')
    expect(await seats(session.id)).toBe(1)
    expect(await activeBookings({ sessionId: session.id })).toBe(1)
  })

  it('the same submission sent twice at once creates one booking', async () => {
    const session = await prisma.session.create({ data: { productId: products.webinar, startsAt: new Date(Date.now() + 8 * DAY), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity: 5 } })
    const sameKey = key()
    const results = await Promise.all([0, 1].map(() => book(people.asha, { productId: products.webinar, sessionId: session.id }, sameKey)))
    expect(results.map((res) => res.status).sort()).toEqual([200, 201])
    expect(new Set(results.map((res) => res.body.data.id)).size).toBe(1)
    expect(await seats(session.id)).toBe(1)
  })
})

describe('booking table invariants (database level)', () => {
  it('counters equal the number of active bookings for every session and cohort', async () => {
    const sessions = await prisma.session.findMany({ select: { id: true, seatsHeld: true, cohortId: true } })
    for (const session of sessions) expect(session.seatsHeld, session.id).toBe(session.cohortId ? 0 : await activeBookings({ sessionId: session.id }))
    const cohorts = await prisma.trainingCohort.findMany({ select: { id: true, seatsHeld: true } })
    for (const cohort of cohorts) expect(cohort.seatsHeld, cohort.id).toBe(await activeBookings({ cohortId: cohort.id }))
  })

  it('immutable fields and reinstatement are blocked by the trigger', async () => {
    await expect(prisma.booking.update({ where: { id: ashaWebinarId }, data: { priceAmount: '1' } })).rejects.toThrow(/cannot change/)
    await expect(prisma.booking.update({ where: { id: ashaWebinarId }, data: { status: 'PENDING_PAYMENT', cancelledAt: null, cancelledBy: null, cancelReason: null } })).rejects.toThrow(/cannot be reinstated/)
  })
})
