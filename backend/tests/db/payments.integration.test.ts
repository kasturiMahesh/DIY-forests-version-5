// Stage 2 payment simulator, end to end over HTTP against PGlite (in-memory PostgreSQL compiled to WASM)
// with all migrations applied: real constraints, triggers and transactions, but ONE connection, so
// requests are serialized. Races between real connections are covered (when a disposable server is
// available) by bookings.postgres-concurrency.test.ts. The clock is injected so the 30-minute payment
// hold can be crossed without waiting.
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadEnv } from '../../src/config/env.js'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { seedCatalog } from '../../src/db/seed-catalog.js'
import { createAdminRepository } from '../../src/modules/admin/admin.repository.js'
import { adminManagementRouter } from '../../src/modules/admin/admin.routes.js'
import { runAdminCommand } from '../../src/modules/auth/admin-cli.js'
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js'
import { DEV_ISSUERS } from '../../src/modules/auth/dev-provider.js'
import { createAuthModule } from '../../src/modules/auth/index.js'
import { hashSessionToken, newSessionToken } from '../../src/modules/auth/session.js'
import { EXPIRY_REASON, PAYMENT_HOLD_MS } from '../../src/modules/bookings/booking-holds.js'
import { createBookingRepository, SIMULATED_CONFIRMATION_NOTICE, type BookingRepository } from '../../src/modules/bookings/booking.repository.js'
import { adminBookingsRouter, customerBookingsRouter } from '../../src/modules/bookings/booking.routes.js'
import { createCatalogRepository } from '../../src/modules/catalog/catalog.repository.js'
import { createPaymentRepository } from '../../src/modules/payments/payment.repository.js'
import { customerPaymentsRouter } from '../../src/modules/payments/payment.routes.js'
import { csrfFor, devAuthConfig, PUBLIC_ORIGIN, signIn, withSession } from '../auth/helpers.js'
import { memoryLogger } from '../helpers.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

let database: TestDatabase
let prisma: PrismaClient
let bookings: BookingRepository
const env = loadEnv({ NODE_ENV: 'test' })
const config = devAuthConfig()
const DAY = 86_400_000
const MINUTE = 60_000

// Injected clock: tests move it forward to cross payment deadlines.
let skew = 0
const clock = () => new Date(Date.now() + skew)

type AppOptions = { simulator?: boolean; nodeEnv?: () => string | undefined }
function buildApp({ simulator = true, nodeEnv }: AppOptions = {}) {
  const logger = memoryLogger()
  const payments = createPaymentRepository(prisma, bookings)
  const auth = createAuthModule({
    config, logger, repository: createAuthRepository(prisma),
    adminManagement: adminManagementRouter(createAdminRepository(prisma)),
    adminBookings: adminBookingsRouter(bookings, clock),
    customerBookings: customerBookingsRouter(bookings, clock, customerPaymentsRouter(payments, { simulator, now: clock, ...(nodeEnv ? { nodeEnv } : {}) })),
  })
  const catalog = createCatalogRepository(prisma, { beforeAvailabilityRead: async () => { await bookings.expireOverdue(clock()) } })
  return createApp({ env, version: 'test', logger, catalog, auth, paymentSimulator: simulator })
}
let app: ReturnType<typeof buildApp>

type Who = { cookie: string; csrf: string; userId: string }
const people: Record<'admin' | 'asha' | 'ben' | 'chen', Who> = {} as never
const key = () => randomUUID()
const PHONE = { country: 'IN', number: '098765 43210' }

const as = (target: ReturnType<typeof buildApp>, who: Who, method: 'get' | 'post', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const req = request(target)[method](`/api/v1${path}`).set('Cookie', who.cookie)
  if (method !== 'get') req.set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', who.csrf)
  for (const [name, value] of Object.entries(headers)) req.set(name, value)
  return body === undefined ? req : req.send(body as object)
}
const call = (who: Who, method: 'get' | 'post', path: string, body?: unknown, headers?: Record<string, string>) => as(app, who, method, path, body, headers)
const startPayment = (who: Who, bookingId: string, idempotencyKey: string = key(), target = app) =>
  as(target, who, 'post', `/me/bookings/${bookingId}/payment-attempts`, {}, { 'Idempotency-Key': idempotencyKey })
