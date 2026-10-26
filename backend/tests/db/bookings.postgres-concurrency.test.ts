// REAL PostgreSQL concurrency gate for Stage 4C. PGlite (used by the other db tests) has one connection,
// so it cannot show what happens when bookings truly race. This suite runs only when TEST_POSTGRES_URL
// points at a DISPOSABLE, EMPTY database whose name contains "test", e.g.
//   TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/diyforests_test npx vitest run tests/db/bookings.postgres-concurrency.test.ts
// It applies every migration to that database and then races many connections against it.
// Without the variable it is reported as skipped — it is never silently counted as passing.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { HttpError } from '../../src/lib/http-error.js'
import { createAdminRepository } from '../../src/modules/admin/admin.repository.js'
import { PAYMENT_HOLD_MS } from '../../src/modules/bookings/booking-holds.js'
import { createBookingRepository, type BookingRepository } from '../../src/modules/bookings/booking.repository.js'
import { createCancellationRequestRepository, type CancellationRequestRepository } from '../../src/modules/bookings/cancellation-requests.js'
import { createManualConfirmationRepository, type ManualConfirmationRepository } from '../../src/modules/bookings/manual-confirmation.js'
import { createPaymentRepository, type PaymentRepository } from '../../src/modules/payments/payment.repository.js'
import { prismaCli } from './pglite-server.js'

const url = process.env.TEST_POSTGRES_URL
const DAY = 86_400_000

/**
 * Refuses the local development database: by name (diyforests_dev) and by matching host + port + database
 * of the DATABASE_URL / DIRECT_DATABASE_URL in backend/.env. The .env file is parsed here only to compare
 * those three parts; it is not loaded into the environment and nothing from it is printed.
 */
function assertNotDevelopmentDatabase(target: URL) {
  const identity = (value: URL) => `${value.hostname.toLowerCase().replace(/^localhost$/, '127.0.0.1')}:${value.port || '5432'}/${value.pathname.replace(/^\//, '')}`
  const dbName = target.pathname.replace(/^\//, '')
  if (dbName === 'diyforests_dev') throw new Error('Refusing to run: TEST_POSTGRES_URL points at the development database diyforests_dev')
  const envFile = path.resolve(import.meta.dirname, '../../.env')
  if (!existsSync(envFile)) return
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(DATABASE_URL|DIRECT_DATABASE_URL)\s*=\s*"?([^"\s]+)"?\s*$/.exec(line)
    if (!match) continue
    let dev: URL
    try {
      dev = new URL(match[2]!)
    } catch {
      continue
    }
    if (identity(dev) === identity(target)) throw new Error(`Refusing to run: TEST_POSTGRES_URL matches the development connection (${match[1]})`)
  }
}

