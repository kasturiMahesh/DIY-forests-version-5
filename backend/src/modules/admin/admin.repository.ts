import { assertUtcSession } from '../../db/timezone-guard.js'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js'
import { isCheckViolation } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { ORGANIZER_TIMEZONE } from '../../lib/time.js'
import { checkSingleSession, cohortTimesAreValid, deriveCohortTimes, invalid } from './schedule-rules.js'

type Tx = Prisma.TransactionClient
type ProductType = 'ONLINE_TRAINING' | 'OFFLINE_WORKSHOP' | 'WEBINAR'
type Status = 'DRAFT' | 'PUBLISHED' | 'CANCELLED'
export type Actor = { userId: string; requestId: string | undefined }
export type Page = { page: number; pageSize: number }
export type Paged<T> = { items: T[]; total: number }

/** Drops keys whose value is undefined ("not supplied"), keeping explicit nulls ("clear this field"). */
const definedOnly = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> }
const notFound = (what: string) => new HttpError(404, `${what.toUpperCase()}_NOT_FOUND`, `${what[0]!.toUpperCase()}${what.slice(1)} not found`)
const conflict = (code: string, message: string) => new HttpError(409, code, message)
const capacityBelowHeld = (seatsHeld?: number) =>
  conflict('CAPACITY_BELOW_HELD', seatsHeld === undefined ? 'Capacity cannot be lower than the seats already held by bookings' : `Capacity cannot be lower than the ${seatsHeld} seat${seatsHeld === 1 ? '' : 's'} already held by bookings`)

// ---- admin views (never exposed publicly) ----

const PRODUCT_ADMIN_SELECT = {
  id: true, slug: true, name: true, type: true, summary: true, description: true, audience: true, durationLabel: true,
  priceAmount: true, currency: true, isActive: true, createdAt: true, updatedAt: true,
} as const
/** Products that have not been archived. */
const LIVE_PRODUCT = { archivedAt: null } satisfies Prisma.ProductWhereInput
const PRODUCT_REF_SELECT = { id: true, slug: true, name: true, type: true, isActive: true } as const
const SESSION_ADMIN_SELECT = {
  id: true, startsAt: true, endsAt: true, timezone: true, capacity: true, seatsHeld: true, status: true, internalNote: true, venue: true,
  cohortId: true, cohortSequence: true, createdAt: true, updatedAt: true, product: { select: PRODUCT_REF_SELECT },
} as const
const COHORT_ADMIN_SELECT = {
  id: true, status: true, timezone: true, capacity: true, seatsHeld: true, internalNote: true, createdAt: true, updatedAt: true,
  product: { select: PRODUCT_REF_SELECT },
  sessions: { select: { id: true, cohortSequence: true, startsAt: true, endsAt: true, status: true }, orderBy: { cohortSequence: 'asc' as const } },
} as const

type ProductRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_ADMIN_SELECT }>
type SessionRow = Prisma.SessionGetPayload<{ select: typeof SESSION_ADMIN_SELECT }>
type CohortRow = Prisma.TrainingCohortGetPayload<{ select: typeof COHORT_ADMIN_SELECT }>

export const adminProduct = (row: ProductRow, counts?: Record<Status, number>) => ({
  id: row.id, slug: row.slug, name: row.name, type: row.type, summary: row.summary, description: row.description, audience: row.audience,
  durationLabel: row.durationLabel, price: { amount: row.priceAmount.toFixed(2), currency: row.currency }, isActive: row.isActive,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), ...(counts ? { scheduleCounts: counts } : {}),
})
export const adminSession = (row: SessionRow) => ({
  id: row.id, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null, timezone: row.timezone, capacity: row.capacity, seatsHeld: row.seatsHeld,
  status: row.status, venue: row.venue, internalNote: row.internalNote, cohortId: row.cohortId, cohortSequence: row.cohortSequence,
  product: row.product, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
})
export const adminCohort = (row: CohortRow) => ({
  id: row.id, status: row.status, timezone: row.timezone, capacity: row.capacity, seatsHeld: row.seatsHeld, internalNote: row.internalNote, product: row.product,
  sessions: row.sessions.map((session) => ({ id: session.id, sequence: session.cohortSequence, startsAt: session.startsAt.toISOString(), endsAt: session.endsAt?.toISOString() ?? null, status: session.status })),
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
})
export type AdminProduct = ReturnType<typeof adminProduct>
export type AdminSession = ReturnType<typeof adminSession>
export type AdminCohort = ReturnType<typeof adminCohort>