const simulate = (who: Who, bookingId: string, attemptId: string, outcome: 'SUCCEEDED' | 'FAILED') =>
  call(who, 'post', `/me/bookings/${bookingId}/payment-attempts/${attemptId}/simulate`, { outcome })
const cancelAttempt = (who: Who, bookingId: string, attemptId: string) => call(who, 'post', `/me/bookings/${bookingId}/payment-attempts/${attemptId}/cancel`, {})

let webinarProduct = ''
let sessionOffset = 0
/** A fresh published webinar session (its own seat counter) for each scenario. */
const newSession = async (capacity: number | null = 5) => {
  const startsAt = new Date(Date.now() + (20 + sessionOffset++) * DAY)
  return (await prisma.session.create({ data: { productId: webinarProduct, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity } })).id
}
const book = async (who: Who, sessionId: string) => {
  const res = await call(who, 'post', '/me/bookings', { productId: webinarProduct, sessionId, contactName: 'Asha Rao', phone: PHONE }, { 'Idempotency-Key': key() })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data as { id: string; reference: string; createdAt: string; payment: { dueAt: string | null; openAttemptId: string | null }; canPay: boolean; price: { amount: string; currency: string } }
}
const seats = async (sessionId: string) => (await prisma.session.findUniqueOrThrow({ where: { id: sessionId } })).seatsHeld
const bookingRow = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } })
// Sorted: events written in one transaction share created_at, so their relative order is not meaningful.
const auditActions = async (bookingId: string) => (await prisma.auditEvent.findMany({ where: { targetType: 'booking', targetId: bookingId } })).map((event) => event.action).sort()

beforeAll(async () => {
  database = await startTestDatabase()
  await prismaCli(['migrate', 'deploy'], database.url)
  prisma = createPrismaClient(database.url, { maxConnections: 1 })
  await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
  await seedCatalog(prisma)
  bookings = createBookingRepository(prisma, { confirmationMode: 'payment' })
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
  const authRepository = createAuthRepository(prisma)
  const third = await authRepository.signInCustomer({ issuer: DEV_ISSUERS.CUSTOMER, subject: 'test-customer-3', email: 'test.customer.three@example.test', emailVerified: true, name: 'Test Customer Three' }, new Date())
  if (third.kind !== 'ok') throw new Error('third customer sign-in failed')
  const token = newSessionToken()
  await authRepository.createSession({ userId: third.user.id, kind: 'CUSTOMER', tokenHash: hashSessionToken(token), policy: config.policies.CUSTOMER, userAgent: null, now: new Date() })
  people.chen = { cookie: withSession(config, token), csrf: await csrfFor(app, config, token), userId: third.user.id }

  webinarProduct = (await prisma.product.findUniqueOrThrow({ where: { slug: 'monthly-webinar' } })).id
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await database?.stop()
})

