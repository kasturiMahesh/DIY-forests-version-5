// REAL PostgreSQL concurrency gate for Stage 4C. PGlite (used by the other db tests) has one connection,
// so it cannot show what happens when bookings truly race. This suite runs only when TEST_POSTGRES_URL
// points at a DISPOSABLE, EMPTY database whose name contains "test", e.g.
//   TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/diyforests_test npx vitest run tests/db/bookings.postgres-concurrency.test.ts
// It applies every migration to that database and then races many connections against it.
// Without the variable it is reported as skipped — it is never silently counted as passing.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { HttpError } from '../../src/lib/http-error.js'
import { createAdminRepository } from '../../src/modules/admin/admin.repository.js'
import { createBookingRepository, type BookingRepository } from '../../src/modules/bookings/booking.repository.js'
import { prismaCli } from './pglite-server.js'

const url = process.env.TEST_POSTGRES_URL
const DAY = 86_400_000

describe.skipIf(!url)('real PostgreSQL: concurrent bookings (TEST_POSTGRES_URL)', () => {
  let prisma: PrismaClient
  let bookings: BookingRepository
  let productId = ''
  let adminId = ''
  let users: string[] = []

  beforeAll(async () => {
    const parsed = new URL(url!)
    const dbName = parsed.pathname.replace(/^\//, '')
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
    bookings = createBookingRepository(prisma)
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
  const active = (sessionId: string) => prisma.booking.count({ where: { sessionId, status: 'PENDING_PAYMENT' } })

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

  it('every counter equals its active bookings after all the races', async () => {
    const rows = await prisma.session.findMany({ select: { id: true, seatsHeld: true } })
    for (const row of rows) expect(row.seatsHeld).toBe(await active(row.id))
  })
})
