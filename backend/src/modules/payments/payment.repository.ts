import { assertUtcSession } from '../../db/timezone-guard.js'
import type { PrismaClient } from '../../generated/prisma/client.js'
import { isCheckViolation, isUniqueViolation, sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { auditBooking, expireIfOverdue, isOverdue, lockBooking, lockTarget, type Tx } from '../bookings/booking-holds.js'
import { ATTEMPT_SELECT, paymentAttemptView, type BookingRepository, type CustomerBooking, type PaymentAttemptView } from '../bookings/booking.repository.js'

// Stage 2 payment attempts, DEVELOPMENT SIMULATOR ONLY. No real payment provider exists: an attempt is
// a record that a (fake) payment was started, and the customer chooses its outcome in the simulator.
// Simulated payments are never money and never revenue; no card or bank detail is ever collected.
//
// Every write runs in one transaction with the same lock order as bookings: target row FOR UPDATE,
// then the booking row FOR UPDATE (which serializes every change to that booking's attempts), then
// the attempt. All decisions are made on the locked, committed state:
//   * success confirms the booking in the same transaction (seat counts do not change);
//   * a result for a booking that was cancelled or has expired is rejected and audited, never applied;
//   * an overdue booking is expired on the spot (same rules as the background sweep).
// Outcomes that must be recorded but answered with an error (expiry, late result) commit first and
// are thrown afterwards, so the audit trail survives the 409.

export type SimulatedOutcome = 'SUCCEEDED' | 'FAILED'
type Context = { now: Date; requestId: string | undefined }
export type AttemptResult = { attempt: PaymentAttemptView; booking: CustomerBooking; replayed: boolean }

export interface PaymentRepository {
  /** Starts a simulated payment attempt for the customer's own pending booking (idempotent per key). */
  start(userId: string, bookingId: string, idempotencyKey: string, context: Context): Promise<AttemptResult>
  /** Records the simulator's outcome. Same outcome again = replay; a different final outcome = 409. */
  simulate(userId: string, bookingId: string, attemptId: string, outcome: SimulatedOutcome, context: Context): Promise<AttemptResult>
  /** Cancels this payment attempt only: the booking stays pending and keeps its seat. */
  cancel(userId: string, bookingId: string, attemptId: string, context: Context): Promise<AttemptResult>
  listForCustomer(userId: string, bookingId: string): Promise<PaymentAttemptView[]>
}

const httpError = (status: number, code: string, message: string) => new HttpError(status, code, message)
const bookingNotFound = () => httpError(404, 'BOOKING_NOT_FOUND', 'Booking not found')
const attemptNotFound = () => httpError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'Payment attempt not found')
const expired = () => httpError(409, 'PAYMENT_WINDOW_EXPIRED', 'The 30-minute payment window for this booking has passed, so it was cancelled and its seat released. No payment was taken.')
const notPayable = (booking: { status: string; cancelledBy: string | null }) => booking.status === 'CONFIRMED'
  ? httpError(409, 'BOOKING_ALREADY_CONFIRMED', 'This booking is already confirmed.')
  : booking.status === 'AWAITING_CONFIRMATION'
    ? httpError(409, 'BOOKING_NOT_PAYABLE', 'This booking is awaiting confirmation by our team; it can’t be paid online.')
  : booking.cancelledBy === 'SYSTEM'
    ? httpError(409, 'BOOKING_NOT_PAYABLE', 'This booking expired before payment was completed. No payment was taken.')
    : httpError(409, 'BOOKING_NOT_PAYABLE', 'This booking was cancelled, so it can no longer be paid. No payment was taken.')
const STATUS_WORDS: Record<string, string> = { SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELLED: 'was cancelled' }

/** Database backstops that can only be hit under a race the locks should already prevent. */
function rethrow(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (isUniqueViolation(error, 'payment_attempts_one_open_per_booking')) throw httpError(409, 'PAYMENT_ATTEMPT_OPEN', 'A payment for this booking is already in progress.')
  if (isUniqueViolation(error, 'payment_attempts_one_succeeded_per_booking')) throw httpError(409, 'BOOKING_ALREADY_CONFIRMED', 'This booking is already confirmed.')
  if (isCheckViolation(error)) throw httpError(409, 'PAYMENT_REJECTED', 'This payment could not be recorded. Please refresh and try again.')
  throw sanitizedDbError(error)
}

/** A decision taken inside the transaction: either a result, or an error to raise AFTER commit. */
type Outcome = { attemptId: string; replayed: boolean } | { error: HttpError }