describe('simulator configuration', () => {
  it('GET /payments/config reports the simulator only when enabled; real payments are never on', async () => {
    const on = await request(app).get('/api/v1/payments/config')
    expect(on.status).toBe(200)
    expect(on.body.data).toMatchObject({ simulator: { enabled: true, environment: 'development' }, realPayments: false })
    const off = await request(buildApp({ simulator: false })).get('/api/v1/payments/config')
    expect(off.body.data).toEqual({ simulator: { enabled: false }, realPayments: false })
    // createApp defaults to env.paymentSimulator, which loadEnv sets to false outside development.
    const defaults = await request(createApp({ env, version: 'test', logger: memoryLogger() })).get('/api/v1/payments/config')
    expect(defaults.body.data.simulator).toEqual({ enabled: false })
  })

  it('with the simulator disabled the payment write routes are not registered (404); history stays readable', async () => {
    const off = buildApp({ simulator: false })
    const booking = await book(people.asha, await newSession())
    expect((await startPayment(people.asha, booking.id, key(), off)).status).toBe(404)
    expect((await as(off, people.asha, 'post', `/me/bookings/${booking.id}/payment-attempts/${randomUUID()}/simulate`, { outcome: 'SUCCEEDED' })).status).toBe(404)
    expect((await as(off, people.asha, 'post', `/me/bookings/${booking.id}/payment-attempts/${randomUUID()}/cancel`, {})).status).toBe(404)
    const history = await as(off, people.asha, 'get', `/me/bookings/${booking.id}/payment-attempts`)
    expect(history.status).toBe(200)
    expect(history.body.data).toEqual([])
  })

  it('the runtime guard answers 404 outside development/test even if the routes were registered', async () => {
    const production = buildApp({ simulator: true, nodeEnv: () => 'production' })
    const booking = await book(people.asha, await newSession())
    const res = await startPayment(people.asha, booking.id, key(), production)
    expect(res.status).toBe(404)
    expect(await prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(0)
  })
})

describe('30-minute payment hold', () => {
  it('every new booking gets a stored deadline exactly 30 minutes after creation', async () => {
    const booking = await book(people.asha, await newSession())
    const row = await bookingRow(booking.id)
    expect(row.paymentDueAt!.getTime() - row.createdAt.getTime()).toBe(PAYMENT_HOLD_MS)
    expect(booking.payment.dueAt).toBe(row.paymentDueAt!.toISOString())
    expect(booking.canPay).toBe(true)
    const created = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_CREATED' } })
    expect((created.details as { paymentDueAt: string }).paymentDueAt).toBe(row.paymentDueAt!.toISOString())
  })
})

describe('simulated payment flow', () => {
  it('failure keeps the booking pending with its seat; cancelling the attempt does not cancel the booking; success confirms without changing seats', async () => {
    const sessionId = await newSession()
    const booking = await book(people.asha, sessionId)
    expect(await seats(sessionId)).toBe(1)

    // Start: amount/currency snapshot from the booking, flagged simulated; identical retry is replayed.
    const k1 = key()
    const first = await startPayment(people.asha, booking.id, k1)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const a1 = first.body.data.attempt
    expect(a1).toMatchObject({ status: 'CREATED', provider: 'DEV_SIMULATOR', simulated: true, amount: booking.price })
    expect(first.body.data.booking.payment.openAttemptId).toBe(a1.id)
    const replay = await startPayment(people.asha, booking.id, k1)
    expect(replay.status).toBe(200)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.body.data.attempt.id).toBe(a1.id)
    // Only one open attempt at a time.
    const second = await startPayment(people.asha, booking.id)
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('PAYMENT_ATTEMPT_OPEN')

    // Failure: booking stays PENDING_PAYMENT and keeps its seat. Same outcome again = replay; a different one = 409.
    const failed = await simulate(people.asha, booking.id, a1.id, 'FAILED')
    expect(failed.status).toBe(200)
    expect(failed.body.data.attempt.status).toBe('FAILED')
    expect(failed.body.data.booking.status).toBe('PENDING_PAYMENT')
    expect(await seats(sessionId)).toBe(1)
    expect((await simulate(people.asha, booking.id, a1.id, 'FAILED')).headers['idempotent-replayed']).toBe('true')
    const conflict = await simulate(people.asha, booking.id, a1.id, 'SUCCEEDED')
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('PAYMENT_ATTEMPT_COMPLETED')

    // A new attempt within the hold window, then cancelling just that attempt.
    const a2 = (await startPayment(people.asha, booking.id)).body.data.attempt
    const cancelled = await cancelAttempt(people.asha, booking.id, a2.id)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.data.attempt.status).toBe('CANCELLED')
    expect(cancelled.body.data.booking.status).toBe('PENDING_PAYMENT')
    expect(await seats(sessionId)).toBe(1)
    expect((await cancelAttempt(people.asha, booking.id, a2.id)).headers['idempotent-replayed']).toBe('true')
    expect((await simulate(people.asha, booking.id, a2.id, 'SUCCEEDED')).body.error.code).toBe('PAYMENT_ATTEMPT_COMPLETED')
    expect((await cancelAttempt(people.asha, booking.id, a1.id)).body.error.code).toBe('PAYMENT_ATTEMPT_COMPLETED')

    // Success: CONFIRMED, seat count unchanged, clear simulated notice.
    const a3 = (await startPayment(people.asha, booking.id)).body.data.attempt
    const ok = await simulate(people.asha, booking.id, a3.id, 'SUCCEEDED')
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data.booking.status).toBe('CONFIRMED')
    expect(ok.body.data.booking.confirmation).toMatchObject({ simulated: true, notice: SIMULATED_CONFIRMATION_NOTICE })
    expect(SIMULATED_CONFIRMATION_NOTICE).toBe('Confirmed — simulated payment, no money received.')
    expect(ok.body.data.booking.canCancel).toBe(false)
    expect(ok.body.data.booking.canPay).toBe(false)
    expect(await seats(sessionId)).toBe(1)
    expect((await simulate(people.asha, booking.id, a3.id, 'SUCCEEDED')).headers['idempotent-replayed']).toBe('true')
    expect((await simulate(people.asha, booking.id, a3.id, 'FAILED')).body.error.code).toBe('PAYMENT_ATTEMPT_COMPLETED')
    expect((await startPayment(people.asha, booking.id)).body.error.code).toBe('BOOKING_ALREADY_CONFIRMED')

    // Confirmed bookings: no direct cancellation (customer or admin); only through a cancellation request (Revision 3). Seat stays held.
    const customerCancel = await call(people.asha, 'post', `/me/bookings/${booking.id}/cancel`, {})
    expect(customerCancel.status).toBe(409)
    expect(customerCancel.body.error.message).toMatch(/cancelled by request/)
    const adminCancel = await call(people.admin, 'post', `/admin/bookings/${booking.id}/cancel`, { reason: 'Testing confirmed cancel' })
    expect(adminCancel.status).toBe(409)
    expect(adminCancel.body.error.message).toMatch(/cancelled by request/)
    expect(await seats(sessionId)).toBe(1)
    // The same customer cannot hold a second seat on these dates.
    const again = await call(people.asha, 'post', '/me/bookings', { productId: webinarProduct, sessionId, contactName: 'Asha Rao', phone: PHONE }, { 'Idempotency-Key': key() })
    expect(again.body.error.code).toBe('ALREADY_BOOKED')

    expect(await auditActions(booking.id)).toEqual([
      'BOOKING_CREATED', 'PAYMENT_ATTEMPT_CREATED', 'PAYMENT_ATTEMPT_FAILED', 'PAYMENT_ATTEMPT_CREATED', 'PAYMENT_ATTEMPT_CANCELLED',
      'PAYMENT_ATTEMPT_CREATED', 'PAYMENT_ATTEMPT_SUCCEEDED', 'BOOKING_CONFIRMED',
    ].sort())
    const confirmedEvent = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_CONFIRMED' } })
    expect(confirmedEvent.details).toMatchObject({ simulated: true, noMoneyReceived: true })

    // Admin: read-only attempts on the booking detail, and simulated confirmations are counted apart (never revenue).
    const detail = await call(people.admin, 'get', `/admin/bookings/${booking.id}`)
    expect(detail.body.data.payment.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(['SUCCEEDED', 'CANCELLED', 'FAILED'])
    expect(detail.body.data.confirmation.notice).toBe(SIMULATED_CONFIRMATION_NOTICE)
    expect(detail.body.data.canCancel).toBe(false)
    const dashboard = await call(people.admin, 'get', '/admin/dashboard')
    expect(dashboard.body.data.bookings).toMatchObject({ confirmedSimulated: 1, confirmedPaid: 0 })
    expect(JSON.stringify(dashboard.body.data)).not.toMatch(/revenue/i)
    const confirmedList = await call(people.admin, 'get', '/admin/bookings?status=CONFIRMED')
    expect(confirmedList.body.data.map((row: { id: string }) => row.id)).toEqual([booking.id])
  })

  it('a late success after the booking was cancelled is rejected, audited and never confirms it', async () => {
    const sessionId = await newSession()
    const booking = await book(people.ben, sessionId)
    const attempt = (await startPayment(people.ben, booking.id)).body.data.attempt
    const cancelled = await call(people.ben, 'post', `/me/bookings/${booking.id}/cancel`, {})
    expect(cancelled.status).toBe(200)
    // Cancelling the booking closed its open attempt; the seat was released once.
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('CANCELLED')
    expect(await seats(sessionId)).toBe(0)

    const late = await simulate(people.ben, booking.id, attempt.id, 'SUCCEEDED')
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe('BOOKING_NOT_PAYABLE')
    expect((await bookingRow(booking.id)).status).toBe('CANCELLED')
    expect(await seats(sessionId)).toBe(0)
    const rejected = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'PAYMENT_RESULT_REJECTED' } })
    expect(rejected.details).toMatchObject({ attemptId: attempt.id, outcome: 'SUCCEEDED', reason: 'BOOKING_CANCELLED' })
    expect((await startPayment(people.ben, booking.id)).body.error.code).toBe('BOOKING_NOT_PAYABLE')
  })

  it('a success after the deadline expires the booking (SYSTEM), releases the seat once and is rejected', async () => {
    const sessionId = await newSession()
    const booking = await book(people.chen, sessionId)
    const attempt = (await startPayment(people.chen, booking.id)).body.data.attempt
    skew = PAYMENT_HOLD_MS + MINUTE
    try {
      const late = await simulate(people.chen, booking.id, attempt.id, 'SUCCEEDED')
      expect(late.status).toBe(409)
      expect(late.body.error.code).toBe('PAYMENT_WINDOW_EXPIRED')
      const row = await bookingRow(booking.id)
      expect(row).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: EXPIRY_REASON, confirmedAt: null })
      expect(await seats(sessionId)).toBe(0)
      expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('CANCELLED')
      // Idempotent: further sweeps and replays change nothing.
      expect(await bookings.expireOverdue(clock(), { sessionId })).toBe(0)
      expect(await seats(sessionId)).toBe(0)
      expect((await simulate(people.chen, booking.id, attempt.id, 'SUCCEEDED')).body.error.code).toBe('BOOKING_NOT_PAYABLE')
      const expiredEvent = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_EXPIRED' } })
      expect(expiredEvent).toMatchObject({ actorUserId: null, actorLabel: 'system' })
      expect(expiredEvent.details).toMatchObject({ by: 'SYSTEM', reason: EXPIRY_REASON })
      expect(await auditActions(booking.id)).toEqual(['BOOKING_CREATED', 'PAYMENT_ATTEMPT_CREATED', 'PAYMENT_ATTEMPT_CANCELLED', 'BOOKING_EXPIRED', 'PAYMENT_RESULT_REJECTED', 'PAYMENT_RESULT_REJECTED'].sort())
      const mine = await call(people.chen, 'get', `/me/bookings/${booking.id}`)
      expect(mine.body.data.cancellation).toMatchObject({ by: 'SYSTEM', reason: EXPIRY_REASON })
      expect(mine.body.data.canPay).toBe(false)
    } finally {
      skew = 0
    }
  })

  it('starting a payment after the deadline expires the booking instead', async () => {
    const sessionId = await newSession()
    const booking = await book(people.asha, sessionId)
    skew = PAYMENT_HOLD_MS
    try {
      const res = await startPayment(people.asha, booking.id)
      expect(res.body.error.code).toBe('PAYMENT_WINDOW_EXPIRED')
      expect(await prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(0)
      expect((await bookingRow(booking.id)).cancelledBy).toBe('SYSTEM')
      expect(await seats(sessionId)).toBe(0)
    } finally {
      skew = 0
    }
  })
})