// ---- inputs (already validated by admin.schemas.ts) ----

export type ProductInput = { slug: string; name: string; type: ProductType; summary?: string | null | undefined; description?: string | null | undefined; audience?: string | null | undefined; durationLabel?: string | null | undefined; price: { amount: string; currency: string } }
/** Optional fields may be present-but-undefined (zod output); undefined means "leave unchanged". */
type PatchOf<T> = { [K in keyof T]?: T[K] | undefined }
export type ProductPatch = PatchOf<Omit<ProductInput, 'type'>>
export type SessionInput = { productId: string; startsAt: Date; endsAt?: Date | null | undefined; venue?: string | null | undefined; capacity?: number | null | undefined; internalNote?: string | null | undefined }
export type SessionPatch = PatchOf<Omit<SessionInput, 'productId'>>
export type CohortInput = { productId: string; firstSessionStartsAt: Date; secondSessionStartsAt?: Date | undefined; capacity?: number | null | undefined; internalNote?: string | null | undefined }
export type CohortPatch = PatchOf<Omit<CohortInput, 'productId'>>

export interface AdminRepository {
  dashboard(now: Date): Promise<DashboardSummary>
  listProducts(filter: { type?: ProductType | undefined; active?: boolean | undefined; q?: string | undefined }, page: Page): Promise<Paged<AdminProduct>>
  getProduct(id: string): Promise<AdminProduct>
  createProduct(input: ProductInput, actor: Actor): Promise<AdminProduct>
  updateProduct(id: string, patch: ProductPatch, actor: Actor): Promise<AdminProduct>
  setProductActive(id: string, isActive: boolean, actor: Actor): Promise<AdminProduct>
  listSessions(filter: { type?: 'WEBINAR' | 'OFFLINE_WORKSHOP' | undefined; productId?: string | undefined; status?: Status | undefined; from?: Date | undefined; to?: Date | undefined }, page: Page): Promise<Paged<AdminSession>>
  getSession(id: string): Promise<AdminSession>
  createSession(input: SessionInput, actor: Actor, now: Date): Promise<AdminSession>
  updateSession(id: string, patch: SessionPatch, actor: Actor, now: Date): Promise<AdminSession>
  publishSession(id: string, actor: Actor, now: Date): Promise<AdminSession>
  cancelSession(id: string, reason: string | null, actor: Actor): Promise<AdminSession>
  listCohorts(filter: { productId?: string | undefined; status?: Status | undefined; from?: Date | undefined; to?: Date | undefined }, page: Page): Promise<Paged<AdminCohort>>
  getCohort(id: string): Promise<AdminCohort>
  createCohort(input: CohortInput, actor: Actor, now: Date): Promise<AdminCohort>
  updateCohort(id: string, patch: CohortPatch, actor: Actor, now: Date): Promise<AdminCohort>
  publishCohort(id: string, actor: Actor, now: Date): Promise<AdminCohort>
  cancelCohort(id: string, reason: string | null, actor: Actor): Promise<AdminCohort>
}

export type DashboardSummary = {
  products: { active: number; inactive: number }
  upcoming: Record<ProductType, { published: number; draft: number; next: { id: string; startsAt: string; productName: string; kind: 'session' | 'cohort' }[] }>
  cancelledUpcoming: number
  /** Stage 4C. No payment exists yet, so every active booking is pending payment. */
  bookings: { pendingPayment: number; cancelled: number }
}

