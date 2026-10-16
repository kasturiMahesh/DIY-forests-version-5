import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadEnv } from '../../src/config/env.js'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { seedCatalog } from '../../src/db/seed-catalog.js'
import { zonedTimeToInstant } from '../../src/lib/time.js'
import { createAdminRepository, type AdminRepository } from '../../src/modules/admin/admin.repository.js'
import { adminManagementRouter } from '../../src/modules/admin/admin.routes.js'
import { runAdminCommand } from '../../src/modules/auth/admin-cli.js'
import { createAuthRepository } from '../../src/modules/auth/auth.repository.js'
import { createAuthModule } from '../../src/modules/auth/index.js'
import { createCatalogRepository } from '../../src/modules/catalog/catalog.repository.js'
import { csrfFor, devAuthConfig, PUBLIC_ORIGIN, signIn, withSession } from '../auth/helpers.js'
import { memoryLogger, type LoggedLine } from '../helpers.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

let database: TestDatabase
let prisma: PrismaClient
const env = loadEnv({ NODE_ENV: 'test' })
const config = devAuthConfig()
const DAY = 86_400_000

function buildApp(adminRepository: AdminRepository | null = createAdminRepository(prisma), lines: LoggedLine[] = []) {
  const logger = memoryLogger(lines)
  const auth = createAuthModule({ config, logger, repository: createAuthRepository(prisma), adminManagement: adminManagementRouter(adminRepository) })
  return createApp({ env, version: 'test', logger, catalog: createCatalogRepository(prisma), auth })
}

/** A real future Friday at 18:30 IST, at least `weeks` weeks from now (no fixed dates that go stale). */
function fridayIst(weeks: number, hour = 18, minute = 30): Date {
  const ist = new Date(Date.now() + 5.5 * 3_600_000 + weeks * 7 * DAY)
  const daysToFriday = (5 - ist.getUTCDay() + 7) % 7 || 7
  const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysToFriday))
  return zonedTimeToInstant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute }, 'Asia/Kolkata')
}
const istOffset = (date: Date) => new Date(date.getTime() + 5.5 * 3_600_000).toISOString().replace('Z', '+05:30') // same instant, IST notation

let app: ReturnType<typeof buildApp>
let adminCookie = ''
let adminCsrf = ''
let customerCookie = ''
let customerCsrf = ''
let adminUserId = ''

type Method = 'get' | 'post' | 'patch'
const asAdmin = (method: Method, path: string, body?: unknown) => {
  const req = request(app)[method](`/api/v1/admin${path}`).set('Cookie', adminCookie)
  if (method !== 'get') req.set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', adminCsrf)
  return body === undefined ? req : req.send(body as object)
}
const publicGet = (path: string) => request(app).get(`/api/v1${path}`)
const productId = async (slug: string) => (await prisma.product.findUniqueOrThrow({ where: { slug } })).id
const auditCount = (action: string) => prisma.auditEvent.count({ where: { action, actorUserId: adminUserId } })

beforeAll(async () => {
  database = await startTestDatabase()
  await prismaCli(['migrate', 'deploy'], database.url) // all three migrations
  prisma = createPrismaClient(database.url, { maxConnections: 1 })
  await prisma.$executeRawUnsafe(`SET TIME ZONE 'Etc/GMT-5'`)
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await database?.stop()
})

describe('UTC guard on admin writes', () => {
  it('refuses to read or write schedules when the database session is not UTC', async () => {
    const repository = createAdminRepository(prisma)
    await expect(repository.listProducts({}, { page: 1, pageSize: 1 })).rejects.toThrow(/must be UTC/)
    await expect(repository.createProduct({ slug: 'x-x', name: 'X', type: 'WEBINAR', price: { amount: '1', currency: 'INR' } }, { userId: '01990000-0000-7000-8000-000000000000', requestId: undefined })).rejects.toThrow(/must be UTC/)
    expect(await prisma.product.count()).toBe(0)
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
  })
})