describe('expiry sweeps', () => {
  it('availability reads release overdue holds; unexpired holds are untouched', async () => {
    const sessionId = await newSession(2)
    const overdue = await book(people.asha, sessionId)
    skew = 20 * MINUTE
    const fresh = await book(people.ben, sessionId) // created 20 minutes "later": still inside its window below
    try {
      expect((await request(app).get(`/api/v1/sessions/${sessionId}`)).body.data.seatsAvailable).toBe(0)
      skew = PAYMENT_HOLD_MS + MINUTE
      const res = await request(app).get(`/api/v1/sessions/${sessionId}`)
      expect(res.body.data.seatsAvailable).toBe(1)
      expect((await bookingRow(overdue.id)).status).toBe('CANCELLED')
      expect((await bookingRow(fresh.id)).status).toBe('PENDING_PAYMENT')
      expect(await seats(sessionId)).toBe(1)
    } finally {
      skew = 0
    }
  })

  it('booking creation releases the same dates’ overdue holds first, so a stale hold cannot block the last seat', async () => {
    const sessionId = await newSession(1)
    const stale = await book(people.asha, sessionId)
    const blocked = await call(people.ben, 'post', '/me/bookings', { productId: webinarProduct, sessionId, contactName: 'Ben Test', phone: PHONE }, { 'Idempotency-Key': key() })
    expect(blocked.body.error.code).toBe('SOLD_OUT')
    skew = PAYMENT_HOLD_MS + MINUTE
    try {
      const res = await call(people.ben, 'post', '/me/bookings', { productId: webinarProduct, sessionId, contactName: 'Ben Test', phone: PHONE }, { 'Idempotency-Key': key() })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect((await bookingRow(stale.id)).cancelledBy).toBe('SYSTEM')
      expect(await seats(sessionId)).toBe(1)
    } finally {
      skew = 0
    }
  })

  it('overlapping sweeps expire each booking exactly once', async () => {
    const sessionId = await newSession()
    const booking = await book(people.chen, sessionId)
    const later = new Date(Date.now() + PAYMENT_HOLD_MS + MINUTE)
    const counts = await Promise.all([bookings.expireOverdue(later), bookings.expireOverdue(later), bookings.expireOverdue(later, { sessionId })])
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(1)
    expect(await prisma.auditEvent.count({ where: { targetId: booking.id, action: 'BOOKING_EXPIRED' } })).toBe(1)
    expect(await seats(sessionId)).toBe(0)
  })

  it('a confirmed booking never expires', async () => {
    const sessionId = await newSession()
    const booking = await book(people.ben, sessionId)
    const attempt = (await startPayment(people.ben, booking.id)).body.data.attempt
    expect((await simulate(people.ben, booking.id, attempt.id, 'SUCCEEDED')).status).toBe(200)
    await bookings.expireOverdue(new Date(Date.now() + 2 * PAYMENT_HOLD_MS))
    expect((await bookingRow(booking.id)).status).toBe('CONFIRMED')
    expect(await seats(sessionId)).toBe(1)
  })
})