export function createAdminRepository(prisma: PrismaClient): AdminRepository {
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  /** Runs a write in a transaction; unique violations become client-safe 409s. */
  async function write<T>(work: (tx: Tx) => Promise<T>, uniqueConflict: () => HttpError): Promise<T> {
    await ready()
    try {
      return await prisma.$transaction(work)
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') throw uniqueConflict()
      // Backstop for the explicit check below: the CHECK "seats_held <= capacity" holds even under races.
      if (isCheckViolation(error, 'sessions_seats_held_within_capacity') || isCheckViolation(error, 'training_cohorts_seats_held_within_capacity')) throw capacityBelowHeld()
      throw error
    }
  }
  // Row locks taken before reading seats_held, so a concurrent booking (which locks the same row
  // FOR UPDATE before reserving) cannot slip in between this check and the update.
  const lockSession = (tx: Tx, id: string) => tx.$queryRaw`SELECT 1 FROM "sessions" WHERE "id" = ${id}::uuid FOR UPDATE`
  const lockCohort = (tx: Tx, id: string) => tx.$queryRaw`SELECT 1 FROM "training_cohorts" WHERE "id" = ${id}::uuid FOR UPDATE`
  const checkCapacity = (capacity: number | null | undefined, seatsHeld: number) => {
    if (capacity !== undefined && capacity !== null && capacity < seatsHeld) throw capacityBelowHeld(seatsHeld)
  }
  const hasBookings = (seatsHeld: number, what: string) =>
    conflict('HAS_ACTIVE_BOOKINGS', `This ${what} has ${seatsHeld} active booking${seatsHeld === 1 ? '' : 's'}. Cancel ${seatsHeld === 1 ? 'it' : 'them'} first (Bookings), so customers are not moved to dates they did not choose.`)
  const audit = (tx: Tx, actor: Actor, action: string, targetType: string, targetId: string, details?: Prisma.InputJsonValue) =>
    tx.auditEvent.create({ data: { actorUserId: actor.userId, actorLabel: 'admin', action, targetType, targetId, requestId: actor.requestId ?? null, ...(details !== undefined ? { details } : {}) } })

  // Archived (retired) products are kept only for the history of their sessions; to admins they no longer exist.
  const productOrThrow = async (tx: Tx | PrismaClient, id: string) => {
    const product = await tx.product.findFirst({ where: { id, ...LIVE_PRODUCT }, select: { id: true, type: true, isActive: true } })
    if (!product) throw notFound('product')
    return product
  }
  const sessionOrThrow = async (tx: Tx | PrismaClient, id: string) => {
    const session = await tx.session.findUnique({ where: { id }, select: SESSION_ADMIN_SELECT })
    if (!session) throw notFound('session')
    return session
  }
  const cohortOrThrow = async (tx: Tx | PrismaClient, id: string) => {
    const cohort = await tx.trainingCohort.findUnique({ where: { id }, select: COHORT_ADMIN_SELECT })
    if (!cohort) throw notFound('cohort')
    return cohort
  }
  const notInPast = (startsAt: Date, now: Date) => {
    if (startsAt.getTime() <= now.getTime()) throw invalid('START_IN_PAST', 'The start must be in the future')
  }
  const sessionConflict = () => conflict('SESSION_CONFLICT', 'This product already has a session starting at that time')

  return {
    async dashboard(now) {
      await ready()
      const [active, inactive] = await Promise.all([prisma.product.count({ where: { isActive: true, ...LIVE_PRODUCT } }), prisma.product.count({ where: { isActive: false, ...LIVE_PRODUCT } })])
      const upcoming = {} as DashboardSummary['upcoming']
      for (const type of ['WEBINAR', 'OFFLINE_WORKSHOP'] as const) {
        const where = { cohortId: null, startsAt: { gte: now }, product: { type } }
        const [published, draft, next] = await Promise.all([
          prisma.session.count({ where: { ...where, status: 'PUBLISHED' } }),
          prisma.session.count({ where: { ...where, status: 'DRAFT' } }),
          prisma.session.findMany({ where: { ...where, status: 'PUBLISHED' }, orderBy: { startsAt: 'asc' }, take: 3, select: { id: true, startsAt: true, product: { select: { name: true } } } }),
        ])
        upcoming[type] = { published, draft, next: next.map((row) => ({ id: row.id, startsAt: row.startsAt.toISOString(), productName: row.product.name, kind: 'session' as const })) }
      }
      const cohortWhere = (status: Status) => ({ status, sessions: { some: { cohortSequence: 1, startsAt: { gte: now } } } })
      const [publishedCohorts, draftCohorts, nextCohorts, cancelledSessions, cancelledCohorts] = await Promise.all([
        prisma.trainingCohort.count({ where: cohortWhere('PUBLISHED') }),
        prisma.trainingCohort.count({ where: cohortWhere('DRAFT') }),
        prisma.session.findMany({ where: { cohortSequence: 1, status: 'PUBLISHED', startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, take: 3, select: { cohortId: true, startsAt: true, product: { select: { name: true } } } }),
        prisma.session.count({ where: { cohortId: null, status: 'CANCELLED', startsAt: { gte: now } } }),
        prisma.trainingCohort.count({ where: cohortWhere('CANCELLED') }),
      ])
      upcoming.ONLINE_TRAINING = { published: publishedCohorts, draft: draftCohorts, next: nextCohorts.map((row) => ({ id: row.cohortId!, startsAt: row.startsAt.toISOString(), productName: row.product.name, kind: 'cohort' as const })) }
      const [pendingPayment, cancelledBookings] = await Promise.all([prisma.booking.count({ where: { status: 'PENDING_PAYMENT' } }), prisma.booking.count({ where: { status: 'CANCELLED' } })])
      return { products: { active, inactive }, upcoming, cancelledUpcoming: cancelledSessions + cancelledCohorts, bookings: { pendingPayment, cancelled: cancelledBookings } }
    },

    // ---- products ----

    async listProducts({ type, active, q }, { page, pageSize }) {
      await ready()
      const where: Prisma.ProductWhereInput = {
        ...LIVE_PRODUCT,
        ...(type ? { type } : {}), ...(active !== undefined ? { isActive: active } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q.toLowerCase() } }] } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.product.findMany({ where, select: PRODUCT_ADMIN_SELECT, orderBy: [{ isActive: 'desc' }, { type: 'asc' }, { name: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
        prisma.product.count({ where }),
      ])
      return { items: rows.map((row) => adminProduct(row)), total }
    },

    async getProduct(id) {
      await ready()
      const row = await prisma.product.findFirst({ where: { id, ...LIVE_PRODUCT }, select: PRODUCT_ADMIN_SELECT })
      if (!row) throw notFound('product')
      const grouped = await prisma.session.groupBy({ by: ['status'], where: { productId: id }, _count: { _all: true } })
      const counts = { DRAFT: 0, PUBLISHED: 0, CANCELLED: 0 } as Record<Status, number>
      for (const group of grouped) counts[group.status] = group._count._all
      return adminProduct(row, counts)
    },

    async createProduct(input, actor) {
      return write(async (tx) => {
        // New products start inactive: an admin activates them deliberately once ready.
        const row = await tx.product.create({
          data: {
            slug: input.slug, name: input.name, type: input.type, summary: input.summary ?? null, description: input.description ?? null,
            audience: input.audience ?? null, durationLabel: input.durationLabel ?? null, priceAmount: input.price.amount, currency: input.price.currency, isActive: false,
          },
          select: PRODUCT_ADMIN_SELECT,
        })
        await audit(tx, actor, 'PRODUCT_CREATED', 'product', row.id, { slug: row.slug, type: row.type, price: input.price })
        return adminProduct(row)
      }, () => conflict('SLUG_TAKEN', 'Another product already uses that slug'))
    },

    async updateProduct(id, patch, actor) {
      return write(async (tx) => {
        const before = await tx.product.findFirst({ where: { id, ...LIVE_PRODUCT }, select: PRODUCT_ADMIN_SELECT })
        if (!before) throw notFound('product')
        const { price, ...fields } = patch
        const row = await tx.product.update({
          where: { id },
          data: { ...definedOnly(fields), ...(price ? { priceAmount: price.amount, currency: price.currency } : {}) },
          select: PRODUCT_ADMIN_SELECT,
        })
        const details: Record<string, Prisma.InputJsonValue> = { fields: Object.keys(definedOnly(patch)) }
        if (price) details.price = { from: { amount: before.priceAmount.toFixed(2), currency: before.currency }, to: price }
        await audit(tx, actor, 'PRODUCT_UPDATED', 'product', id, details)
        return adminProduct(row)
      }, () => conflict('SLUG_TAKEN', 'Another product already uses that slug'))
    },

    async setProductActive(id, isActive, actor) {
      return write(async (tx) => {
        await productOrThrow(tx, id)
        // Deactivating only hides the product publicly; sessions, cohorts and (later) bookings are kept.
        const row = await tx.product.update({ where: { id }, data: { isActive }, select: PRODUCT_ADMIN_SELECT })
        await audit(tx, actor, isActive ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED', 'product', id)
        return adminProduct(row)
      }, () => conflict('CONFLICT', 'Conflicting change'))
    },

    // ---- webinar and workshop sessions ----

    async listSessions({ type, productId, status, from, to }, { page, pageSize }) {
      await ready()
      const where: Prisma.SessionWhereInput = {
        cohortId: null,
        product: { type: type ? type : { in: ['WEBINAR', 'OFFLINE_WORKSHOP'] } },
        ...(productId ? { productId } : {}), ...(status ? { status } : {}),
        ...(from || to ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.session.findMany({ where, select: SESSION_ADMIN_SELECT, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
        prisma.session.count({ where }),
      ])
      return { items: rows.map(adminSession), total }
    },

    async getSession(id) {
      await ready()
      return adminSession(await sessionOrThrow(prisma, id))
    },

    async createSession(input, actor, now) {
      return write(async (tx) => {
        const product = await productOrThrow(tx, input.productId)
        if (product.type === 'ONLINE_TRAINING') throw invalid('USE_COHORTS', 'Online training dates are created as two-session cohorts (/admin/cohorts)')
        notInPast(input.startsAt, now)
        const value = { startsAt: input.startsAt, endsAt: input.endsAt ?? null, venue: input.venue ?? null }
        checkSingleSession(product.type, value)
        const row = await tx.session.create({
          data: { productId: product.id, ...value, capacity: input.capacity ?? null, internalNote: input.internalNote ?? null, timezone: ORGANIZER_TIMEZONE, status: 'DRAFT' },
          select: SESSION_ADMIN_SELECT,
        })
        await audit(tx, actor, 'SESSION_CREATED', 'session', row.id, { productId: product.id, startsAt: row.startsAt.toISOString() })
        return adminSession(row)
      }, sessionConflict)
    },

    async updateSession(id, patch, actor, now) {
      return write(async (tx) => {
        await lockSession(tx, id)
        const current = await sessionOrThrow(tx, id)
        if (current.cohortId) throw conflict('COHORT_MANAGED', 'This session belongs to an online-training cohort; change it through the cohort')
        if (current.status === 'CANCELLED') throw conflict('INVALID_STATE', 'A cancelled session cannot be changed; create a new one instead')
        const next = {
          startsAt: patch.startsAt ?? current.startsAt,
          endsAt: patch.endsAt !== undefined ? patch.endsAt : current.endsAt,
          venue: patch.venue !== undefined ? patch.venue : current.venue,
        }
        if (patch.startsAt) notInPast(patch.startsAt, now)
        checkSingleSession(current.product.type as 'WEBINAR' | 'OFFLINE_WORKSHOP', next)
        // Stage 4C: customers booked these exact dates and this venue, so they cannot move under a booking.
        const scheduleChanges = next.startsAt.getTime() !== current.startsAt.getTime() || (next.endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null) || next.venue !== current.venue
        if (scheduleChanges && current.seatsHeld > 0) throw hasBookings(current.seatsHeld, 'session')
        checkCapacity(patch.capacity, current.seatsHeld)
        const row = await tx.session.update({
          where: { id },
          data: { ...next, ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}), ...(patch.internalNote !== undefined ? { internalNote: patch.internalNote } : {}) },
          select: SESSION_ADMIN_SELECT,
        })
        const rescheduled = row.startsAt.getTime() !== current.startsAt.getTime() || (row.endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null)
        await audit(tx, actor, rescheduled ? 'SESSION_RESCHEDULED' : 'SESSION_UPDATED', 'session', id, {
          fields: Object.keys(patch), ...(rescheduled ? { from: current.startsAt.toISOString(), to: row.startsAt.toISOString() } : {}),
        })
        return adminSession(row)
      }, sessionConflict)
    },

    async publishSession(id, actor, now) {
      return write(async (tx) => {
        const current = await sessionOrThrow(tx, id)
        if (current.cohortId) throw conflict('COHORT_MANAGED', 'Publish the online-training cohort instead')
        if (current.status !== 'DRAFT') throw conflict('INVALID_STATE', `Only draft sessions can be published (this one is ${current.status.toLowerCase()})`)
        if (!current.product.isActive) throw conflict('PRODUCT_INACTIVE', 'Activate the product before publishing its sessions')
        if (current.startsAt.getTime() <= now.getTime()) throw conflict('START_IN_PAST', 'This session has already started; reschedule it first')
        checkSingleSession(current.product.type as 'WEBINAR' | 'OFFLINE_WORKSHOP', current)
        const row = await tx.session.update({ where: { id }, data: { status: 'PUBLISHED' }, select: SESSION_ADMIN_SELECT })
        await audit(tx, actor, 'SESSION_PUBLISHED', 'session', id)
        return adminSession(row)
      }, sessionConflict)
    },

    async cancelSession(id, reason, actor) {
      return write(async (tx) => {
        await lockSession(tx, id)
        const current = await sessionOrThrow(tx, id)
        if (current.cohortId) throw conflict('COHORT_MANAGED', 'Cancel the online-training cohort instead')
        if (current.status === 'CANCELLED') throw conflict('INVALID_STATE', 'This session is already cancelled')
        // Each booking is cancelled individually (with its own reason and audit event) before the session.
        if (current.seatsHeld > 0) throw hasBookings(current.seatsHeld, 'session')
        // History is preserved: the row stays, only its status changes.
        const row = await tx.session.update({ where: { id }, data: { status: 'CANCELLED' }, select: SESSION_ADMIN_SELECT })
        await audit(tx, actor, 'SESSION_CANCELLED', 'session', id, { previousStatus: current.status, ...(reason ? { reason } : {}) })
        return adminSession(row)
      }, sessionConflict)
    },

    // ---- online-training cohorts ----

    async listCohorts({ productId, status, from, to }, { page, pageSize }) {
      await ready()
      const where: Prisma.TrainingCohortWhereInput = {
        ...(productId ? { productId } : {}), ...(status ? { status } : {}),
        ...(from || to ? { sessions: { some: { cohortSequence: 1, startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } } } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.trainingCohort.findMany({ where, select: COHORT_ADMIN_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
        prisma.trainingCohort.count({ where }),
      ])
      const items = rows.map(adminCohort).sort((a, b) => (a.sessions[0]?.startsAt ?? '').localeCompare(b.sessions[0]?.startsAt ?? ''))
      return { items, total }
    },

    async getCohort(id) {
      await ready()
      return adminCohort(await cohortOrThrow(prisma, id))
    },

    async createCohort(input, actor, now) {
      return write(async (tx) => {
        const product = await productOrThrow(tx, input.productId)
        if (product.type !== 'ONLINE_TRAINING') throw invalid('PRODUCT_TYPE_MISMATCH', 'Cohorts are only for online-training products')
        const times = deriveCohortTimes(input.firstSessionStartsAt, input.secondSessionStartsAt, now)
        const cohort = await tx.trainingCohort.create({
          data: { productId: product.id, status: 'DRAFT', timezone: ORGANIZER_TIMEZONE, capacity: input.capacity ?? null, internalNote: input.internalNote ?? null },
          select: { id: true },
        })
        // Both sessions are created in the same transaction: a cohort never exists with only one.
        for (const [sequence, slot] of [[1, times.first], [2, times.second]] as const) {
          await tx.session.create({ data: { productId: product.id, cohortId: cohort.id, cohortSequence: sequence, startsAt: slot.startsAt, endsAt: slot.endsAt, timezone: ORGANIZER_TIMEZONE, status: 'DRAFT' } })
        }
        await audit(tx, actor, 'COHORT_CREATED', 'cohort', cohort.id, { productId: product.id, firstSessionStartsAt: times.first.startsAt.toISOString() })
        return adminCohort(await cohortOrThrow(tx, cohort.id))
      }, sessionConflict)
    },

    async updateCohort(id, patch, actor, now) {
      return write(async (tx) => {
        await lockCohort(tx, id)
        const current = await cohortOrThrow(tx, id)
        if (current.status === 'CANCELLED') throw conflict('INVALID_STATE', 'A cancelled cohort cannot be changed; create a new one instead')
        checkCapacity(patch.capacity, current.seatsHeld)
        if (patch.firstSessionStartsAt && current.seatsHeld > 0) {
          const firstStart = current.sessions.find((s) => s.cohortSequence === 1)?.startsAt
          if (firstStart?.getTime() !== patch.firstSessionStartsAt.getTime()) throw hasBookings(current.seatsHeld, 'training')
        }
        if (patch.firstSessionStartsAt) {
          const times = deriveCohortTimes(patch.firstSessionStartsAt, patch.secondSessionStartsAt, now)
          const [first, second] = [current.sessions.find((s) => s.cohortSequence === 1)!, current.sessions.find((s) => s.cohortSequence === 2)!]
          // Order the two updates so the (product, start) uniqueness never collides with this cohort's own
          // other session mid-transaction (e.g. moving the cohort exactly one week later).
          const updates = [
            () => tx.session.update({ where: { id: first.id }, data: { startsAt: times.first.startsAt, endsAt: times.first.endsAt } }),
            () => tx.session.update({ where: { id: second.id }, data: { startsAt: times.second.startsAt, endsAt: times.second.endsAt } }),
          ]
          const movingLater = times.first.startsAt.getTime() > new Date(first.startsAt).getTime()
          for (const update of movingLater ? updates.reverse() : updates) await update()
        } else if (patch.secondSessionStartsAt) {
          throw invalid('SECOND_SESSION_MISMATCH', 'Change the first session date; the second always follows exactly 7 days later')
        }
        await tx.trainingCohort.update({
          where: { id },
          data: { ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}), ...(patch.internalNote !== undefined ? { internalNote: patch.internalNote } : {}) },
        })
        await audit(tx, actor, patch.firstSessionStartsAt ? 'COHORT_RESCHEDULED' : 'COHORT_UPDATED', 'cohort', id, {
          fields: Object.keys(patch), ...(patch.firstSessionStartsAt ? { from: current.sessions[0]?.startsAt.toISOString(), to: patch.firstSessionStartsAt.toISOString() } : {}),
        })
        return adminCohort(await cohortOrThrow(tx, id))
      }, sessionConflict)
    },

    async publishCohort(id, actor, now) {
      return write(async (tx) => {
        const current = await cohortOrThrow(tx, id)
        if (current.status !== 'DRAFT') throw conflict('INVALID_STATE', `Only draft cohorts can be published (this one is ${current.status.toLowerCase()})`)
        if (!current.product.isActive) throw conflict('PRODUCT_INACTIVE', 'Activate the product before publishing its training dates')
        const sessions = await tx.session.findMany({ where: { cohortId: id }, select: { cohortSequence: true, startsAt: true, endsAt: true, status: true } })
        if (!cohortTimesAreValid(sessions, current.timezone)) throw conflict('COHORT_INCOMPLETE', 'A cohort needs two valid 4-hour Friday sessions exactly one week apart')
        if (sessions.some((session) => session.startsAt.getTime() <= now.getTime())) throw conflict('START_IN_PAST', 'This training has already started; reschedule it first')
        // Cohort and both sessions change together, or not at all.
        await tx.session.updateMany({ where: { cohortId: id }, data: { status: 'PUBLISHED' } })
        await tx.trainingCohort.update({ where: { id }, data: { status: 'PUBLISHED' } })
        await audit(tx, actor, 'COHORT_PUBLISHED', 'cohort', id)
        return adminCohort(await cohortOrThrow(tx, id))
      }, sessionConflict)
    },

    async cancelCohort(id, reason, actor) {
      return write(async (tx) => {
        await lockCohort(tx, id)
        const current = await cohortOrThrow(tx, id)
        if (current.status === 'CANCELLED') throw conflict('INVALID_STATE', 'This cohort is already cancelled')
        if (current.seatsHeld > 0) throw hasBookings(current.seatsHeld, 'training')
        await tx.session.updateMany({ where: { cohortId: id }, data: { status: 'CANCELLED' } })
        await tx.trainingCohort.update({ where: { id }, data: { status: 'CANCELLED' } })
        await audit(tx, actor, 'COHORT_CANCELLED', 'cohort', id, { previousStatus: current.status, ...(reason ? { reason } : {}) })
        return adminCohort(await cohortOrThrow(tx, id))
      }, sessionConflict)
    },
  }
}
