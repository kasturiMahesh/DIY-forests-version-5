import { randomInt } from 'node:crypto'
import { assertUtcSession } from '../../db/timezone-guard.js'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js'
import { isCheckViolation, isUniqueViolation, sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { checkSingleSession, cohortTimesAreValid } from '../admin/schedule-rules.js'
import type { NormalizedPhone } from './phone.js'

// Stage 4C bookings. One booking = one seat for one customer on exactly one target: a standalone
// session (webinar, offline-workshop batch) or an online-training cohort (both linked Fridays).
//
// Concurrency (PostgreSQL, READ COMMITTED): creating a booking locks the product row FOR SHARE and the
// target row FOR UPDATE before reading status and seats, so competing bookings for the last seat, admin
// capacity changes and admin cancellations of the target are serialized on that row. The seat counters
// themselves are changed only by the bookings_maintain_seats trigger, and the CHECK
// "seats_held <= capacity" rejects anything that slips past the application check.
// No payment exists: every booking starts PENDING_PAYMENT and holds its seat until cancelled.

type Tx = Prisma.TransactionClient
type Status = 'PENDING_PAYMENT' | 'CANCELLED'
export type Page = { page: number; pageSize: number }
export type Paged<T> = { items: T[]; total: number }
export type Actor = { userId: string; requestId: string | undefined }
export type Target = { kind: 'session'; id: string } | { kind: 'cohort'; id: string }
export type CreateBookingInput = { productId: string; target: Target; contactName: string; phone: NormalizedPhone; idempotencyKey: string }

const httpError = (status: number, code: string, message: string) => new HttpError(status, code, message)
const bookingNotFound = () => httpError(404, 'BOOKING_NOT_FOUND', 'Booking not found')

// ---- reads ----

const TARGET_SELECT = {
  session: { select: { id: true, startsAt: true, endsAt: true, timezone: true, venue: true, status: true } },
  cohort: {
    select: {
      id: true, timezone: true, status: true,
      sessions: { select: { cohortSequence: true, startsAt: true, endsAt: true, status: true }, orderBy: { cohortSequence: 'asc' as const } },
    },
  },
} as const
const BOOKING_SELECT = {
  id: true, reference: true, status: true, priceAmount: true, currency: true, productName: true, contactName: true,
  phoneCountry: true, phoneDialingCode: true, phoneNational: true, phoneE164: true,
  productId: true, sessionId: true, cohortId: true,
  cancelledAt: true, cancelledBy: true, cancelReason: true, createdAt: true, updatedAt: true,
  product: { select: { id: true, slug: true, type: true } },
  ...TARGET_SELECT,
} as const
const ADMIN_BOOKING_SELECT = { ...BOOKING_SELECT, user: { select: { id: true, email: true, displayName: true } } } as const

type BookingRow = Prisma.BookingGetPayload<{ select: typeof BOOKING_SELECT }>
type AdminBookingRow = Prisma.BookingGetPayload<{ select: typeof ADMIN_BOOKING_SELECT }>

/** When the booked offering starts: the session start, or the first Friday of a cohort. */
function targetStartsAt(row: Pick<BookingRow, 'session' | 'cohort'>): Date | null {
  if (row.session) return row.session.startsAt
  return row.cohort?.sessions.find((session) => session.cohortSequence === 1)?.startsAt ?? null
}

const targetView = (row: BookingRow) =>
  row.session
    ? { kind: 'session' as const, id: row.session.id, startsAt: row.session.startsAt.toISOString(), endsAt: row.session.endsAt?.toISOString() ?? null, timezone: row.session.timezone, venue: row.session.venue, status: row.session.status }
    : {
      kind: 'cohort' as const, id: row.cohort!.id, timezone: row.cohort!.timezone, status: row.cohort!.status,
      sessions: row.cohort!.sessions.map((session) => ({ sequence: session.cohortSequence!, startsAt: session.startsAt.toISOString(), endsAt: session.endsAt?.toISOString() ?? null })),
    }

const phoneView = (row: BookingRow) => ({ country: row.phoneCountry, dialingCode: row.phoneDialingCode, nationalNumber: row.phoneNational, e164: row.phoneE164 })

/** A customer may cancel a pending booking up to the moment the offering starts. */
const customerMayCancel = (row: BookingRow, now: Date) => row.status === 'PENDING_PAYMENT' && (targetStartsAt(row)?.getTime() ?? 0) > now.getTime()

const baseView = (row: BookingRow) => ({
  id: row.id,
  reference: row.reference,
  status: row.status,
  // Snapshots taken at booking time: later admin price or name changes never alter a booking.
  product: { id: row.product.id, slug: row.product.slug, type: row.product.type, name: row.productName },
  price: { amount: row.priceAmount.toFixed(2), currency: row.currency },
  target: targetView(row),
  cancellation: row.status === 'CANCELLED' ? { at: row.cancelledAt!.toISOString(), by: row.cancelledBy!, reason: row.cancelReason } : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export const customerBooking = (row: BookingRow, now: Date) => ({
  ...baseView(row),
  contact: { name: row.contactName, phone: phoneView(row) },
  canCancel: customerMayCancel(row, now),
})

/** Admin list rows: who and what, without the phone number (shown only on the detail view). */
export const adminBookingSummary = (row: AdminBookingRow) => ({
  ...baseView(row),
  customer: { id: row.user.id, email: row.user.email, displayName: row.user.displayName },
  contactName: row.contactName,
  canCancel: row.status === 'PENDING_PAYMENT',
})
export const adminBooking = (row: AdminBookingRow) => ({ ...adminBookingSummary(row), contact: { name: row.contactName, phone: phoneView(row) } })

export type CustomerBooking = ReturnType<typeof customerBooking>
export type AdminBookingSummary = ReturnType<typeof adminBookingSummary>
export type AdminBooking = ReturnType<typeof adminBooking>

export type AdminBookingFilter = {
  status?: Status | undefined; productId?: string | undefined; sessionId?: string | undefined; cohortId?: string | undefined
  q?: string | undefined; createdFrom?: Date | undefined; createdTo?: Date | undefined
}

export interface BookingRepository {
  /** Creates a PENDING_PAYMENT booking, or replays the one already created with this idempotency key. */
  create(userId: string, input: CreateBookingInput, context: { now: Date; requestId: string | undefined }): Promise<{ booking: CustomerBooking; replayed: boolean }>
  listForCustomer(userId: string, filter: { status?: Status | undefined }, page: Page, now: Date): Promise<Paged<CustomerBooking>>
  /** 404 for another customer's booking: existence is never revealed. */
  getForCustomer(userId: string, id: string, now: Date): Promise<CustomerBooking>
  cancelByCustomer(userId: string, id: string, reason: string | null, context: { now: Date; requestId: string | undefined }): Promise<CustomerBooking>
  listForAdmin(filter: AdminBookingFilter, page: Page): Promise<Paged<AdminBookingSummary>>
  getForAdmin(id: string): Promise<AdminBooking>
  cancelByAdmin(id: string, reason: string, actor: Actor, now: Date): Promise<AdminBooking>
}

// Unambiguous characters (no 0/O, 1/I/L) for references people read out over the phone.
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const newReference = () => `DF-${Array.from({ length: 8 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join('')}`

/** Maps constraint failures that can legitimately happen under concurrency to client-safe errors. */
function toDomainError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error
  if (isUniqueViolation(error, 'bookings_one_active_per_user_session') || isUniqueViolation(error, 'bookings_one_active_per_user_cohort')) {
    return httpError(409, 'ALREADY_BOOKED', 'You already have an active booking for these dates')
  }
  if (isCheckViolation(error, 'sessions_seats_held_within_capacity') || isCheckViolation(error, 'training_cohorts_seats_held_within_capacity')) {
    return httpError(409, 'SOLD_OUT', 'These dates are fully booked')
  }
  // Trigger and CHECK backstops (target/product mismatch, immutable fields …): the application checks
  // should have caught these first, so report a conflict without any database detail.
  if (isCheckViolation(error)) return httpError(409, 'BOOKING_REJECTED', 'This booking could not be made. Please refresh and try again.')
  return null
}

/** Known failures pass through; anything else is rethrown with a log-safe cause (no row data, no phone). */
function rethrow(error: unknown): never {
  const known = toDomainError(error)
  if (known) throw known
  throw sanitizedDbError(error)
}

export function createBookingRepository(prisma: PrismaClient): BookingRepository {
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  const audit = (tx: Tx, input: { actorUserId: string; actorLabel: 'self' | 'admin'; action: string; bookingId: string; requestId: string | undefined; details: Prisma.InputJsonValue }) =>
    tx.auditEvent.create({ data: { actorUserId: input.actorUserId, actorLabel: input.actorLabel, action: input.action, targetType: 'booking', targetId: input.bookingId, requestId: input.requestId ?? null, details: input.details } })

  const findByKey = (userId: string, idempotencyKey: string) =>
    prisma.booking.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: BOOKING_SELECT })

  /** A retry with the same key must describe the same booking; otherwise the key was reused by mistake. */
  function replay(existing: BookingRow, input: CreateBookingInput, now: Date) {
    const sameTarget = input.target.kind === 'session' ? existing.sessionId === input.target.id : existing.cohortId === input.target.id
    const same = existing.productId === input.productId && sameTarget && existing.contactName === input.contactName && existing.phoneE164 === input.phone.e164
    if (!same) throw httpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking. Start a new checkout.')
    return { booking: customerBooking(existing, now), replayed: true }
  }

  /**
   * Locks the product and the target, then checks every booking rule against the locked rows.
   * Lock order (product FOR SHARE, then target FOR UPDATE) is the same for every booking.
   */
  async function reserve(tx: Tx, userId: string, input: CreateBookingInput, now: Date, reference: string, requestId: string | undefined): Promise<{ id: string; replayed: boolean }> {
    // FOR SHARE: an admin deactivation or price change waits for this booking (and vice versa).
    await tx.$queryRaw`SELECT 1 FROM "products" WHERE "id" = ${input.productId}::uuid FOR SHARE`
    // FOR UPDATE: competing bookings for the same target queue here and then re-read the committed seats.
    if (input.target.kind === 'session') await tx.$queryRaw`SELECT 1 FROM "sessions" WHERE "id" = ${input.target.id}::uuid FOR UPDATE`
    else await tx.$queryRaw`SELECT 1 FROM "training_cohorts" WHERE "id" = ${input.target.id}::uuid FOR UPDATE`
    // A same-key request that committed while this one waited for the lock is replayed before any rule
    // is checked: the dates may have filled up since, but the original booking stands.
    const earlier = await tx.booking.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } }, select: { id: true } })
    if (earlier) return { id: earlier.id, replayed: true }

    const product = await tx.product.findUnique({ where: { id: input.productId }, select: { id: true, type: true, name: true, priceAmount: true, currency: true, isActive: true, archivedAt: true } })
    if (!product) throw httpError(404, 'PRODUCT_NOT_FOUND', 'Product not found')
    if (!product.isActive || product.archivedAt) throw httpError(409, 'PRODUCT_UNAVAILABLE', 'This offering is not available for booking')

    const wantsCohort = product.type === 'ONLINE_TRAINING'
    if (wantsCohort !== (input.target.kind === 'cohort')) {
      throw httpError(400, 'TARGET_TYPE_MISMATCH', wantsCohort ? 'Online training is booked by choosing training dates (cohortId)' : 'Webinars and workshops are booked by choosing a session (sessionId)')
    }

    let capacity: number | null
    let seatsHeld: number
    if (input.target.kind === 'session') {
      const session = await tx.session.findUnique({ where: { id: input.target.id }, select: { productId: true, cohortId: true, status: true, startsAt: true, endsAt: true, venue: true, capacity: true, seatsHeld: true } })
      if (!session) throw httpError(404, 'SESSION_NOT_FOUND', 'Session not found')
      if (session.cohortId) throw httpError(400, 'TARGET_TYPE_MISMATCH', 'Online-training sessions are booked through their training dates (cohortId)')
      if (session.productId !== product.id) throw httpError(400, 'TARGET_PRODUCT_MISMATCH', 'This session belongs to a different offering')
      if (session.status !== 'PUBLISHED') throw httpError(409, 'TARGET_NOT_BOOKABLE', session.status === 'CANCELLED' ? 'This session has been cancelled' : 'This session is not open for booking')
      if (session.startsAt.getTime() <= now.getTime()) throw httpError(409, 'TARGET_STARTED', 'This session has already started')
      // Workshops must have their venue and end date; webinars must have a valid time range.
      try {
        checkSingleSession(product.type as 'WEBINAR' | 'OFFLINE_WORKSHOP', session)
      } catch {
        throw httpError(409, 'TARGET_NOT_BOOKABLE', 'This session is missing its schedule details and cannot be booked yet')
      }
      ;({ capacity, seatsHeld } = session)
    } else {
      const cohort = await tx.trainingCohort.findUnique({
        where: { id: input.target.id },
        select: { productId: true, status: true, timezone: true, capacity: true, seatsHeld: true, sessions: { select: { cohortSequence: true, startsAt: true, endsAt: true, status: true } } },
      })
      if (!cohort) throw httpError(404, 'COHORT_NOT_FOUND', 'Training dates not found')
      if (cohort.productId !== product.id) throw httpError(400, 'TARGET_PRODUCT_MISMATCH', 'These training dates belong to a different offering')
      if (cohort.status !== 'PUBLISHED' || cohort.sessions.some((session) => session.status !== 'PUBLISHED')) {
        throw httpError(409, 'TARGET_NOT_BOOKABLE', cohort.status === 'CANCELLED' ? 'These training dates have been cancelled' : 'These training dates are not open for booking')
      }
      // Two linked 4-hour Friday sessions exactly seven calendar days apart, or it is not bookable.
      if (!cohortTimesAreValid(cohort.sessions, cohort.timezone)) throw httpError(409, 'TARGET_NOT_BOOKABLE', 'These training dates are incomplete and cannot be booked')
      if (cohort.sessions.some((session) => session.startsAt.getTime() <= now.getTime())) throw httpError(409, 'TARGET_STARTED', 'This training has already started')
      ;({ capacity, seatsHeld } = cohort)
    }

    // Checked before capacity: a customer who already holds one of the seats should be told so.
    const active = await tx.booking.findFirst({
      where: { userId, status: 'PENDING_PAYMENT', ...(input.target.kind === 'session' ? { sessionId: input.target.id } : { cohortId: input.target.id }) },
      select: { id: true },
    })
    if (active) throw httpError(409, 'ALREADY_BOOKED', 'You already have an active booking for these dates')
    if (capacity !== null && seatsHeld >= capacity) throw httpError(409, 'SOLD_OUT', 'These dates are fully booked')

    const created = await tx.booking.create({
      data: {
        reference, userId, productId: product.id,
        ...(input.target.kind === 'session' ? { sessionId: input.target.id } : { cohortId: input.target.id }),
        status: 'PENDING_PAYMENT',
        // Price snapshot exactly as configured by the admin: no tax is added here.
        priceAmount: product.priceAmount, currency: product.currency, productName: product.name,
        contactName: input.contactName,
        phoneCountry: input.phone.country, phoneDialingCode: input.phone.dialingCode, phoneNational: input.phone.national, phoneE164: input.phone.e164,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true, reference: true },
    })
    await audit(tx, {
      actorUserId: userId, actorLabel: 'self', action: 'BOOKING_CREATED', bookingId: created.id, requestId,
      details: { reference: created.reference, productId: product.id, target: input.target, price: { amount: product.priceAmount.toFixed(2), currency: product.currency } },
    })
    return { id: created.id, replayed: false }
  }

  const getRow = async (where: Prisma.BookingWhereInput) => {
    const row = await prisma.booking.findFirst({ where, select: BOOKING_SELECT })
    if (!row) throw bookingNotFound()
    return row
  }

  /**
   * Conditional status change: only a still-PENDING_PAYMENT row is updated, so two concurrent
   * cancellations cannot both succeed (the loser re-checks the row after the winner commits).
   * The trigger releases the seat in the same transaction. The target row is locked FIRST, the same
   * order as creating a booking (target, then booking row), so the two can never wait on each other.
   */
  async function cancel(tx: Tx, booking: { id: string; sessionId: string | null; cohortId: string | null }, where: Prisma.BookingWhereInput, by: 'CUSTOMER' | 'ADMIN', reason: string | null, now: Date) {
    if (booking.sessionId) await tx.$queryRaw`SELECT 1 FROM "sessions" WHERE "id" = ${booking.sessionId}::uuid FOR UPDATE`
    else if (booking.cohortId) await tx.$queryRaw`SELECT 1 FROM "training_cohorts" WHERE "id" = ${booking.cohortId}::uuid FOR UPDATE`
    const result = await tx.booking.updateMany({ where: { ...where, id: booking.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: by, cancelReason: reason } })
    if (result.count !== 1) throw httpError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking has already been cancelled')
  }

  async function getForAdmin(id: string) {
    await ready()
    const row = await prisma.booking.findUnique({ where: { id }, select: ADMIN_BOOKING_SELECT })
    if (!row) throw bookingNotFound()
    return adminBooking(row)
  }

  return {
    async create(userId, input, { now, requestId }) {
      await ready()
      const existing = await findByKey(userId, input.idempotencyKey)
      if (existing) return replay(existing, input, now)

      for (let attempt = 1; ; attempt++) {
        try {
          const { id, replayed } = await prisma.$transaction((tx) => reserve(tx, userId, input, now, newReference(), requestId))
          const row = await getRow({ id })
          return replayed ? replay(row, input, now) : { booking: customerBooking(row, now), replayed: false }
        } catch (error) {
          // A concurrent request with the same key won the race: answer with its booking.
          if (isUniqueViolation(error, 'bookings_user_id_idempotency_key_key')) {
            const winner = await findByKey(userId, input.idempotencyKey)
            if (winner) return replay(winner, input, now)
          }
          // Random reference collision (31^8 space): try again with a new one.
          if (isUniqueViolation(error, 'bookings_reference_key') && attempt < 3) continue
          rethrow(error)
        }
      }
    },

    async listForCustomer(userId, { status }, { page, pageSize }, now) {
      await ready()
      const where: Prisma.BookingWhereInput = { userId, ...(status ? { status } : {}) }
      try {
        const [rows, total] = await Promise.all([
          prisma.booking.findMany({ where, select: BOOKING_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
          prisma.booking.count({ where }),
        ])
        return { items: rows.map((row) => customerBooking(row, now)), total }
      } catch (error) {
        rethrow(error)
      }
    },

    async getForCustomer(userId, id, now) {
      await ready()
      return customerBooking(await getRow({ id, userId }), now)
    },

    async cancelByCustomer(userId, id, reason, { now, requestId }) {
      await ready()
      try {
        await prisma.$transaction(async (tx) => {
          const row = await tx.booking.findFirst({ where: { id, userId }, select: BOOKING_SELECT })
          if (!row) throw bookingNotFound()
          if (row.status !== 'PENDING_PAYMENT') throw httpError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking has already been cancelled')
          if (!customerMayCancel(row, now)) throw httpError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking can no longer be cancelled online because the dates have started. Please contact us.')
          await cancel(tx, row, { userId }, 'CUSTOMER', reason, now)
          await audit(tx, { actorUserId: userId, actorLabel: 'self', action: 'BOOKING_CANCELLED', bookingId: id, requestId, details: { reference: row.reference, by: 'CUSTOMER', ...(reason ? { reason } : {}) } })
        })
      } catch (error) {
        rethrow(error)
      }
      return customerBooking(await getRow({ id, userId }), now)
    },

    async listForAdmin({ status, productId, sessionId, cohortId, q, createdFrom, createdTo }, { page, pageSize }) {
      await ready()
      const search = q?.trim()
      const where: Prisma.BookingWhereInput = {
        ...(status ? { status } : {}), ...(productId ? { productId } : {}), ...(sessionId ? { sessionId } : {}), ...(cohortId ? { cohortId } : {}),
        ...(createdFrom || createdTo ? { createdAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lt: createdTo } : {}) } } : {}),
        ...(search ? { OR: [{ reference: search.toUpperCase() }, { user: { email: { contains: search.toLowerCase() } } }] } : {}),
      }
      try {
        const [rows, total] = await Promise.all([
          prisma.booking.findMany({ where, select: ADMIN_BOOKING_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
          prisma.booking.count({ where }),
        ])
        return { items: rows.map(adminBookingSummary), total }
      } catch (error) {
        rethrow(error)
      }
    },

    getForAdmin,

    async cancelByAdmin(id, reason, actor, now) {
      await ready()
      try {
        await prisma.$transaction(async (tx) => {
          const row = await tx.booking.findUnique({ where: { id }, select: { id: true, reference: true, status: true, sessionId: true, cohortId: true } })
          if (!row) throw bookingNotFound()
          if (row.status !== 'PENDING_PAYMENT') throw httpError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking has already been cancelled')
          await cancel(tx, row, {}, 'ADMIN', reason, now)
          await audit(tx, { actorUserId: actor.userId, actorLabel: 'admin', action: 'BOOKING_CANCELLED', bookingId: id, requestId: actor.requestId, details: { reference: row.reference, by: 'ADMIN', reason } })
        })
      } catch (error) {
        rethrow(error)
      }
      return getForAdmin(id)
    },
  }
}