export function createPaymentRepository(prisma: PrismaClient, bookings: BookingRepository): PaymentRepository {
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  /** Locks target then booking (owner-scoped: another customer's booking is simply "not found"). */
  async function lockOwnBooking(tx: Tx, userId: string, bookingId: string) {
    const key = await tx.booking.findFirst({ where: { id: bookingId, userId }, select: { sessionId: true, cohortId: true } })
    if (!key) throw bookingNotFound()
    await lockTarget(tx, key)
    await lockBooking(tx, bookingId)
    return tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { id: true, reference: true, status: true, sessionId: true, cohortId: true, paymentDueAt: true, cancelledBy: true, priceAmount: true, currency: true },
    })
  }
  type Locked = Awaited<ReturnType<typeof lockOwnBooking>>

  const self = (userId: string, requestId: string | undefined) => ({ actorUserId: userId, actorLabel: 'self' as const, requestId })

  /** Records that an outcome arrived for a booking that can no longer take it. Never applies it. */
  const rejectLate = (tx: Tx, booking: Locked, attemptId: string, outcome: string, reason: string, userId: string, requestId: string | undefined) =>
    auditBooking(tx, { ...self(userId, requestId), action: 'PAYMENT_RESULT_REJECTED', bookingId: booking.id, details: { reference: booking.reference, attemptId, outcome, reason, simulated: true } })

  async function transact(work: (tx: Tx) => Promise<Outcome>, userId: string, bookingId: string, now: Date): Promise<AttemptResult> {
    await ready()
    let outcome: Outcome
    try {
      outcome = await prisma.$transaction(work)
    } catch (error) {
      rethrow(error)
    }
    if ('error' in outcome) throw outcome.error
    const [attempt, booking] = await Promise.all([
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: outcome.attemptId }, select: ATTEMPT_SELECT }),
      bookings.getForCustomer(userId, bookingId, now),
    ])
    return { attempt: paymentAttemptView(attempt), booking, replayed: outcome.replayed }
  }

  return {
    start(userId, bookingId, idempotencyKey, { now, requestId }) {
      return transact(async (tx) => {
        const booking = await lockOwnBooking(tx, userId, bookingId)
        // An identical retry returns the attempt it created, whatever has happened since.
        const same = await tx.paymentAttempt.findUnique({ where: { bookingId_idempotencyKey: { bookingId, idempotencyKey } }, select: { id: true } })
        if (same) return { attemptId: same.id, replayed: true }
        if (booking.status !== 'PENDING_PAYMENT') return { error: notPayable(booking) }
        if (isOverdue(booking, now)) {
          await expireIfOverdue(tx, booking, now, requestId)
          return { error: expired() }
        }
        const open = await tx.paymentAttempt.findFirst({ where: { bookingId, status: 'CREATED' }, select: { id: true } })
        if (open) return { error: httpError(409, 'PAYMENT_ATTEMPT_OPEN', 'A payment for this booking is already in progress. Finish or cancel it first.') }
        const attempt = await tx.paymentAttempt.create({
          // Amount and currency are the booking's snapshot (re-checked by the payment_attempts_check trigger).
          data: { bookingId, provider: 'DEV_SIMULATOR', isSimulated: true, amount: booking.priceAmount, currency: booking.currency, idempotencyKey, createdAt: now },
          select: { id: true },
        })
        await auditBooking(tx, {
          ...self(userId, requestId), action: 'PAYMENT_ATTEMPT_CREATED', bookingId,
          details: { reference: booking.reference, attemptId: attempt.id, provider: 'DEV_SIMULATOR', simulated: true, amount: { amount: booking.priceAmount.toFixed(2), currency: booking.currency } },
        })
        return { attemptId: attempt.id, replayed: false }
      }, userId, bookingId, now)
    },

    simulate(userId, bookingId, attemptId, outcome, { now, requestId }) {
      return transact(async (tx) => {
        const booking = await lockOwnBooking(tx, userId, bookingId)
        const attempt = await tx.paymentAttempt.findFirst({ where: { id: attemptId, bookingId }, select: { id: true, status: true, amount: true, currency: true } })
        if (!attempt) return { error: attemptNotFound() }
        if (attempt.status === outcome) return { attemptId, replayed: true }

        // Late result: the booking was cancelled (by the customer, an admin or expiry) or is overdue now.
        if (booking.status === 'CANCELLED') {
          await rejectLate(tx, booking, attemptId, outcome, booking.cancelledBy === 'SYSTEM' ? 'BOOKING_EXPIRED' : 'BOOKING_CANCELLED', userId, requestId)
          return { error: notPayable(booking) }
        }
        if (attempt.status !== 'CREATED') {
          return { error: httpError(409, 'PAYMENT_ATTEMPT_COMPLETED', `This payment attempt already ${STATUS_WORDS[attempt.status] ?? 'finished'}; its outcome cannot change.`) }
        }
        if (booking.status !== 'PENDING_PAYMENT') return { error: notPayable(booking) }
        if (isOverdue(booking, now)) {
          await expireIfOverdue(tx, booking, now, requestId)
          await rejectLate(tx, booking, attemptId, outcome, 'PAYMENT_WINDOW_EXPIRED', userId, requestId)
          return { error: expired() }
        }

        const details = { reference: booking.reference, attemptId, provider: 'DEV_SIMULATOR', simulated: true, amount: { amount: attempt.amount.toFixed(2), currency: attempt.currency } }
        if (outcome === 'FAILED') {
          // The booking stays pending and keeps its seat until it expires or is cancelled.
          await tx.paymentAttempt.update({ where: { id: attemptId }, data: { status: 'FAILED', completedAt: now, failureReason: 'Simulated payment failure' } })
          await auditBooking(tx, { ...self(userId, requestId), action: 'PAYMENT_ATTEMPT_FAILED', bookingId, details })
          return { attemptId, replayed: false }
        }
        // Success: attempt first, then the booking (the booking trigger requires the SUCCEEDED attempt;
        // the deferred attempt trigger requires the CONFIRMED booking at commit). Seats do not change.
        await tx.paymentAttempt.update({ where: { id: attemptId }, data: { status: 'SUCCEEDED', completedAt: now } })
        const confirmed = await tx.booking.updateMany({ where: { id: bookingId, status: 'PENDING_PAYMENT' }, data: { status: 'CONFIRMED', confirmedAt: now, confirmationMethod: 'PAYMENT' } })
        if (confirmed.count !== 1) throw httpError(409, 'PAYMENT_REJECTED', 'This payment could not be recorded. Please refresh and try again.')
        await auditBooking(tx, { ...self(userId, requestId), action: 'PAYMENT_ATTEMPT_SUCCEEDED', bookingId, details: { ...details, noMoneyReceived: true } })
        await auditBooking(tx, { ...self(userId, requestId), action: 'BOOKING_CONFIRMED', bookingId, details: { reference: booking.reference, attemptId, simulated: true, noMoneyReceived: true } })
        return { attemptId, replayed: false }
      }, userId, bookingId, now)
    },

    cancel(userId, bookingId, attemptId, { now, requestId }) {
      return transact(async (tx) => {
        const booking = await lockOwnBooking(tx, userId, bookingId)
        const attempt = await tx.paymentAttempt.findFirst({ where: { id: attemptId, bookingId }, select: { id: true, status: true } })
        if (!attempt) return { error: attemptNotFound() }
        if (attempt.status === 'CANCELLED') return { attemptId, replayed: true }
        if (attempt.status !== 'CREATED') {
          return { error: httpError(409, 'PAYMENT_ATTEMPT_COMPLETED', `This payment attempt already ${STATUS_WORDS[attempt.status] ?? 'finished'} and can no longer be cancelled.`) }
        }
        // An overdue booking expires now; that also cancels this attempt, which is what was asked.
        if (isOverdue(booking, now) && (await expireIfOverdue(tx, booking, now, requestId))) return { attemptId, replayed: false }
        await tx.paymentAttempt.update({ where: { id: attemptId }, data: { status: 'CANCELLED', completedAt: now, failureReason: 'Cancelled by customer' } })
        await auditBooking(tx, { ...self(userId, requestId), action: 'PAYMENT_ATTEMPT_CANCELLED', bookingId, details: { reference: booking.reference, attemptId, reason: 'Cancelled by customer', simulated: true } })
        return { attemptId, replayed: false }
      }, userId, bookingId, now)
    },

    async listForCustomer(userId, bookingId) {
      await ready()
      const booking = await prisma.booking.findFirst({ where: { id: bookingId, userId }, select: { id: true } })
      if (!booking) throw bookingNotFound()
      const rows = await prisma.paymentAttempt.findMany({ where: { bookingId }, select: ATTEMPT_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
      return rows.map(paymentAttemptView)
    },
  }
}