describe('Stage 4B admin management', () => {
  beforeAll(async () => {
    await seedCatalog(prisma)
    app = buildApp()
    await runAdminCommand(['grant', '--dev-identity', 'dev-admin-1'], { repository: createAuthRepository(prisma), authConfig: config, actorLabel: 'operator-cli:test', print: () => {} })
    const admin = await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })
    adminCookie = withSession(config, admin.session!)
    adminCsrf = await csrfFor(app, config, admin.session!)
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { identitySubject: 'dev-admin-1' } })).id
    const customer = await signIn(app, config, { subject: 'dev-customer-1' })
    customerCookie = withSession(config, customer.session!)
    customerCsrf = await csrfFor(app, config, customer.session!)
  }, 60_000)

  describe('authorization', () => {
    const endpoints: [Method, string][] = [['get', '/dashboard'], ['get', '/products'], ['post', '/products'], ['get', '/sessions'], ['post', '/sessions'], ['get', '/cohorts'], ['post', '/cohorts']]

    it.each(endpoints)('%s /admin%s → 401 without a session', async (method, path) => {
      const res = await request(app)[method](`/api/v1/admin${path}`).set('Origin', PUBLIC_ORIGIN).send({})
      expect(res.status).toBe(401)
    })

    it.each(endpoints)('%s /admin%s → 403 for a signed-in customer', async (method, path) => {
      const res = await request(app)[method](`/api/v1/admin${path}`).set('Cookie', customerCookie).set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', customerCsrf).send({})
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('requires CSRF and an allowed Origin for admin writes', async () => {
      const noCsrf = await request(app).post('/api/v1/admin/products').set('Cookie', adminCookie).set('Origin', PUBLIC_ORIGIN).send({})
      expect(noCsrf.body.error.code).toBe('CSRF_FAILED')
      const badOrigin = await request(app).post('/api/v1/admin/products').set('Cookie', adminCookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', adminCsrf).send({})
      expect(badOrigin.body.error.code).toBe('CSRF_FAILED')
    })
  })

  describe('products', () => {
    it('lists every product for admins, including inactive ones, with pagination and filters', async () => {
      const all = await asAdmin('get', '/products?pageSize=2')
      expect(all.status).toBe(200)
      expect(all.headers['cache-control']).toBe('no-store')
      expect(all.body.meta).toEqual({ page: 1, pageSize: 2, total: 5 })
      expect(all.body.data).toHaveLength(2)
      const inactive = await asAdmin('get', '/products?active=false')
      expect(inactive.body.data.map((p: { slug: string }) => p.slug).sort()).toEqual(['crash-course', 'detailed-training'])
      expect((await asAdmin('get', '/products?q=WEBIN')).body.data.map((p: { slug: string }) => p.slug)).toEqual(['monthly-webinar'])
      expect((await asAdmin('get', '/products?active=yes')).status).toBe(400)
    })

    it('creates a product (inactive until activated), audits it, and keeps it out of the public catalog', async () => {
      const res = await asAdmin('post', '/products', { slug: 'weekend-webinar', name: 'Weekend Webinar', type: 'WEBINAR', summary: 'Saturday Q&A', price: { amount: '199', currency: 'INR' } })
      expect(res.status).toBe(201)
      expect(res.body.data).toMatchObject({ slug: 'weekend-webinar', type: 'WEBINAR', isActive: false, price: { amount: '199.00', currency: 'INR' }, description: null })
      expect(await auditCount('PRODUCT_CREATED')).toBe(1)
      expect((await publicGet('/products')).body.data.map((p: { slug: string }) => p.slug)).not.toContain('weekend-webinar')
    })

    it('activates and deactivates: the public catalog follows, nothing is deleted', async () => {
      const id = await productId('weekend-webinar')
      expect((await asAdmin('post', `/products/${id}/activate`)).body.data.isActive).toBe(true)
      expect((await publicGet('/products')).body.data.map((p: { slug: string }) => p.slug)).toContain('weekend-webinar')
      expect((await asAdmin('post', `/products/${id}/deactivate`)).body.data.isActive).toBe(false)
      expect((await publicGet('/products/weekend-webinar')).status).toBe(404)
      expect(await prisma.product.count({ where: { slug: 'weekend-webinar' } })).toBe(1)
      expect(await auditCount('PRODUCT_ACTIVATED')).toBe(1)
      expect(await auditCount('PRODUCT_DEACTIVATED')).toBe(1)
    })

    it('edits a price exactly; the public API shows the new price; the audit keeps old and new', async () => {
      const id = await productId('monthly-webinar')
      const res = await asAdmin('patch', `/products/${id}`, { price: { amount: '179.50', currency: 'INR' } })
      expect(res.body.data.price).toEqual({ amount: '179.50', currency: 'INR' })
      expect((await publicGet('/products/monthly-webinar')).body.data.price).toEqual({ amount: '179.50', currency: 'INR' })
      const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'PRODUCT_UPDATED', targetId: id } })
      expect(event.details).toMatchObject({ price: { from: { amount: '149.00', currency: 'INR' }, to: { amount: '179.50', currency: 'INR' } } })
      await asAdmin('patch', `/products/${id}`, { price: { amount: '149', currency: 'INR' } })
    })

    it.each([
      ['an unknown type', { type: 'PODCAST' }, /type/],
      ['a malformed slug', { slug: 'Weekend Webinar' }, /slug/],
      ['a blank name', { name: '   ' }, /name: must not be blank/],
      ['a negative price', { price: { amount: '-1', currency: 'INR' } }, /price.amount/],
      ['a float price', { price: { amount: 149.5, currency: 'INR' } }, /price.amount/],
      ['three decimals', { price: { amount: '1.005', currency: 'INR' } }, /at most 2 decimals/],
      ['a lower-case currency', { price: { amount: '10', currency: 'inr' } }, /currency/],
      ['an unknown field', { isActive: true }, /unknown field\(s\): isActive/],
    ])('rejects creating a product with %s', async (_label, change, message) => {
      const res = await asAdmin('post', '/products', { slug: 'valid-slug', name: 'Valid', type: 'WEBINAR', price: { amount: '10', currency: 'INR' }, ...change })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(message) })
    })

    it('rejects a duplicate slug (409), a type change (400), unknown and malformed ids', async () => {
      const dup = await asAdmin('post', '/products', { slug: 'monthly-webinar', name: 'Dup', type: 'WEBINAR', price: { amount: '1', currency: 'INR' } })
      expect(dup.status).toBe(409)
      expect(dup.body.error.code).toBe('SLUG_TAKEN')
      const id = await productId('monthly-webinar')
      expect((await asAdmin('patch', `/products/${id}`, { type: 'OFFLINE_WORKSHOP' })).body.error.message).toMatch(/unknown field\(s\): type/)
      expect((await asAdmin('patch', `/products/${id}`, {})).status).toBe(400)
      expect((await asAdmin('get', '/products/01990000-0000-7000-8000-000000000000')).body.error.code).toBe('PRODUCT_NOT_FOUND')
      expect((await asAdmin('get', '/products/not-a-uuid')).body.error.code).toBe('INVALID_PATH')
    })
  })

  describe('webinar sessions', () => {
    let webinarId = ''
    const start = () => new Date(fridayIst(3).getTime() + DAY) // a Saturday 18:30 IST, 3+ weeks out

    it('creates a draft webinar that stays hidden from the public', async () => {
      const res = await asAdmin('post', '/sessions', { productId: await productId('monthly-webinar'), startsAt: istOffset(start()), endsAt: istOffset(new Date(start().getTime() + 3_600_000)), capacity: 40, internalNote: 'confirm speaker' })
      expect(res.status).toBe(201)
      expect(res.body.data).toMatchObject({ status: 'DRAFT', capacity: 40, venue: null, timezone: 'Asia/Kolkata', internalNote: 'confirm speaker', startsAt: start().toISOString() })
      webinarId = res.body.data.id
      expect((await publicGet('/sessions?type=WEBINAR')).body.data).toEqual([])
      expect((await publicGet(`/sessions/${webinarId}`)).status).toBe(404)
    })

    it('publishes it: the public API shows it, without internal fields', async () => {
      const res = await asAdmin('post', `/sessions/${webinarId}/publish`)
      expect(res.body.data.status).toBe('PUBLISHED')
      const pub = await publicGet('/sessions?type=WEBINAR')
      expect(pub.body.data.map((s: { id: string }) => s.id)).toEqual([webinarId])
      expect(JSON.stringify(pub.body)).not.toMatch(/confirm speaker|internalNote|status/)
      expect((await asAdmin('post', `/sessions/${webinarId}/publish`)).body.error.code).toBe('INVALID_STATE') // already published
    })

    it('reschedules it; the public API reflects the new time; the audit records the move', async () => {
      const later = new Date(start().getTime() + 7 * DAY)
      const res = await asAdmin('patch', `/sessions/${webinarId}`, { startsAt: later.toISOString(), endsAt: new Date(later.getTime() + 3_600_000).toISOString() })
      expect(res.body.data).toMatchObject({ status: 'PUBLISHED', startsAt: later.toISOString() })
      expect((await publicGet(`/sessions/${webinarId}`)).body.data.startsAt).toBe(later.toISOString())
      expect(await auditCount('SESSION_RESCHEDULED')).toBe(1)
    })

    it('cancels it: hidden publicly, kept for admins, and frozen', async () => {
      const res = await asAdmin('post', `/sessions/${webinarId}/cancel`, { reason: 'Speaker unavailable' })
      expect(res.body.data.status).toBe('CANCELLED')
      expect((await publicGet('/sessions?type=WEBINAR')).body.data).toEqual([])
      expect((await asAdmin('get', '/sessions?type=WEBINAR&status=CANCELLED')).body.data.map((s: { id: string }) => s.id)).toEqual([webinarId])
      expect((await asAdmin('patch', `/sessions/${webinarId}`, { capacity: 10 })).body.error.code).toBe('INVALID_STATE')
      expect((await asAdmin('post', `/sessions/${webinarId}/publish`)).body.error.code).toBe('INVALID_STATE')
      expect(await prisma.session.count({ where: { id: webinarId } })).toBe(1)
      const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'SESSION_CANCELLED', targetId: webinarId } })
      expect(event.details).toMatchObject({ previousStatus: 'PUBLISHED', reason: 'Speaker unavailable' })
    })

    it.each([
      ['a start in the past', { startsAt: new Date(Date.now() - DAY).toISOString() }, 'START_IN_PAST'],
      ['an end before the start', { endsAt: new Date(Date.now() + 2 * DAY).toISOString() }, 'INVALID_TIME_RANGE'],
      ['capacity 0', { capacity: 0 }, 'INVALID_REQUEST'],
      ['a local time without offset', { startsAt: '2026-12-01T18:30:00' }, 'INVALID_REQUEST'],
      ['a status field', { status: 'PUBLISHED' }, 'INVALID_REQUEST'],
    ])('rejects a webinar with %s', async (_label, change, errorCode) => {
      const startsAt = new Date(Date.now() + 10 * DAY).toISOString()
      const res = await asAdmin('post', '/sessions', { productId: await productId('monthly-webinar'), startsAt, ...change })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe(errorCode)
    })

    it('rejects a second session at the same instant (409) and refuses publishing for an inactive product', async () => {
      const webinar = await productId('monthly-webinar')
      const at = new Date(Date.now() + 40 * DAY).toISOString()
      expect((await asAdmin('post', '/sessions', { productId: webinar, startsAt: at })).status).toBe(201)
      const dup = await asAdmin('post', '/sessions', { productId: webinar, startsAt: at })
      expect(dup.status).toBe(409)
      expect(dup.body.error.code).toBe('SESSION_CONFLICT')

      const inactive = await asAdmin('post', '/sessions', { productId: await productId('weekend-webinar'), startsAt: at })
      expect((await asAdmin('post', `/sessions/${inactive.body.data.id}/publish`)).body.error.code).toBe('PRODUCT_INACTIVE')
    })

    it('refuses standalone sessions for online training (cohorts only)', async () => {
      const res = await asAdmin('post', '/sessions', { productId: await productId('online-training'), startsAt: fridayIst(2).toISOString() })
      expect(res.body.error.code).toBe('USE_COHORTS')
    })
  })

  describe('offline workshop batches', () => {
    let batchId = ''
    const start = () => new Date(fridayIst(4).getTime() + DAY - 9 * 3_600_000) // a Saturday 09:30 IST
    const end = () => new Date(start().getTime() + 4 * DAY + 8 * 3_600_000) // Wednesday 17:30 IST

    it.each([
      ['no venue', { venue: null }, 'VENUE_REQUIRED'],
      ['a blank venue', { venue: '   ' }, 'VENUE_REQUIRED'],
      ['no end', { endsAt: null }, 'END_REQUIRED'],
    ])('requires a venue and an end date (%s)', async (_label, change, errorCode) => {
      const res = await asAdmin('post', '/sessions', { productId: await productId('offline-workshop'), startsAt: start().toISOString(), endsAt: end().toISOString(), venue: 'Afforestt Farm, Kashipur', ...change })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe(errorCode)
    })

    it('creates, publishes and edits a batch; the public session carries venue and end date', async () => {
      const res = await asAdmin('post', '/sessions', { productId: await productId('offline-workshop'), startsAt: start().toISOString(), endsAt: end().toISOString(), venue: 'Afforestt Farm, Kashipur', capacity: 12 })
      expect(res.status).toBe(201)
      batchId = res.body.data.id
      await asAdmin('post', `/sessions/${batchId}/publish`)
      expect((await asAdmin('patch', `/sessions/${batchId}`, { venue: 'Maruvan, Rajasthan' })).body.data.venue).toBe('Maruvan, Rajasthan')
      const pub = await publicGet('/sessions?type=OFFLINE_WORKSHOP')
      expect(pub.body.data).toEqual([expect.objectContaining({ id: batchId, venue: 'Maruvan, Rajasthan', capacity: 12, startsAt: start().toISOString(), endsAt: end().toISOString() })])
      expect((await asAdmin('patch', `/sessions/${batchId}`, { endsAt: start().toISOString() })).body.error.code).toBe('INVALID_TIME_RANGE')
      expect((await asAdmin('patch', `/sessions/${batchId}`, { venue: null })).body.error.code).toBe('VENUE_REQUIRED')
    })
  })

  describe('online training cohorts (two linked Fridays)', () => {
    let cohortId = ''

    it.each([
      ['a Thursday', () => new Date(fridayIst(2).getTime() - DAY), 'NOT_A_FRIDAY'],
      ['a past Friday', () => new Date(fridayIst(0).getTime() - 14 * DAY), 'START_IN_PAST'],
    ])('rejects a first session on %s', async (_label, first, errorCode) => {
      const res = await asAdmin('post', '/cohorts', { productId: await productId('online-training'), firstSessionStartsAt: first().toISOString() })
      expect(res.body.error.code).toBe(errorCode)
    })

    it('rejects a second session that is not exactly one week later, and non-training products', async () => {
      const first = fridayIst(2)
      const twoWeeks = await asAdmin('post', '/cohorts', { productId: await productId('online-training'), firstSessionStartsAt: first.toISOString(), secondSessionStartsAt: new Date(first.getTime() + 14 * DAY).toISOString() })
      expect(twoWeeks.body.error.code).toBe('SECOND_SESSION_MISMATCH')
      const wrongType = await asAdmin('post', '/cohorts', { productId: await productId('monthly-webinar'), firstSessionStartsAt: first.toISOString() })
      expect(wrongType.body.error.code).toBe('PRODUCT_TYPE_MISMATCH')
    })

    it('creates a draft cohort with two 4-hour Friday sessions exactly 7 days apart', async () => {
      const first = fridayIst(2)
      const res = await asAdmin('post', '/cohorts', { productId: await productId('online-training'), firstSessionStartsAt: istOffset(first), secondSessionStartsAt: istOffset(new Date(first.getTime() + 7 * DAY)), capacity: 20 })
      expect(res.status).toBe(201)
      cohortId = res.body.data.id
      expect(res.body.data).toMatchObject({ status: 'DRAFT', capacity: 20, timezone: 'Asia/Kolkata' })
      expect(res.body.data.sessions).toEqual([
        { id: expect.any(String), sequence: 1, startsAt: first.toISOString(), endsAt: new Date(first.getTime() + 4 * 3_600_000).toISOString(), status: 'DRAFT' },
        { id: expect.any(String), sequence: 2, startsAt: new Date(first.getTime() + 7 * DAY).toISOString(), endsAt: new Date(first.getTime() + 7 * DAY + 4 * 3_600_000).toISOString(), status: 'DRAFT' },
      ])
      expect((await publicGet('/cohorts')).body.data).toEqual([])
    })

    it('publishes cohort and both sessions together; public /cohorts shows it, /sessions never lists its parts', async () => {
      const res = await asAdmin('post', `/cohorts/${cohortId}/publish`)
      expect(res.body.data.status).toBe('PUBLISHED')
      expect(res.body.data.sessions.map((s: { status: string }) => s.status)).toEqual(['PUBLISHED', 'PUBLISHED'])
      const pub = await publicGet('/cohorts?product=online-training')
      expect(pub.body.data).toEqual([expect.objectContaining({ id: cohortId, capacity: 20, product: expect.objectContaining({ slug: 'online-training', price: { amount: '500.00', currency: 'USD' } }) })])
      expect(pub.body.data[0].sessions.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2])
      expect((await publicGet('/sessions?type=ONLINE_TRAINING')).body.data).toEqual([])
      expect((await publicGet(`/cohorts/${cohortId}`)).status).toBe(200)
    })

    it('refuses to edit one of its sessions individually (cohort-managed)', async () => {
      const sessionId = (await asAdmin('get', `/cohorts/${cohortId}`)).body.data.sessions[0].id
      expect((await asAdmin('patch', `/sessions/${sessionId}`, { capacity: 5 })).body.error.code).toBe('COHORT_MANAGED')
      expect((await asAdmin('post', `/sessions/${sessionId}/cancel`, {})).body.error.code).toBe('COHORT_MANAGED')
    })

    it('reschedules both sessions together, even one week later (no self-collision)', async () => {
      const newFirst = fridayIst(3)
      const res = await asAdmin('patch', `/cohorts/${cohortId}`, { firstSessionStartsAt: newFirst.toISOString() })
      expect(res.status).toBe(200)
      expect(res.body.data.sessions.map((s: { startsAt: string }) => s.startsAt)).toEqual([newFirst.toISOString(), new Date(newFirst.getTime() + 7 * DAY).toISOString()])
      expect((await publicGet(`/cohorts/${cohortId}`)).body.data.sessions[0].startsAt).toBe(newFirst.toISOString())
      expect((await asAdmin('patch', `/cohorts/${cohortId}`, { secondSessionStartsAt: newFirst.toISOString() })).body.error.code).toBe('SECOND_SESSION_MISMATCH')
    })

    it('hides the cohort publicly if either session is ever not published (fails closed)', async () => {
      const second = await prisma.session.findFirstOrThrow({ where: { cohortId, cohortSequence: 2 } })
      await prisma.session.update({ where: { id: second.id }, data: { status: 'DRAFT' } })
      expect((await publicGet('/cohorts')).body.data).toEqual([])
      await prisma.session.update({ where: { id: second.id }, data: { status: 'PUBLISHED' } })
      expect((await publicGet('/cohorts')).body.data).toHaveLength(1)
    })

    it('cannot publish an incomplete or invalid cohort', async () => {
      const first = fridayIst(6)
      const draft = (await asAdmin('post', '/cohorts', { productId: await productId('online-training'), firstSessionStartsAt: first.toISOString() })).body.data
      // Simulate damage outside the API: one session shortened to 3 hours.
      await prisma.session.update({ where: { id: draft.sessions[1].id }, data: { endsAt: new Date(first.getTime() + 7 * DAY + 3 * 3_600_000) } })
      const res = await asAdmin('post', `/cohorts/${draft.id}/publish`)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('COHORT_INCOMPLETE')
      expect((await prisma.trainingCohort.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT')
      expect(await prisma.session.count({ where: { cohortId: draft.id, status: 'PUBLISHED' } })).toBe(0)
    })

    it('rolls back completely when the second session collides with an existing one', async () => {
      // Existing cohort's first session is fridayIst(3); a new cohort starting a week earlier would put its
      // second session at that same instant → unique violation on the 2nd insert → nothing is kept.
      const [cohortsBefore, sessionsBefore] = [await prisma.trainingCohort.count(), await prisma.session.count()]
      const res = await asAdmin('post', '/cohorts', { productId: await productId('online-training'), firstSessionStartsAt: fridayIst(2).toISOString() })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('SESSION_CONFLICT')
      expect([await prisma.trainingCohort.count(), await prisma.session.count()]).toEqual([cohortsBefore, sessionsBefore])
    })

    it('cancels cohort and both sessions together; hidden publicly; history kept', async () => {
      const res = await asAdmin('post', `/cohorts/${cohortId}/cancel`, { reason: 'Trainer ill' })
      expect(res.body.data.status).toBe('CANCELLED')
      expect(res.body.data.sessions.map((s: { status: string }) => s.status)).toEqual(['CANCELLED', 'CANCELLED'])
      expect((await publicGet('/cohorts')).body.data).toEqual([])
      expect((await publicGet(`/cohorts/${cohortId}`)).status).toBe(404)
      expect((await asAdmin('post', `/cohorts/${cohortId}/publish`)).body.error.code).toBe('INVALID_STATE')
      expect(await prisma.session.count({ where: { cohortId } })).toBe(2)
    })
  })

  describe('dashboard', () => {
    it('summarises real records only, with no booking figures before Stage 4C', async () => {
      const res = await asAdmin('get', '/dashboard')
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        products: { active: 3, inactive: 3 },
        upcoming: { WEBINAR: { published: 0 }, OFFLINE_WORKSHOP: { published: 1, draft: 0 }, ONLINE_TRAINING: { published: 0, draft: 1 } },
        capacityTracking: 'not_available_until_bookings_exist',
      })
      expect(res.body.data.upcoming.OFFLINE_WORKSHOP.next[0]).toMatchObject({ kind: 'session', productName: 'Offline Workshop' })
      // Only real schedule/product figures: no booking or seat numbers exist before Stage 4C.
      expect(Object.keys(res.body.data).sort()).toEqual(['cancelledUpcoming', 'capacityTracking', 'products', 'upcoming'])
      expect(Object.keys(res.body.data.upcoming.WEBINAR).sort()).toEqual(['draft', 'next', 'published'])
    })
  })

  it('returns a client-safe 503 when the admin data store fails', async () => {
    const lines: LoggedLine[] = []
    const broken = createAdminRepository(prisma)
    broken.listProducts = () => Promise.reject(new Error('connect ECONNREFUSED postgresql://app:hunter2@db/diy'))
    const brokenApp = buildApp(broken, lines)
    const res = await request(brokenApp).get('/api/v1/admin/products').set('Cookie', adminCookie)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('ADMIN_UNAVAILABLE')
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|ECONNREFUSED|postgresql/)
    expect(JSON.stringify(lines)).toMatch(/ECONNREFUSED/)
  })

  it('records every admin change in the audit trail, attributed to the admin', async () => {
    const actions = (await prisma.auditEvent.findMany({ where: { actorUserId: adminUserId }, select: { action: true } })).map((e) => e.action)
    for (const action of ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'SESSION_CREATED', 'SESSION_PUBLISHED', 'SESSION_RESCHEDULED', 'SESSION_CANCELLED', 'COHORT_CREATED', 'COHORT_PUBLISHED', 'COHORT_RESCHEDULED', 'COHORT_CANCELLED']) {
      expect(actions).toContain(action)
    }
  })
})
