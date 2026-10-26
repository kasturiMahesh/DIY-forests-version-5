import { assertUtcSession } from '../../db/timezone-guard.js'
import type { PrismaClient } from '../../generated/prisma/client.js'
import { isCheckViolation, isUniqueViolation, sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { auditBooking, lockBooking, lockTarget, type Tx } from './booking-holds.js'
import { CANCELLATION_REQUEST_SELECT, cancellationRequestView, type AdminBooking, type BookingRepository, type CancellationRequestView, type CustomerBooking } from './booking.repository.js'
import { refundOutcomeFor, refundPercentFor, refundPolicyFor } from './refund-policy.js'

// Revision 3 cancellation requests for CONFIRMED bookings. The customer requests; the booking stays
// confirmed and keeps its seat; an administrator approves (the booking is cancelled in the SAME
// transaction, releasing its seat once) or rejects (nothing else changes; a new request may follow).
//
// Lock order: target -> booking -> the pending request (FOR UPDATE). The clock is sampled after the
// locks; the refund percentage is fixed at that request time and never recomputed. The database
// recomputes and checks the policy, percentage and outcome itself, allows one PENDING request per
// booking, makes decisions final, and (deferred, at COMMIT) refuses an APPROVED request whose booking is
// not cancelled, while the booking trigger refuses cancelling a CONFIRMED booking without an APPROVED
// request. So approval and cancellation can only ever commit together, whoever writes them.
//
// No refund is ever processed or claimed here: the outcome records what the WEBSITE did.

type Context = { clock: () => Date; requestId: string | undefined }

export interface CancellationRequestRepository {
  /** 201 for a new request; an existing PENDING request is returned as a replay. */
  request(userId: string, bookingId: string, reason: string | null, context: Context): Promise<{ request: CancellationRequestView; booking: CustomerBooking; replayed: boolean }>
  approve(adminUserId: string, bookingId: string, reason: string, context: Context): Promise<{ request: CancellationRequestView; booking: AdminBooking }>
  reject(adminUserId: string, bookingId: string, reason: string, context: Context): Promise<{ request: CancellationRequestView; booking: AdminBooking }>
}

const httpError = (status: number, code: string, message: string) => new HttpError(status, code, message)
const bookingNotFound = () => httpError(404, 'BOOKING_NOT_FOUND', 'Booking not found')
const alreadyDecided = () => httpError(409, 'ALREADY_DECIDED', 'This cancellation request has already been decided.')

function notRequestable(status: string): HttpError {
  if (status === 'AWAITING_CONFIRMATION' || status === 'PENDING_PAYMENT') {
    return httpError(409, 'BOOKING_NOT_CANCELLABLE_BY_REQUEST', 'This booking isn’t confirmed yet, so you can cancel it directly instead.')
  }
  return httpError(409, 'BOOKING_NOT_CANCELLABLE_BY_REQUEST', 'This booking has already been cancelled.')
}

const START_SELECT = {
  session: { select: { startsAt: true } },
  cohort: { select: { sessions: { where: { cohortSequence: 1 }, select: { startsAt: true } } } },
} as const
const startOf = (row: { session: { startsAt: Date } | null; cohort: { sessions: { startsAt: Date }[] } | null }) =>
  row.session?.startsAt ?? row.cohort?.sessions[0]?.startsAt ?? null

const pendingFor = async (tx: Tx, bookingId: string) =>
  (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "booking_cancellation_requests" WHERE "booking_id" = ${bookingId}::uuid AND "status" = 'PENDING' FOR UPDATE`)[0] ?? null

function rethrow(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (isUniqueViolation(error, 'booking_cancellation_requests_one_pending')) throw httpError(409, 'CANCELLATION_ALREADY_REQUESTED', 'A cancellation request for this booking is already pending.')
  if (isCheckViolation(error)) throw httpError(409, 'CANCELLATION_REQUEST_REJECTED', 'This cancellation request could not be recorded. Please refresh and try again.')
  throw sanitizedDbError(error)
}

export function createCancellationRequestRepository(prisma: PrismaClient, bookings: BookingRepository): CancellationRequestRepository {
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  const requestView = async (id: string) =>
    cancellationRequestView(await prisma.bookingCancellationRequest.findUniqueOrThrow({ where: { id }, select: CANCELLATION_REQUEST_SELECT }))

  /** Locks target then booking; `where` scopes the booking (the owner, for customers). */
  async function lockFor(tx: Tx, where: { id: string; userId?: string }) {
    const key = await tx.booking.findFirst({ where, select: { sessionId: true, cohortId: true } })
    if (!key) throw bookingNotFound()
    await lockTarget(tx, key)
    await lockBooking(tx, where.id)
  }

  async function decide(adminUserId: string, bookingId: string, reason: string, decision: 'APPROVED' | 'REJECTED', { clock, requestId }: Context) {
    await ready()
    let requestId_: string
    try {
      requestId_ = await prisma.$transaction(async (tx) => {
        await lockFor(tx, { id: bookingId })
        const pending = await pendingFor(tx, bookingId)
        if (!pending) {
          const any = await tx.bookingCancellationRequest.findFirst({ where: { bookingId }, select: { id: true } })
          throw any ? alreadyDecided() : httpError(404, 'CANCELLATION_REQUEST_NOT_FOUND', 'This booking has no cancellation request.')
        }
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: {
            reference: true, status: true, confirmationMethod: true, confirmationReason: true,
            paymentAttempts: { where: { status: 'SUCCEEDED', isSimulated: true }, select: { id: true } },
          },
        })
        // A pending request always belongs to a CONFIRMED booking (enforced by the database); be explicit anyway.
        if (booking.status !== 'CONFIRMED') throw httpError(409, 'BOOKING_NOT_CANCELLABLE_BY_REQUEST', 'This booking is no longer confirmed.')
        const now = clock()
        const admin = { actorUserId: adminUserId, actorLabel: 'admin' as const, requestId }
        const request = await tx.bookingCancellationRequest.findUniqueOrThrow({ where: { id: pending.id }, select: { refundPercent: true, refundPolicy: true } })

        if (decision === 'REJECTED') {
          const updated = await tx.bookingCancellationRequest.updateMany({
            where: { id: pending.id, status: 'PENDING' },
            data: { status: 'REJECTED', decidedByUserId: adminUserId, decisionReason: reason, decidedAt: now },
          })
          if (updated.count !== 1) throw alreadyDecided()
          await auditBooking(tx, { ...admin, action: 'BOOKING_CANCELLATION_REJECTED', bookingId, details: { reference: booking.reference, requestId: pending.id } })
          return pending.id
        }

        const outcome = refundOutcomeFor({ confirmationMethod: booking.confirmationMethod, confirmationReason: booking.confirmationReason, simulatedPaymentSucceeded: booking.paymentAttempts.length > 0 })
        if (!outcome) throw httpError(409, 'REFUND_OUTCOME_UNSUPPORTED', 'This booking was confirmed in a way the website cannot cancel yet. Please handle it outside the website.')
        // 1. request PENDING -> APPROVED, 2. booking CONFIRMED -> CANCELLED (seat released once by the trigger).
        // Any failure rolls both back; the database refuses to commit one without the other.
        const approved = await tx.bookingCancellationRequest.updateMany({
          where: { id: pending.id, status: 'PENDING' },
          data: { status: 'APPROVED', decidedByUserId: adminUserId, decisionReason: reason, decidedAt: now, refundOutcome: outcome },
        })
        if (approved.count !== 1) throw alreadyDecided()
        const cancelled = await tx.booking.updateMany({
          where: { id: bookingId, status: 'CONFIRMED' },
          data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'ADMIN', cancelReason: reason },
        })
        if (cancelled.count !== 1) throw httpError(409, 'BOOKING_NOT_CANCELLABLE_BY_REQUEST', 'This booking changed while the request was being approved. Please refresh and try again.')
        await auditBooking(tx, { ...admin, action: 'BOOKING_CANCELLATION_APPROVED', bookingId, details: { reference: booking.reference, requestId: pending.id, refundPolicy: request.refundPolicy, refundPercent: request.refundPercent, refundOutcome: outcome } })
        await auditBooking(tx, { ...admin, action: 'BOOKING_CANCELLED', bookingId, details: { reference: booking.reference, by: 'ADMIN', kind: 'REQUEST_APPROVED' } })
        return pending.id
      })
    } catch (error) {
      rethrow(error)
    }
    return { request: await requestView(requestId_), booking: await bookings.getForAdmin(bookingId) }
  }

  return {
    async request(userId, bookingId, reason, { clock, requestId }) {
      await ready()
      let result: { id: string; replayed: boolean }
      const attempt = () => prisma.$transaction(async (tx) => {
        await lockFor(tx, { id: bookingId, userId })
        const pending = await pendingFor(tx, bookingId)
        if (pending) return { id: pending.id, replayed: true }
        const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { reference: true, status: true, product: { select: { type: true } }, ...START_SELECT } })
        if (booking.status !== 'CONFIRMED') throw notRequestable(booking.status)
        const now = clock()
        const start = startOf(booking)
        const policy = refundPolicyFor(booking.product.type)
        const percent = start ? refundPercentFor(policy, start, now) : null
        if (percent === null) throw httpError(409, 'REQUEST_AFTER_START', 'This booking has already started, so it can’t be cancelled online. Please contact us.')
        const created = await tx.bookingCancellationRequest.create({
          data: { bookingId, requestedByUserId: userId, customerReason: reason, requestedAt: now, refundPolicy: policy, refundPercent: percent },
          select: { id: true },
        })
        // Safe metadata only: the customer's own words stay on the request, not in the audit log.
        await auditBooking(tx, { actorUserId: userId, actorLabel: 'self', action: 'BOOKING_CANCELLATION_REQUESTED', bookingId, requestId, details: { reference: booking.reference, requestId: created.id, refundPolicy: policy, refundPercent: percent, hasReason: reason !== null } })
        return { id: created.id, replayed: false }
      })
      try {
        result = await attempt()
      } catch (error) {
        // A concurrent identical request won the race: answer with it.
        if (!isUniqueViolation(error, 'booking_cancellation_requests_one_pending')) rethrow(error)
        try {
          result = await attempt()
        } catch (retryError) {
          rethrow(retryError)
        }
      }
      return { request: await requestView(result.id), booking: await bookings.getForCustomer(userId, bookingId, clock()), replayed: result.replayed }
    },

    approve: (adminUserId, bookingId, reason, context) => decide(adminUserId, bookingId, reason, 'APPROVED', context),
    reject: (adminUserId, bookingId, reason, context) => decide(adminUserId, bookingId, reason, 'REJECTED', context),
  }
}
