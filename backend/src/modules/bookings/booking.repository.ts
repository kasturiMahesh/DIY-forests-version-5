import { randomInt } from 'node:crypto'
import { assertUtcSession } from '../../db/timezone-guard.js'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js'
import { isCheckViolation, isUniqueViolation, sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { checkSingleSession, cohortTimesAreValid } from '../admin/schedule-rules.js'
import { auditBooking, bookingCutoff, closeOpenAttempts, confirmationDueAt, expireOverdue, lockTarget, PAYMENT_HOLD_MS, SEAT_HOLDING_STATUSES, type TargetFilter } from './booking-holds.js'
import type { NormalizedPhone } from './phone.js'

// Stage 4C bookings. One booking = one seat for one customer on exactly one target: a standalone
// session (webinar, offline-workshop batch) or an online-training cohort (both linked Fridays).
//
// Concurrency (PostgreSQL, READ COMMITTED): creating a booking locks the product row FOR SHARE and the
// target row FOR UPDATE before reading status and seats, so competing bookings for the last seat, admin
// capacity changes and admin cancellations of the target are serialized on that row. The seat counters
// themselves are changed only by the bookings_maintain_seats trigger, and the CHECK
// "seats_held <= capacity" rejects anything that slips past the application check.
//
// Revision 3: bookings close 24 hours before the start. In manual mode (BOOKING_CONFIRMATION_MODE,
// the default) a new booking is AWAITING_CONFIRMATION with a confirmation deadline and is confirmed (or
// declined) by an administrator; in payment mode (development + simulator only) it is PENDING_PAYMENT
// with the Stage 2 30-minute payment deadline. Both hold a seat; overdue holds are expired by the sweep in
// booking-holds.ts. A CONFIRMED booking can only be cancelled through an approved cancellation request
// (cancellation-requests.ts). Bookings from before the Stage 2 hold have no deadline and never expire.

type Tx = Prisma.TransactionClient
type Status = 'PENDING_PAYMENT' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'CANCELLED'
export type BookingConfirmationMode = 'manual' | 'payment'

/** Shown with every simulated confirmation: simulated payments are not money and never revenue. */
export const SIMULATED_CONFIRMATION_NOTICE = 'Confirmed — simulated payment, no money received.'
/** Shown with every manual confirmation: confirmation is not proof that anything was paid. */
export const MANUAL_CONFIRMATION_NOTICE = 'Confirmed by DIY Forests. No payment was taken through this website. Our team will explain any agreed payment arrangements separately.'
export type Page = { page: number; pageSize: number }
export type Paged<T> = { items: T[]; total: number }
export type Actor = { userId: string; requestId: string | undefined }
export type Target = { kind: 'session'; id: string } | { kind: 'cohort'; id: string }
export type CreateBookingInput = { productId: string; target: Target; contactName: string; phone: NormalizedPhone; idempotencyKey: string }

const httpError = (status: number, code: string, message: string) => new HttpError(status, code, message)
const bookingNotFound = () => httpError(404, 'BOOKING_NOT_FOUND', 'Booking not found')
export const notCancellable = (status: Status) => status === 'CONFIRMED'
  ? httpError(409, 'BOOKING_NOT_CANCELLABLE', 'Confirmed bookings are cancelled by request. Use “Request cancellation”; our team will review it.')
  : httpError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking has already been cancelled')

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
export const ATTEMPT_SELECT = {
  id: true, status: true, provider: true, isSimulated: true, amount: true, currency: true, failureReason: true, completedAt: true, createdAt: true,
} as const
export type AttemptRow = Prisma.PaymentAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>

/** A payment attempt as shown to its customer and (read-only) to admins. Never any card or bank data: none exists. */
export const paymentAttemptView = (row: AttemptRow) => ({
  id: row.id,
  status: row.status,
  provider: row.provider,
  simulated: row.isSimulated,
  amount: { amount: row.amount.toFixed(2), currency: row.currency },
  failureReason: row.failureReason,
  completedAt: row.completedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
})
export type PaymentAttemptView = ReturnType<typeof paymentAttemptView>

export const CANCELLATION_REQUEST_SELECT = {
  id: true, status: true, requestedAt: true, refundPolicy: true, refundPercent: true, customerReason: true,
  decidedAt: true, decisionReason: true, refundOutcome: true,
} as const
export type CancellationRequestRow = Prisma.BookingCancellationRequestGetPayload<{ select: typeof CANCELLATION_REQUEST_SELECT }>

/** A cancellation request. The percentage is eligibility only; the outcome says what the website did. */
export const cancellationRequestView = (row: CancellationRequestRow) => ({
  id: row.id,
  status: row.status,
  requestedAt: row.requestedAt.toISOString(),
  refundPolicy: row.refundPolicy,
  refundPercent: row.refundPercent,
  customerReason: row.customerReason,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  decisionReason: row.decisionReason,
  refundOutcome: row.refundOutcome,
})
export type CancellationRequestView = ReturnType<typeof cancellationRequestView>

const BOOKING_SELECT = {
  id: true, reference: true, status: true, priceAmount: true, currency: true, productName: true, contactName: true,
  phoneCountry: true, phoneDialingCode: true, phoneNational: true, phoneE164: true,
  productId: true, sessionId: true, cohortId: true,
  cancelledAt: true, cancelledBy: true, cancelReason: true, createdAt: true, updatedAt: true,
  paymentDueAt: true, confirmedAt: true, confirmationDueAt: true, confirmationMethod: true, confirmationReason: true,
  product: { select: { id: true, slug: true, type: true } },
  // Newest first. Once an attempt succeeds the booking is CONFIRMED and no new attempt can start, so a
  // successful attempt is always within this window.
  paymentAttempts: { select: ATTEMPT_SELECT, orderBy: { createdAt: 'desc' as const }, take: 10 },
  cancellationRequests: { select: CANCELLATION_REQUEST_SELECT, orderBy: { requestedAt: 'desc' as const }, take: 5 },
  ...TARGET_SELECT,
} as const
const ADMIN_BOOKING_SELECT = {
  ...BOOKING_SELECT,
  confirmationNote: true,
  user: { select: { id: true, email: true, displayName: true } },
  confirmedBy: { select: { id: true, email: true, displayName: true } },
} as const

type BookingRow = Prisma.BookingGetPayload<{ select: typeof BOOKING_SELECT }>
type AdminBookingRow = Prisma.BookingGetPayload<{ select: typeof ADMIN_BOOKING_SELECT }>

/** When the booked offering starts: the session start, or the first Friday of a cohort. */
export function targetStartsAt(row: Pick<BookingRow, 'session' | 'cohort'>): Date | null {
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

const startsInFuture = (row: BookingRow, now: Date) => (targetStartsAt(row)?.getTime() ?? 0) > now.getTime()

/**
 * A customer may directly cancel a pending or awaiting-confirmation booking up to the moment the
 * offering starts. A CONFIRMED booking is cancelled only through a cancellation request.
 */
const customerMayCancel = (row: BookingRow, now: Date) => (row.status === 'PENDING_PAYMENT' || row.status === 'AWAITING_CONFIRMATION') && startsInFuture(row, now)

/** Payment can be started while pending and inside the payment window (no deadline = grandfathered). */
export const withinPaymentWindow = (row: { status: string; paymentDueAt: Date | null }, now: Date) =>
  row.status === 'PENDING_PAYMENT' && (row.paymentDueAt === null || row.paymentDueAt.getTime() > now.getTime())

/** Confirmation history (also kept after an approved cancellation of a confirmed booking). */
const confirmationView = (row: BookingRow) => {
  if (!row.confirmedAt) return null
  if (row.confirmationMethod === 'MANUAL') {
    return { at: row.confirmedAt.toISOString(), method: 'MANUAL' as const, simulated: false, notice: MANUAL_CONFIRMATION_NOTICE as string | null }
  }
  const succeeded = row.paymentAttempts.find((attempt) => attempt.status === 'SUCCEEDED')
  return { at: row.confirmedAt.toISOString(), method: 'PAYMENT' as const, simulated: succeeded?.isSimulated ?? true, notice: succeeded?.isSimulated === false ? null : SIMULATED_CONFIRMATION_NOTICE as string | null }
}

const baseView = (row: BookingRow) => ({
  id: row.id,
  reference: row.reference,
  status: row.status,
  // Snapshots taken at booking time: later admin price or name changes never alter a booking.
  product: { id: row.product.id, slug: row.product.slug, type: row.product.type, name: row.productName },
  price: { amount: row.priceAmount.toFixed(2), currency: row.currency },
  target: targetView(row),
  cancellation: row.status === 'CANCELLED' ? { at: row.cancelledAt!.toISOString(), by: row.cancelledBy!, reason: row.cancelReason } : null,
  payment: {
    /** When an unpaid (payment-mode) booking expires. null = manual mode, or created before the payment hold existed. */
    dueAt: row.paymentDueAt?.toISOString() ?? null,
    openAttemptId: row.paymentAttempts.find((attempt) => attempt.status === 'CREATED')?.id ?? null,
    attempts: row.paymentAttempts.map(paymentAttemptView),
  },
  /** Manual mode: when an unconfirmed request is released (min(booking + 48h, start − 24h)). */
  confirmationDueAt: row.confirmationDueAt?.toISOString() ?? null,
  confirmation: confirmationView(row),
  /** The most recent cancellation request, if any. */
  cancellationRequest: row.cancellationRequests[0] ? cancellationRequestView(row.cancellationRequests[0]) : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export const customerBooking = (row: BookingRow, now: Date) => ({
  ...baseView(row),
  contact: { name: row.contactName, phone: phoneView(row) },
  canCancel: customerMayCancel(row, now),
  canPay: withinPaymentWindow(row, now),
  canRequestCancellation: row.status === 'CONFIRMED' && startsInFuture(row, now) && row.cancellationRequests[0]?.status !== 'PENDING',
})

/** Admin list rows: who and what, without the phone number (shown only on the detail view). */
export const adminBookingSummary = (row: AdminBookingRow) => ({
  ...baseView(row),
  customer: { id: row.user.id, email: row.user.email, displayName: row.user.displayName },
  contactName: row.contactName,
  /** Decline (awaiting) or cancel (pending payment). Confirmed bookings go through a cancellation request. */
  canCancel: row.status === 'PENDING_PAYMENT' || row.status === 'AWAITING_CONFIRMATION',
  canConfirm: row.status === 'AWAITING_CONFIRMATION',
  manualConfirmation: row.confirmationMethod === 'MANUAL'
    ? { reason: row.confirmationReason!, note: row.confirmationNote, by: row.confirmedBy ? { id: row.confirmedBy.id, email: row.confirmedBy.email, displayName: row.confirmedBy.displayName } : null }
    : null,
  cancellationRequests: row.cancellationRequests.map(cancellationRequestView),
})
export const adminBooking = (row: AdminBookingRow) => ({ ...adminBookingSummary(row), contact: { name: row.contactName, phone: phoneView(row) } })

export type CustomerBooking = ReturnType<typeof customerBooking>
export type AdminBookingSummary = ReturnType<typeof adminBookingSummary>
export type AdminBooking = ReturnType<typeof adminBooking>

/** Admin list shortcuts on top of the plain status filter. */
export type AdminBookingView = 'AWAITING_CONFIRMATION' | 'MANUALLY_CONFIRMED' | 'SIMULATED_CONFIRMED' | 'CANCELLATION_REQUESTED'
export type AdminBookingFilter = {
  status?: Status | undefined; view?: AdminBookingView | undefined; productId?: string | undefined; sessionId?: string | undefined; cohortId?: string | undefined
  q?: string | undefined; createdFrom?: Date | undefined; createdTo?: Date | undefined
}

const VIEW_WHERE: Record<AdminBookingView, Prisma.BookingWhereInput> = {
  AWAITING_CONFIRMATION: { status: 'AWAITING_CONFIRMATION' },
  MANUALLY_CONFIRMED: { status: 'CONFIRMED', confirmationMethod: 'MANUAL' },
  SIMULATED_CONFIRMED: { status: 'CONFIRMED', confirmationMethod: 'PAYMENT', paymentAttempts: { some: { status: 'SUCCEEDED', isSimulated: true } } },
  CANCELLATION_REQUESTED: { cancellationRequests: { some: { status: 'PENDING' } } },
}

export interface BookingRepository {
  /** Creates a booking in the configured mode, or replays the one already created with this idempotency key. */
  create(userId: string, input: CreateBookingInput, context: { now: Date; requestId: string | undefined }): Promise<{ booking: CustomerBooking; replayed: boolean }>
  listForCustomer(userId: string, filter: { status?: Status | undefined }, page: Page, now: Date): Promise<Paged<CustomerBooking>>
  /** 404 for another customer's booking: existence is never revealed. */
  getForCustomer(userId: string, id: string, now: Date): Promise<CustomerBooking>
  cancelByCustomer(userId: string, id: string, reason: string | null, context: { now: Date; requestId: string | undefined }): Promise<CustomerBooking>
  listForAdmin(filter: AdminBookingFilter, page: Page): Promise<Paged<AdminBookingSummary>>
  getForAdmin(id: string): Promise<AdminBooking>
  /** Cancels a pending booking, or declines a booking awaiting confirmation. */
  cancelByAdmin(id: string, reason: string, actor: Actor, now: Date): Promise<AdminBooking>
  /** Expires overdue unpaid / unconfirmed holds (all, or one target's) and returns how many this call expired. */
  expireOverdue(now: Date, target?: TargetFilter): Promise<number>
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

export type BookingRepositoryOptions = {
  /** env.bookingConfirmationMode (manual by default; payment only in development with the simulator). Tests pass it explicitly. */
  confirmationMode: BookingConfirmationMode
}

export function createBookingRepository(prisma: PrismaClient, { confirmationMode }: BookingRepositoryOptions): BookingRepository {
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  const audit = auditBooking

  const findByKey = (userId: string, idempotencyKey: string) =>
    prisma.booking.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: BOOKING_SELECT })

  /** A retry with the same key must describe the same booking; otherwise the key was reused by mistake. */
  function replay(existing: BookingRow, input: CreateBookingInput, now: Date) {
    const sameTarget = input.target.kind === 'session' ? existing.sessionId === input.target.id : existing.cohortId === input.target.id
    // The country is compared too: US and CA share +1, so the same E.164 number can describe two requests.
    const same = existing.productId === input.productId && sameTarget && existing.contactName === input.contactName
      && existing.phoneCountry === input.phone.country && existing.phoneE164 === input.phone.e164
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
    let start: Date
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
      start = session.startsAt
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
      start = cohort.sessions.find((session) => session.cohortSequence === 1)!.startsAt
    }
    // Revision 3, both modes: bookings close 24 hours before the start (the database checks it too).
    if (now.getTime() >= bookingCutoff(start).getTime()) {
      throw httpError(409, 'BOOKING_CUTOFF_PASSED', 'Bookings close 24 hours before the start time. Please contact us if you’d like to join.')
    }

    // Checked before capacity: a customer who already holds one of the seats should be told so.
    const active = await tx.booking.findFirst({
      where: { userId, status: { in: [...SEAT_HOLDING_STATUSES] }, ...(input.target.kind === 'session' ? { sessionId: input.target.id } : { cohortId: input.target.id }) },
      select: { id: true },
    })
    if (active) throw httpError(409, 'ALREADY_BOOKED', 'You already have an active booking for these dates')
    if (capacity !== null && seatsHeld >= capacity) throw httpError(409, 'SOLD_OUT', 'These dates are fully booked')

    // Manual mode: held until staff confirm or the confirmation deadline passes. Payment mode (development
    // simulator only): the Stage 2 30-minute payment hold (CHECK: exactly created_at + 30 minutes).
    const hold = confirmationMode === 'manual'
      ? { status: 'AWAITING_CONFIRMATION' as const, confirmationDueAt: confirmationDueAt(now, start) }
      : { status: 'PENDING_PAYMENT' as const, paymentDueAt: new Date(now.getTime() + PAYMENT_HOLD_MS) }
    const created = await tx.booking.create({
      data: {
        reference, userId, productId: product.id,
        ...(input.target.kind === 'session' ? { sessionId: input.target.id } : { cohortId: input.target.id }),
        ...hold,
        // Price snapshot exactly as configured by the admin: no tax is added here.
        priceAmount: product.priceAmount, currency: product.currency, productName: product.name,
        contactName: input.contactName,
        phoneCountry: input.phone.country, phoneDialingCode: input.phone.dialingCode, phoneNational: input.phone.national, phoneE164: input.phone.e164,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      },
      select: { id: true, reference: true },
    })
    await audit(tx, {
      actorUserId: userId, actorLabel: 'self', action: 'BOOKING_CREATED', bookingId: created.id, requestId,
      details: {
        reference: created.reference, productId: product.id, target: input.target, price: { amount: product.priceAmount.toFixed(2), currency: product.currency },
        mode: confirmationMode,
        ...('confirmationDueAt' in hold ? { confirmationDueAt: hold.confirmationDueAt.toISOString() } : { paymentDueAt: hold.paymentDueAt.toISOString() }),
      },
    })
    return { id: created.id, replayed: false }
  }

  const getRow = async (where: Prisma.BookingWhereInput) => {
    const row = await prisma.booking.findFirst({ where, select: BOOKING_SELECT })
    if (!row) throw bookingNotFound()
    return row
  }

  /**
   * Conditional status change: only a still pending or awaiting-confirmation row is updated, so two
   * concurrent cancellations (or a cancellation and a payment, confirmation or expiry) cannot both
   * succeed: the loser re-checks the row after the winner commits. The trigger releases the seat in the
   * same transaction, and the booking's open payment attempt (if any) is cancelled with it. The target
   * row is locked FIRST, the same order as every other booking write, so none of them can deadlock.
   */
  async function cancel(tx: Tx, booking: { id: string; reference: string; sessionId: string | null; cohortId: string | null }, where: Prisma.BookingWhereInput, by: 'CUSTOMER' | 'ADMIN', reason: string | null, now: Date, actor: { actorUserId: string; actorLabel: 'self' | 'admin'; requestId: string | undefined }) {
    await lockTarget(tx, booking)
    const result = await tx.booking.updateMany({
      where: { ...where, id: booking.id, status: { in: ['PENDING_PAYMENT', 'AWAITING_CONFIRMATION'] } },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: by, cancelReason: reason },
    })
    if (result.count !== 1) {
      const current = await tx.booking.findUnique({ where: { id: booking.id }, select: { status: true } })
      throw notCancellable(current?.status ?? 'CANCELLED')
    }
    await closeOpenAttempts(tx, booking, now, 'Booking cancelled', actor)
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
      // Release this target's overdue holds first (separate short transactions), so stale unpaid or
      // unconfirmed bookings can never make these dates look full.
      await expireOverdue(prisma, now, { target: input.target.kind === 'session' ? { sessionId: input.target.id } : { cohortId: input.target.id } })

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
          if (row.status !== 'PENDING_PAYMENT' && row.status !== 'AWAITING_CONFIRMATION') throw notCancellable(row.status)
          if (!customerMayCancel(row, now)) throw httpError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking can no longer be cancelled online because the dates have started. Please contact us.')
          await cancel(tx, row, { userId }, 'CUSTOMER', reason, now, { actorUserId: userId, actorLabel: 'self', requestId })
          await audit(tx, { actorUserId: userId, actorLabel: 'self', action: 'BOOKING_CANCELLED', bookingId: id, requestId, details: { reference: row.reference, by: 'CUSTOMER', ...(reason ? { reason } : {}) } })
        })
      } catch (error) {
        rethrow(error)
      }
      return customerBooking(await getRow({ id, userId }), now)
    },

    async listForAdmin({ status, view, productId, sessionId, cohortId, q, createdFrom, createdTo }, { page, pageSize }) {
      await ready()
      const search = q?.trim()
      const where: Prisma.BookingWhereInput = {
        AND: [
          { ...(status ? { status } : {}), ...(productId ? { productId } : {}), ...(sessionId ? { sessionId } : {}), ...(cohortId ? { cohortId } : {}) },
          view ? VIEW_WHERE[view] : {},
          createdFrom || createdTo ? { createdAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lt: createdTo } : {}) } } : {},
          search ? { OR: [{ reference: search.toUpperCase() }, { user: { email: { contains: search.toLowerCase() } } }] } : {},
        ],
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
          if (row.status !== 'PENDING_PAYMENT' && row.status !== 'AWAITING_CONFIRMATION') throw notCancellable(row.status)
          await cancel(tx, row, {}, 'ADMIN', reason, now, { actorUserId: actor.userId, actorLabel: 'admin', requestId: actor.requestId })
          await audit(tx, {
            actorUserId: actor.userId, actorLabel: 'admin', action: 'BOOKING_CANCELLED', bookingId: id, requestId: actor.requestId,
            details: { reference: row.reference, by: 'ADMIN', reason, ...(row.status === 'AWAITING_CONFIRMATION' ? { kind: 'DECLINED' } : {}) },
          })
        })
      } catch (error) {
        rethrow(error)
      }
      return getForAdmin(id)
    },

    async expireOverdue(now, target) {
      await ready()
      return expireOverdue(prisma, now, target ? { target } : {})
    },
  }
}