describe.skipIf(!url)('real PostgreSQL: concurrent bookings (TEST_POSTGRES_URL)', () => {
  let prisma: PrismaClient
  let bookings: BookingRepository
  let payments: PaymentRepository
  // Revision 3 (manual mode, the default): its own booking repository on the same database.
  let manualBookings: BookingRepository
  let manual: ManualConfirmationRepository
  let cancellations: CancellationRequestRepository
  let productId = ''
  let adminId = ''
  let users: string[] = []

  beforeAll(async () => {
    const parsed = new URL(url!)
    const dbName = parsed.pathname.replace(/^\//, '')
    assertNotDevelopmentDatabase(parsed)
    if (!/test/i.test(dbName)) throw new Error(`Refusing to run: database "${dbName}" does not look disposable (its name must contain "test")`)
    const probe = createPrismaClient(url!, { maxConnections: 1 })
    try {
      const [{ count }] = await probe.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'public'`
      if (Number(count) !== 0) throw new Error(`Refusing to run: database "${dbName}" is not empty (${count} tables). Use a fresh, empty database.`)
    } finally {
      await probe.$disconnect()
    }
    await prismaCli(['migrate', 'deploy'], url!)
    prisma = createPrismaClient(url!, { maxConnections: 25 })
    bookings = createBookingRepository(prisma, { confirmationMode: 'payment' })
    payments = createPaymentRepository(prisma, bookings)
    manualBookings = createBookingRepository(prisma, { confirmationMode: 'manual' })
    manual = createManualConfirmationRepository(prisma, manualBookings)
    cancellations = createCancellationRequestRepository(prisma, manualBookings)
    productId = (await prisma.product.create({ data: { slug: 'race-webinar', name: 'Race Webinar', type: 'WEBINAR', priceAmount: '149', currency: 'INR' } })).id
    adminId = (await prisma.user.create({ data: { identityPool: 'ADMIN', identityIssuer: 'test', identitySubject: 'admin', email: 'admin@example.test', role: 'ADMIN' } })).id
    users = await Promise.all(Array.from({ length: 20 }, async (_, i) => (await prisma.user.create({ data: { identityPool: 'CUSTOMER', identityIssuer: 'test', identitySubject: `c${i}`, email: `c${i}@example.test` } })).id))
  }, 240_000)

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  let offset = 0
  const session = async (capacity: number | null) =>
    (await prisma.session.create({ data: { productId, startsAt: new Date(Date.now() + (10 + offset++) * DAY), endsAt: new Date(Date.now() + (10 + offset) * DAY - 3_600_000), timezone: 'Asia/Kolkata', status: 'PUBLISHED', capacity } })).id
  const attempt = (userId: string, sessionId: string, idempotencyKey: string = randomUUID()) =>
    bookings.create(userId, { productId, target: { kind: 'session', id: sessionId }, contactName: 'Race Test', phone: { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }, idempotencyKey }, { now: new Date(), requestId: undefined })
  const outcome = (result: PromiseSettledResult<unknown>) => (result.status === 'fulfilled' ? 'ok' : result.reason instanceof HttpError ? result.reason.code : `unexpected: ${String(result.reason)}`)
  const counts = (results: PromiseSettledResult<unknown>[]) => results.map(outcome).reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {})
  const seats = async (id: string) => (await prisma.session.findUniqueOrThrow({ where: { id } })).seatsHeld
  // Seat-holding bookings: PENDING_PAYMENT, (Stage 2) CONFIRMED and (Revision 3) AWAITING_CONFIRMATION.
  const active = (sessionId: string) => prisma.booking.count({ where: { sessionId, status: { in: ['PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED'] } } })
  const PHONE = { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }
  const manualBooking = (userId: string, sessionId: string, now = new Date()) =>
    manualBookings.create(userId, { productId, target: { kind: 'session', id: sessionId }, contactName: 'Race Test', phone: PHONE, idempotencyKey: randomUUID() }, { now, requestId: undefined })
  const at = (instant: Date) => ({ clock: () => instant, requestId: undefined })
  const confirmedManually = async (userId: string, sessionId: string) => {
    const { booking } = await manualBooking(userId, sessionId)
    await manual.confirm(adminId, booking.id, { reason: 'COMPLIMENTARY', note: null }, at(new Date()))
    return booking.id
  }
  const ctx = (now = new Date()) => ({ now, requestId: undefined })

  it('20 customers race for the LAST seat: exactly one booking, 19 SOLD_OUT, counter = 1', async () => {
    const id = await session(1)
    const results = await Promise.allSettled(users.map((user) => attempt(user, id)))
    expect(counts(results)).toEqual({ ok: 1, SOLD_OUT: 19 })
    expect(await seats(id)).toBe(1)
    expect(await active(id)).toBe(1)
  })

  it('20 customers race for 5 seats: exactly 5 bookings', async () => {
    const id = await session(5)
    const results = await Promise.allSettled(users.map((user) => attempt(user, id)))
    expect(counts(results)).toEqual({ ok: 5, SOLD_OUT: 15 })
    expect(await seats(id)).toBe(5)
  })

  it('the same submission sent 8 times at once creates one booking', async () => {
    const id = await session(10)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => attempt(users[0]!, id, 'same-key-for-all-attempts')))
    expect(counts(results)).toEqual({ ok: 8 })
    const ids = new Set(results.map((result) => (result as PromiseFulfilledResult<{ booking: { id: string } }>).value.booking.id))
    expect(ids.size).toBe(1)
    expect(await seats(id)).toBe(1)
  })

  it('8 concurrent cancellations of one booking: one succeeds, the seat is released once', async () => {
    const id = await session(3)
    const { booking } = await attempt(users[1]!, id)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => bookings.cancelByCustomer(users[1]!, booking.id, null, { now: new Date(), requestId: undefined })))
    expect(counts(results)).toEqual({ ok: 1, BOOKING_NOT_CANCELLABLE: 7 })
    expect(await seats(id)).toBe(0)
  })

  it('a capacity reduction racing bookings never leaves more seats held than capacity', async () => {
    const admin = createAdminRepository(prisma)
    for (let round = 0; round < 5; round++) {
      const id = await session(3)
      await attempt(users[2]!, id)
      const results = await Promise.allSettled([
        ...users.slice(3, 8).map((user) => attempt(user, id)),
        admin.updateSession(id, { capacity: 2 }, { userId: adminId, requestId: undefined }, new Date()),
      ])
      const row = await prisma.session.findUniqueOrThrow({ where: { id } })
      expect(row.seatsHeld).toBeLessThanOrEqual(row.capacity!)
      expect(row.seatsHeld).toBe(await active(id))
      const adminOutcome = outcome(results.at(-1)!)
      expect(['ok', 'CAPACITY_BELOW_HELD']).toContain(adminOutcome)
      expect(row.capacity).toBe(adminOutcome === 'ok' ? 2 : 3)
    }
  })

  it('one key sent at once with two phone countries sharing +1 (US, CA): one booking, one IDEMPOTENCY_KEY_REUSED', async () => {
    const id = await session(10)
    const viaCountry = (country: 'US' | 'CA') =>
      bookings.create(users[9]!, { productId, target: { kind: 'session', id }, contactName: 'Race Test', phone: { country, dialingCode: '1', national: '2025550123', e164: '+12025550123' }, idempotencyKey: 'same-key-two-countries' }, { now: new Date(), requestId: undefined })
    const results = await Promise.allSettled([viaCountry('US'), viaCountry('CA')])
    expect(counts(results)).toEqual({ ok: 1, IDEMPOTENCY_KEY_REUSED: 1 })
    expect(await seats(id)).toBe(1)
    expect(await prisma.booking.count({ where: { userId: users[9]!, idempotencyKey: 'same-key-two-countries' } })).toBe(1)
  })

  it('the product name, price and currency snapshot cannot be changed in the database', async () => {
    const id = await session(3)
    const { booking } = await attempt(users[10]!, id)
    for (const data of [{ productName: 'Renamed' }, { priceAmount: '1' }, { currency: 'USD' }]) {
      await expect(prisma.booking.update({ where: { id: booking.id }, data })).rejects.toThrow(/cannot change/)
    }
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, select: { productName: true, currency: true } })).toEqual({ productName: 'Race Webinar', currency: 'INR' })
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).priceAmount.toFixed(2)).toBe('149.00')
  })

  // ---- Stage 2: payment simulator races (lock order target -> booking -> attempt everywhere) ----

  it('payment success racing the customer’s cancellation: each booking ends CONFIRMED or CANCELLED, never both', async () => {
    const id = await session(null)
    const racers = users.slice(11, 19)
    const prepared = await Promise.all(racers.map(async (user) => {
      const { booking } = await attempt(user, id)
      const started = await payments.start(user, booking.id, randomUUID(), ctx())
      return { user, bookingId: booking.id, attemptId: started.attempt.id }
    }))
    const results = await Promise.all(prepared.map(({ user, bookingId, attemptId }) => Promise.allSettled([
      payments.simulate(user, bookingId, attemptId, 'SUCCEEDED', ctx()),
      bookings.cancelByCustomer(user, bookingId, null, ctx()),
    ])))
    for (const [index, [paid, cancelled]] of results.entries()) {
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: prepared[index]!.bookingId } })
      if (row.status === 'CONFIRMED') {
        expect([outcome(paid!), outcome(cancelled!)]).toEqual(['ok', 'BOOKING_NOT_CANCELLABLE'])
      } else {
        expect(row.status).toBe('CANCELLED')
        expect([outcome(paid!), outcome(cancelled!)]).toEqual(['BOOKING_NOT_PAYABLE', 'ok'])
        expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: prepared[index]!.attemptId } })).status).toBe('CANCELLED')
      }
    }
    expect(await seats(id)).toBe(await active(id))
  })

  it('payment success just inside the window racing the expiry sweep: exactly one wins, the seat is released at most once', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await session(5)
      const user = users[19]!
      const created = new Date()
      const { booking } = await bookings.create(user, { productId, target: { kind: 'session', id }, contactName: 'Race Test', phone: { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }, idempotencyKey: randomUUID() }, ctx(created))
      const started = await payments.start(user, booking.id, randomUUID(), ctx(created))
      const [paid, swept] = await Promise.allSettled([
        payments.simulate(user, booking.id, started.attempt.id, 'SUCCEEDED', ctx(new Date(created.getTime() + PAYMENT_HOLD_MS - 60_000))),
        bookings.expireOverdue(new Date(created.getTime() + PAYMENT_HOLD_MS + 60_000), { sessionId: id }),
      ])
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })
      if (row.status === 'CONFIRMED') {
        expect(outcome(paid)).toBe('ok')
        expect((swept as PromiseFulfilledResult<number>).value).toBe(0)
        expect(await seats(id)).toBe(1)
      } else {
        expect(row.cancelledBy).toBe('SYSTEM')
        expect(outcome(paid)).toBe('BOOKING_NOT_PAYABLE')
        expect(await seats(id)).toBe(0)
      }
      expect(await prisma.auditEvent.count({ where: { targetId: booking.id, action: { in: ['BOOKING_CONFIRMED', 'BOOKING_EXPIRED'] } } })).toBe(1)
    }
  })

  it('the same simulated success sent 8 times at once confirms once (7 replays)', async () => {
    const id = await session(5)
    const { booking } = await attempt(users[12]!, id)
    const started = await payments.start(users[12]!, booking.id, randomUUID(), ctx())
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => payments.simulate(users[12]!, booking.id, started.attempt.id, 'SUCCEEDED', ctx())))
    expect(counts(results)).toEqual({ ok: 8 })
    expect(results.filter((result) => result.status === 'fulfilled' && result.value.replayed)).toHaveLength(7)
    expect(await prisma.auditEvent.count({ where: { targetId: booking.id, action: 'BOOKING_CONFIRMED' } })).toBe(1)
    expect(await seats(id)).toBe(1)
  })

  it('8 concurrent payment starts with different keys: one open attempt, 7 PAYMENT_ATTEMPT_OPEN', async () => {
    const id = await session(5)
    const { booking } = await attempt(users[13]!, id)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => payments.start(users[13]!, booking.id, randomUUID(), ctx())))
    expect(counts(results)).toEqual({ ok: 1, PAYMENT_ATTEMPT_OPEN: 7 })
    expect(await prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(1)
  })

  it('overlapping expiry sweeps expire each overdue booking exactly once', async () => {
    const id = await session(null)
    const made = await Promise.all(users.slice(14, 19).map((user) => attempt(user, id)))
    const later = new Date(Date.now() + PAYMENT_HOLD_MS + 60_000)
    const swept = await Promise.all(Array.from({ length: 6 }, () => bookings.expireOverdue(later, { sessionId: id })))
    expect(swept.reduce((sum, count) => sum + count, 0)).toBe(made.length)
    for (const { booking } of made) expect(await prisma.auditEvent.count({ where: { targetId: booking.id, action: 'BOOKING_EXPIRED' } })).toBe(1)
    expect(await seats(id)).toBe(0)
  })

  // ---- Revision 3: manual confirmation and cancellation-request races ----

  it('manual mode: 20 customers race for the LAST seat: one AWAITING_CONFIRMATION, 19 SOLD_OUT', async () => {
    const id = await session(1)
    const results = await Promise.allSettled(users.map((user) => manualBooking(user, id)))
    expect(counts(results)).toEqual({ ok: 1, SOLD_OUT: 19 })
    expect(await prisma.booking.count({ where: { sessionId: id, status: 'AWAITING_CONFIRMATION' } })).toBe(1)
    expect(await seats(id)).toBe(1)
  })

  it('manual confirmation 1 ms before the deadline racing the expiry sweep at the deadline: exactly one wins', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await session(5)
      const { booking } = await manualBooking(users[round]!, id)
      const due = (await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).confirmationDueAt!
      const [confirmed, swept] = await Promise.allSettled([
        manual.confirm(adminId, booking.id, { reason: 'COMPLIMENTARY', note: null }, at(new Date(due.getTime() - 1))),
        manualBookings.expireOverdue(due, { sessionId: id }),
      ])
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })
      if (row.status === 'CONFIRMED') {
        expect(outcome(confirmed)).toBe('ok')
        expect((swept as PromiseFulfilledResult<number>).value).toBe(0)
        expect(await seats(id)).toBe(1)
      } else {
        expect(row).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' })
        expect(outcome(confirmed)).toBe('BOOKING_NOT_CONFIRMABLE')
        expect(await seats(id)).toBe(0)
      }
      expect(await prisma.auditEvent.count({ where: { targetId: booking.id, action: { in: ['BOOKING_CONFIRMED_MANUALLY', 'BOOKING_EXPIRED'] } } })).toBe(1)
    }
  })

  it('manual confirmation racing the customer cancelling: exactly one wins, the seat is released at most once', async () => {
    const id = await session(null)
    const racers = users.slice(0, 8)
    const made = await Promise.all(racers.map((user) => manualBooking(user, id)))
    const results = await Promise.all(made.map(({ booking }, index) => Promise.allSettled([
      manual.confirm(adminId, booking.id, { reason: 'COMPLIMENTARY', note: null }, at(new Date())),
      manualBookings.cancelByCustomer(racers[index]!, booking.id, null, ctx()),
    ])))
    for (const [index, [confirmed, cancelled]] of results.entries()) {
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: made[index]!.booking.id } })
      const expected = row.status === 'CONFIRMED' ? ['ok', 'BOOKING_NOT_CANCELLABLE'] : ['BOOKING_NOT_CONFIRMABLE', 'ok']
      expect([outcome(confirmed!), outcome(cancelled!)]).toEqual(expected)
    }
    expect(await seats(id)).toBe(await active(id))
  })

  it('approve racing reject on one cancellation request: exactly one decision, the other ALREADY_DECIDED', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await session(5)
      const user = users[10 + round]!
      const bookingId = await confirmedManually(user, id)
      await cancellations.request(user, bookingId, null, at(new Date()))
      const results = await Promise.allSettled([
        cancellations.approve(adminId, bookingId, 'Approved in race test', at(new Date())),
        cancellations.reject(adminId, bookingId, 'Rejected in race test', at(new Date())),
      ])
      expect(counts(results)).toEqual({ ok: 1, ALREADY_DECIDED: 1 })
      const status = (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status
      expect(await seats(id)).toBe(status === 'CANCELLED' ? 0 : 1)
    }
  })

  it('4 administrators approving the same request at once: one approval, the seat is released once', async () => {
    const id = await session(5)
    const bookingId = await confirmedManually(users[16]!, id)
    await cancellations.request(users[16]!, bookingId, null, at(new Date()))
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => cancellations.approve(adminId, bookingId, 'Approved in race test', at(new Date()))))
    expect(counts(results)).toEqual({ ok: 1, ALREADY_DECIDED: 3 })
    expect(await seats(id)).toBe(0)
    expect(await prisma.auditEvent.count({ where: { targetId: bookingId, action: 'BOOKING_CANCELLATION_APPROVED' } })).toBe(1)
  })

  it('the same cancellation request sent 8 times at once creates one request (7 replays)', async () => {
    const id = await session(5)
    const bookingId = await confirmedManually(users[17]!, id)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => cancellations.request(users[17]!, bookingId, null, at(new Date()))))
    expect(counts(results)).toEqual({ ok: 8 })
    expect(results.filter((result) => result.status === 'fulfilled' && result.value.replayed)).toHaveLength(7)
    expect(await prisma.bookingCancellationRequest.count({ where: { bookingId } })).toBe(1)
    expect(await seats(id)).toBe(1)
  })

  it('every counter equals its active bookings after all the races', async () => {
    const rows = await prisma.session.findMany({ select: { id: true, seatsHeld: true } })
    for (const row of rows) expect(row.seatsHeld).toBe(await active(row.id))
  })
})
