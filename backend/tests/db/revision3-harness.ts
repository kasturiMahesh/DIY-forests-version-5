// Shared setup for the Revision 3 integration suites (manual confirmation, cancellation requests):
// PGlite (in-memory PostgreSQL compiled to WASM, ONE connection, so requests are serialized) with every
// migration applied, the real HTTP app in MANUAL mode (the default), signed-in people, and an injectable
// clock. The clock is only ever moved FORWARD from real time: the database refuses confirmation and
// request times more than 5 minutes older than its own clock.
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { expect } from 'vitest'
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
import { createBookingRepository, type BookingConfirmationMode, type BookingRepository } from '../../src/modules/bookings/booking.repository.js'
import { adminBookingDecisionsRouter, adminBookingsRouter, customerBookingsRouter, customerCancellationRequestsRouter } from '../../src/modules/bookings/booking.routes.js'
import { createCancellationRequestRepository } from '../../src/modules/bookings/cancellation-requests.js'
import { createManualConfirmationRepository } from '../../src/modules/bookings/manual-confirmation.js'
import { createCatalogRepository } from '../../src/modules/catalog/catalog.repository.js'
import { createPaymentRepository } from '../../src/modules/payments/payment.repository.js'
import { customerPaymentsRouter } from '../../src/modules/payments/payment.routes.js'
import { csrfFor, devAuthConfig, PUBLIC_ORIGIN, signIn, withSession } from '../auth/helpers.js'
import { memoryLogger } from '../helpers.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export type Who = { cookie: string; csrf: string; userId: string }
export type People = Record<'admin' | 'asha' | 'ben' | 'chen', Who>
const PHONE = { country: 'IN', number: '098765 43210' }
const env = loadEnv({ NODE_ENV: 'test' })
const config = devAuthConfig()

export type Harness = Awaited<ReturnType<typeof startHarness>>

