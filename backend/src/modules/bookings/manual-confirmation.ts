import { assertUtcSession } from '../../db/timezone-guard.js'
import type { PrismaClient } from '../../generated/prisma/client.js'
import { isCheckViolation, sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { auditBooking, expireIfOverdue, lockBooking, lockTarget, type Tx } from './booking-holds.js'
import type { AdminBooking, BookingRepository } from './booking.repository.js'

// Revision 3 manual confirmation: an active administrator confirms a booking that is
// AWAITING_CONFIRMATION, with a reason. No payment attempt is created and nothing here is proof that
// anyone paid; "Payment arranged offline" is an administrative note, not a payment record.
//
// One transaction, lock order target -> booking. The clock is sampled AFTER the locks (a long lock wait
// can never make a late confirmation look timely), and the update is conditional on the status and the
// deadline. Boundary: confirmation is allowed while now < confirmation_due_at; at or after the deadline
// the booking is expired in the same transaction instead, that is committed (audited), and the API then
// answers 409 CONFIRMATION_WINDOW_EXPIRED. The database re-checks every rule (bookings_check_target),
// including the deadline and "confirmed_at not more than 5 minutes older than the database clock".

export type ManualConfirmationReason = 'PAYMENT_ARRANGED_OFFLINE' | 'COMPLIMENTARY' | 'OTHER'
export type ManualConfirmationInput = { reason: ManualConfirmationReason; note: string | null }
type Context = { clock: () => Date; requestId: string | undefined }

export interface ManualConfirmationRepository {
  /** Identical repeat on an already manually confirmed booking = replay; anything else non-confirmable = 409. */
  confirm(adminUserId: string, bookingId: string, input: ManualConfirmationInput, context: Context): Promise<{ booking: AdminBooking; replayed: boolean }>
}

const httpError = (status: number, code: string, message: string) => new HttpError(status, code, message)

function notConfirmable(booking: { status: string; cancelledBy: string | null }): HttpError {
  switch (booking.status) {
    case 'CONFIRMED':
      return httpError(409, 'BOOKING_NOT_CONFIRMABLE', 'This booking is already confirmed.')
    case 'PENDING_PAYMENT':
      return httpError(409, 'BOOKING_NOT_CONFIRMABLE', 'This booking is awaiting payment, not manual confirmation, so it can’t be confirmed manually.')
    default:
      return httpError(409, 'BOOKING_NOT_CONFIRMABLE', booking.cancelledBy === 'SYSTEM'
        ? 'This booking request expired before it was confirmed, so it can no longer be confirmed.'
        : 'This booking was cancelled, so it can no longer be confirmed.')
  }
}

type Outcome = { replayed: boolean } | { error: HttpError }

export function createManualConfirmationRepository(prisma: PrismaClient, bookings: BookingRepository): ManualConfirmationRepository {
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  async function work(tx: Tx, adminUserId: string, bookingId: string, { reason, note }: ManualConfirmationInput, { clock, requestId }: Context): Promise<Outcome> {
    // The target ids never change, so reading them before the locks is safe.
    const key = await tx.booking.findUnique({ where: { id: bookingId }, select: { sessionId: true, cohortId: true } })
    if (!key) throw httpError(404, 'BOOKING_NOT_FOUND', 'Booking not found')
    await lockTarget(tx, key)
    await lockBooking(tx, bookingId)
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        id: true, reference: true, status: true, sessionId: true, cohortId: true, paymentDueAt: true, confirmationDueAt: true,
        confirmationMethod: true, confirmationReason: true, confirmationNote: true, cancelledBy: true,
      },
    })
    const now = clock()
    const admin = { actorUserId: adminUserId, actorLabel: 'admin' as const, requestId }

    if (booking.status === 'AWAITING_CONFIRMATION' && booking.confirmationDueAt && booking.confirmationDueAt.getTime() <= now.getTime()) {
      // Late: expire it now (exactly as the sweep would) and record the refused confirmation.
      await expireIfOverdue(tx, booking, now, requestId)
      await auditBooking(tx, { ...admin, action: 'BOOKING_CONFIRMATION_REJECTED_LATE', bookingId, details: { reference: booking.reference, reason } })
      return { error: httpError(409, 'CONFIRMATION_WINDOW_EXPIRED', 'The confirmation deadline for this booking has passed, so the request has been cancelled and its seat released.') }
    }
    if (booking.status === 'CONFIRMED') {
      const identical = booking.confirmationMethod === 'MANUAL' && booking.confirmationReason === reason && (booking.confirmationNote ?? null) === note
      return identical ? { replayed: true } : { error: notConfirmable(booking) }
    }
    if (booking.status !== 'AWAITING_CONFIRMATION') return { error: notConfirmable(booking) }

    const updated = await tx.booking.updateMany({
      where: { id: bookingId, status: 'AWAITING_CONFIRMATION', confirmationDueAt: { gt: now } },
      data: { status: 'CONFIRMED', confirmationMethod: 'MANUAL', confirmedByUserId: adminUserId, confirmationReason: reason, confirmationNote: note, confirmedAt: now },
    })
    // Impossible while the locks are held; if it happens anyway, roll everything back.
    if (updated.count !== 1) throw httpError(409, 'BOOKING_NOT_CONFIRMABLE', 'This booking changed while it was being confirmed. Please refresh and try again.')
    // Reason code only: the note may contain personal details and is kept on the booking, not in the audit log.
    await auditBooking(tx, { ...admin, action: 'BOOKING_CONFIRMED_MANUALLY', bookingId, details: { reference: booking.reference, method: 'MANUAL', reason, hasNote: note !== null } })
    return { replayed: false }
  }

  return {
    async confirm(adminUserId, bookingId, input, context) {
      await ready()
      let outcome: Outcome
      try {
        outcome = await prisma.$transaction((tx) => work(tx, adminUserId, bookingId, input, context))
      } catch (error) {
        if (error instanceof HttpError) throw error
        // Database backstops (e.g. the confirming account is no longer an active admin).
        if (isCheckViolation(error)) throw httpError(409, 'CONFIRMATION_REJECTED', 'This confirmation could not be recorded. Please refresh and try again.')
        throw sanitizedDbError(error)
      }
      if ('error' in outcome) throw outcome.error
      return { booking: await bookings.getForAdmin(bookingId), replayed: outcome.replayed }
    },
  }
}