describe('access control', () => {
  it('another customer’s booking is never disclosed (404) and cannot be paid', async () => {
    const booking = await book(people.asha, await newSession())
    const attempt = (await startPayment(people.asha, booking.id)).body.data.attempt
    for (const res of [
      await startPayment(people.ben, booking.id),
      await simulate(people.ben, booking.id, attempt.id, 'SUCCEEDED'),
      await cancelAttempt(people.ben, booking.id, attempt.id),
      await call(people.ben, 'get', `/me/bookings/${booking.id}/payment-attempts`),
    ]) {
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('BOOKING_NOT_FOUND')
    }
    // An attempt id from someone else's booking does not resolve under one's own booking either.
    const own = await book(people.ben, await newSession())
    expect((await simulate(people.ben, own.id, attempt.id, 'SUCCEEDED')).body.error.code).toBe('PAYMENT_ATTEMPT_NOT_FOUND')
    expect((await bookingRow(booking.id)).status).toBe('PENDING_PAYMENT')
  })

  it('signed-out requests get 401; staff sessions get 403 on customer payment routes; admins have no payment write route', async () => {
    const booking = await book(people.asha, await newSession())
    const path = `/api/v1/me/bookings/${booking.id}/payment-attempts`
    expect((await request(app).get(path)).status).toBe(401)
    expect((await request(app).post(path).set('Origin', PUBLIC_ORIGIN).set('Idempotency-Key', key()).send({})).status).toBe(401)
    const staff = await startPayment(people.admin, booking.id)
    expect(staff.status).toBe(403)
    expect(staff.body.error.code).toBe('CUSTOMER_ACCOUNT_REQUIRED')
    expect((await call(people.admin, 'get', `/me/bookings/${booking.id}/payment-attempts`)).status).toBe(403)
    for (const adminPath of [`/admin/bookings/${booking.id}/payment-attempts`, `/admin/bookings/${booking.id}/confirm`, `/admin/bookings/${booking.id}/payment-attempts/${randomUUID()}/simulate`]) {
      expect((await call(people.admin, 'post', adminPath, { outcome: 'SUCCEEDED' })).status).toBe(404)
    }
    expect((await bookingRow(booking.id)).status).toBe('PENDING_PAYMENT')
  })

  it('writes need the CSRF token and an allowed Origin', async () => {
    const booking = await book(people.asha, await newSession())
    const path = `/api/v1/me/bookings/${booking.id}/payment-attempts`
    const noCsrf = await request(app).post(path).set('Cookie', people.asha.cookie).set('Origin', PUBLIC_ORIGIN).set('Idempotency-Key', key()).send({})
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED')
    const badOrigin = await request(app).post(path).set('Cookie', people.asha.cookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', people.asha.csrf).set('Idempotency-Key', key()).send({})
    expect(badOrigin.body.error.code).toBe('CSRF_FAILED')
    const attempt = (await startPayment(people.asha, booking.id)).body.data.attempt
    const forged = await request(app).post(`${path}/${attempt.id}/simulate`).set('Cookie', people.asha.cookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', people.asha.csrf).send({ outcome: 'SUCCEEDED' })
    expect(forged.status).toBe(403)
    expect((await bookingRow(booking.id)).status).toBe('PENDING_PAYMENT')
  })

  it('accepts no money or card fields and needs an idempotency key', async () => {
    const booking = await book(people.asha, await newSession())
    const noKey = await call(people.asha, 'post', `/me/bookings/${booking.id}/payment-attempts`, {})
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    const withAmount = await startPayment(people.asha, booking.id, key()).send({ amount: '1.00' })
    expect(withAmount.status).toBe(400)
    const attempt = (await startPayment(people.asha, booking.id)).body.data.attempt
    const card = await call(people.asha, 'post', `/me/bookings/${booking.id}/payment-attempts/${attempt.id}/simulate`, { outcome: 'SUCCEEDED', cardNumber: '4111111111111111' })
    expect(card.status).toBe(400)
    expect(JSON.stringify(card.body)).not.toContain('4111')
    expect((await call(people.asha, 'post', `/me/bookings/${booking.id}/payment-attempts/${attempt.id}/simulate`, { outcome: 'PAID' })).status).toBe(400)
  })
})

describe('database invariants (bypassing the API)', () => {
  it('rejects amount/currency mismatches, a second success, confirmation without success, and going back', async () => {
    const sessionId = await newSession()
    const booking = await book(people.chen, sessionId)
    const base = { bookingId: booking.id, provider: 'DEV_SIMULATOR' as const, isSimulated: true, idempotencyKey: `inv-${randomUUID()}` }
    await expect(prisma.paymentAttempt.create({ data: { ...base, amount: '1.00', currency: booking.price.currency } })).rejects.toThrow(/must match the booking snapshot/)
    await expect(prisma.paymentAttempt.create({ data: { ...base, amount: booking.price.amount, currency: 'USD' } })).rejects.toThrow(/must match the booking snapshot/)
    await expect(prisma.paymentAttempt.create({ data: { ...base, isSimulated: false, amount: booking.price.amount, currency: booking.price.currency } })).rejects.toThrow(/payment_attempts_simulator_is_simulated/)
    await expect(prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } })).rejects.toThrow(/without a successful payment attempt/)
    await expect(prisma.booking.update({ where: { id: booking.id }, data: { paymentDueAt: new Date(Date.now() + DAY) } })).rejects.toThrow(/cannot change/)
    await expect(prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'SYSTEM', cancelReason: EXPIRY_REASON } })).rejects.toThrow(/deadline has passed/)
    // A succeeded attempt must come with a confirmed booking in the same transaction (deferred check).
    const attempt = await prisma.paymentAttempt.create({ data: { ...base, amount: booking.price.amount, currency: booking.price.currency } })
    await expect(prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED', completedAt: new Date() } })).rejects.toThrow(/not confirmed/)
    // A booking cannot be cancelled while an attempt is left open (deferred check).
    await expect(prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CUSTOMER' } })).rejects.toThrow(/open payment attempt/)

    expect((await simulate(people.chen, booking.id, attempt.id, 'SUCCEEDED')).status).toBe(200)
    await expect(prisma.booking.update({ where: { id: booking.id }, data: { status: 'PENDING_PAYMENT', confirmedAt: null } })).rejects.toThrow(/confirmed booking cannot be cancelled or returned/)
    await expect(prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', confirmedAt: null, cancelledAt: new Date(), cancelledBy: 'ADMIN', cancelReason: 'x' } })).rejects.toThrow(/confirmed booking cannot be cancelled or returned/)
    await expect(prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } })).rejects.toThrow(/completed attempt cannot change/)
    await expect(prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { amount: '0.00' } })).rejects.toThrow(/cannot change/)
    // No new attempt for a booking that is no longer pending.
    await expect(prisma.paymentAttempt.create({ data: { ...base, idempotencyKey: `inv-${randomUUID()}`, amount: booking.price.amount, currency: booking.price.currency } })).rejects.toThrow(/only be started while the booking is pending/)
    expect(await seats(sessionId)).toBe(1)
  })

  it('a new booking must start PENDING_PAYMENT with a deadline (no new grandfathered rows)', async () => {
    const sessionId = await newSession()
    const data = {
      reference: 'DF-ZZZZ2222', userId: people.asha.userId, productId: webinarProduct, sessionId, priceAmount: '149.00', currency: 'INR', productName: 'Monthly Webinar',
      contactName: 'Asha Rao', phoneCountry: 'IN', phoneDialingCode: '91', phoneNational: '9876543210', phoneE164: '+919876543210', idempotencyKey: `raw-${randomUUID()}`,
    }
    await expect(prisma.booking.create({ data })).rejects.toThrow(/PENDING_PAYMENT with a payment deadline/)
    const now = new Date()
    await expect(prisma.booking.create({ data: { ...data, createdAt: now, paymentDueAt: new Date(now.getTime() + 2 * PAYMENT_HOLD_MS) } })).rejects.toThrow(/bookings_payment_due_30_minutes/)
    await expect(prisma.booking.create({ data: { ...data, status: 'CONFIRMED', confirmedAt: now, createdAt: now, paymentDueAt: new Date(now.getTime() + PAYMENT_HOLD_MS) } })).rejects.toThrow(/PENDING_PAYMENT with a payment deadline/)
    expect(await seats(sessionId)).toBe(0)
  })
})