export async function startHarness() {
  const database: TestDatabase = await startTestDatabase()
  await prismaCli(['migrate', 'deploy'], database.url)
  const prisma: PrismaClient = createPrismaClient(database.url, { maxConnections: 1 })
  await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
  await seedCatalog(prisma)

  // Injected clock: null = real time; otherwise a fixed instant (always at or after real time).
  let fixed: Date | null = null
  const clock = () => fixed ?? new Date()
  const setNow = (instant: Date | null) => { fixed = instant }

  const bookings: Record<BookingConfirmationMode, BookingRepository> = {
    manual: createBookingRepository(prisma, { confirmationMode: 'manual' }),
    payment: createBookingRepository(prisma, { confirmationMode: 'payment' }),
  }
  const buildApp = (mode: BookingConfirmationMode) => {
    const repo = bookings[mode]
    const auth = createAuthModule({
      config, logger: memoryLogger(), repository: createAuthRepository(prisma),
      adminManagement: adminManagementRouter(createAdminRepository(prisma), clock),
      adminBookings: adminBookingsRouter(repo, clock, adminBookingDecisionsRouter(createManualConfirmationRepository(prisma, repo), createCancellationRequestRepository(prisma, repo), clock)),
      customerBookings: customerBookingsRouter(repo, clock, [
        // The simulator is mounted only for the explicit payment-mode app (a test configuration; loadEnv refuses it outside development).
        ...(mode === 'payment' ? [customerPaymentsRouter(createPaymentRepository(prisma, repo), { simulator: true, now: clock })] : []),
        customerCancellationRequestsRouter(createCancellationRequestRepository(prisma, repo), clock),
      ]),
    })
    return createApp({ env, version: 'test', logger: memoryLogger(), catalog: createCatalogRepository(prisma), auth, paymentSimulator: mode === 'payment' })
  }
  const apps = { manual: buildApp('manual'), payment: buildApp('payment') }

  await runAdminCommand(['grant', '--dev-identity', 'dev-admin-1'], { repository: createAuthRepository(prisma), authConfig: config, actorLabel: 'operator-cli:test', print: () => {} })
  const signed = async (pool: 'ADMIN' | 'CUSTOMER', subject: string): Promise<Who> => {
    const result = await signIn(apps.manual, config, { pool, subject })
    const userId = (await prisma.user.findFirstOrThrow({ where: { identitySubject: subject, identityPool: pool } })).id
    return { cookie: withSession(config, result.session!), csrf: await csrfFor(apps.manual, config, result.session!), userId }
  }
  const people = {} as People
  people.admin = await signed('ADMIN', 'dev-admin-1')
  people.asha = await signed('CUSTOMER', 'dev-customer-1')
  people.ben = await signed('CUSTOMER', 'dev-customer-2')
  const authRepository = createAuthRepository(prisma)
  const third = await authRepository.signInCustomer({ issuer: DEV_ISSUERS.CUSTOMER, subject: 'test-customer-3', email: 'test.customer.three@example.test', emailVerified: true, name: 'Test Customer Three' }, new Date())
  if (third.kind !== 'ok') throw new Error('third customer sign-in failed')
  const token = newSessionToken()
  await authRepository.createSession({ userId: third.user.id, kind: 'CUSTOMER', tokenHash: hashSessionToken(token), policy: config.policies.CUSTOMER, userAgent: null, now: new Date() })
  people.chen = { cookie: withSession(config, token), csrf: await csrfFor(apps.manual, config, token), userId: third.user.id }

  const productId = async (slug: string) => (await prisma.product.findUniqueOrThrow({ where: { slug } })).id
  const products = { webinar: await productId('monthly-webinar'), workshop: await productId('offline-workshop'), training: await productId('online-training') }

  let offset = 0
  /** A published standalone session starting `startsIn` after real time (each call gets a unique instant). */
  const newSession = async (kind: 'webinar' | 'workshop', startsIn: number, capacity: number | null = 5) => {
    const startsAt = new Date(Date.now() + startsIn + offset++ * 60_000)
    const workshop = kind === 'workshop'
    return prisma.session.create({
      data: {
        productId: products[kind], startsAt, endsAt: new Date(startsAt.getTime() + (workshop ? 2 * DAY : HOUR)), timezone: 'Asia/Kolkata',
        status: 'PUBLISHED', capacity, ...(workshop ? { venue: 'Test Forest Site' } : {}),
      },
      select: { id: true, startsAt: true, productId: true },
    })
  }
  /** A published online-training cohort: two 4-hour Fridays 18:30 IST, the first at least `weeks` weeks away. */
  const newCohort = async (weeks: number, capacity = 5) => {
    const ist = new Date(Date.now() + 5.5 * HOUR + weeks * 7 * DAY)
    const toFriday = (5 - ist.getUTCDay() + 7) % 7 || 7
    const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + toFriday))
    const first = zonedTimeToInstant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 18, minute: 30 }, 'Asia/Kolkata')
    const second = new Date(first.getTime() + 7 * DAY)
    const cohort = await prisma.trainingCohort.create({ data: { productId: products.training, status: 'PUBLISHED', capacity, timezone: 'Asia/Kolkata' } })
    for (const [sequence, startsAt] of [[1, first], [2, second]] as const) {
      await prisma.session.create({ data: { productId: products.training, cohortId: cohort.id, cohortSequence: sequence, startsAt, endsAt: new Date(startsAt.getTime() + 4 * HOUR), status: 'PUBLISHED', timezone: 'Asia/Kolkata' } })
    }
    return { id: cohort.id, firstStartsAt: first }
  }

  const as = (who: Who, method: 'get' | 'post', path: string, body?: unknown, headers: Record<string, string> = {}, mode: BookingConfirmationMode = 'manual') => {
    const req = request(apps[mode])[method](`/api/v1${path}`).set('Cookie', who.cookie)
    if (method !== 'get') req.set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', who.csrf)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return body === undefined ? req : req.send(body as object)
  }
  type Booked = { id: string; reference: string; status: string; createdAt: string; confirmationDueAt: string | null; payment: { dueAt: string | null; openAttemptId: string | null }; canPay: boolean; canCancel: boolean; price: { amount: string; currency: string } }
  /** Books a session or cohort; expects 201 unless `expectStatus` is given. */
  const book = async (who: Who, target: { productId: string; sessionId?: string; cohortId?: string }, { mode = 'manual', expectStatus = 201 }: { mode?: BookingConfirmationMode; expectStatus?: number } = {}) => {
    const res = await as(who, 'post', '/me/bookings', { ...target, contactName: 'Revision Three Test', phone: PHONE }, { 'Idempotency-Key': randomUUID() }, mode)
    expect(res.status, JSON.stringify(res.body)).toBe(expectStatus)
    return res.body.data as Booked
  }
  const confirm = (bookingId: string, body: Record<string, unknown>, who: Who = people.admin) => as(who, 'post', `/admin/bookings/${bookingId}/confirm`, body)
  const seats = async (sessionId: string) => (await prisma.session.findUniqueOrThrow({ where: { id: sessionId } })).seatsHeld
  const cohortSeats = async (cohortId: string) => (await prisma.trainingCohort.findUniqueOrThrow({ where: { id: cohortId } })).seatsHeld
  const row = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } })
  // Sorted: events written in one transaction share created_at, so their relative order is not meaningful.
  const auditActions = async (bookingId: string) => (await prisma.auditEvent.findMany({ where: { targetType: 'booking', targetId: bookingId } })).map((event) => event.action).sort()

  return {
    prisma, database, apps, people, products, bookings, clock, setNow, newSession, newCohort, as, book, confirm, seats, cohortSeats, row, auditActions,
    stop: async () => {
      await prisma.$disconnect()
      await database.stop()
    },
  }
}
