import type { Prisma, PrismaClient } from '../../generated/prisma/client.js'
import { describeForLog } from '../../lib/db-errors.js'
import type { Logger } from '../../lib/logger.js'

// Stage 2: the 30-minute payment hold. A new booking holds its seat while PENDING_PAYMENT until
// payment_due_at; an overdue hold is expired (CANCELLED by SYSTEM) and its seat released by the
// bookings_maintain_seats trigger. Bookings created before the hold existed have no deadline
// (grandfathered) and are never matched here: "payment_due_at <= now" is never true for NULL, and the
// database rejects a SYSTEM cancellation without a passed deadline anyway.
//
// Revision 3: in manual mode (the default) a new booking is AWAITING_CONFIRMATION and holds its seat until
// confirmation_due_at = min(created_at + 48 hours, start - 24 hours); an overdue request is expired the
// same way ("Not confirmed in time"). Bookings close 24 hours before the start in both modes.
//
// Lock order everywhere (create, cancel, expire, payment, manual confirmation, cancellation requests):
// target row (session or cohort) FOR UPDATE, then the booking row, then its payment attempts or
// cancellation requests. Every writer of those related rows locks the booking first.
//
// Clock: each operation uses ONE server timestamp, written into the row; the database compares stored
// timestamps with stored deadlines. Deadlines are exclusive for confirmation (allowed while
// now < deadline) and inclusive for expiry (deadline <= now), so at exactly the deadline a booking has
// expired. The database additionally refuses confirmed_at / requested_at more than 5 minutes older than
// its own clock (assumes API and database clocks are NTP-synchronized).

export type Tx = Prisma.TransactionClient
export const PAYMENT_HOLD_MINUTES = 30
export const PAYMENT_HOLD_MS = PAYMENT_HOLD_MINUTES * 60_000
export const EXPIRY_REASON = 'Payment not completed in time'
export const CONFIRMATION_EXPIRY_REASON = 'Not confirmed in time'
/** Statuses that hold a seat (same rule as the bookings_maintain_seats trigger and the active-booking indexes). */
export const SEAT_HOLDING_STATUSES = ['PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED'] as const

const HOUR = 3_600_000
/** Bookings close this long before the start (both modes). */
export const BOOKING_CUTOFF_MS = 24 * HOUR
/** Longest manual confirmation hold. */
export const CONFIRMATION_HOLD_MS = 48 * HOUR
/** The last instant before which a booking may be made: start - 24 hours (exclusive). */
export const bookingCutoff = (start: Date) => new Date(start.getTime() - BOOKING_CUTOFF_MS)
/** min(now + 48 hours, start - 24 hours), the same formula the database checks on insert. */
export const confirmationDueAt = (now: Date, start: Date) => new Date(Math.min(now.getTime() + CONFIRMATION_HOLD_MS, bookingCutoff(start).getTime()))

export type BookingKey = { id: string; reference: string; sessionId: string | null; cohortId: string | null }
export type TargetFilter = { sessionId: string } | { cohortId: string }

export const lockTarget = async (tx: Tx, booking: { sessionId: string | null; cohortId: string | null }) => {
  if (booking.sessionId) await tx.$queryRaw`SELECT 1 FROM "sessions" WHERE "id" = ${booking.sessionId}::uuid FOR UPDATE`
  else if (booking.cohortId) await tx.$queryRaw`SELECT 1 FROM "training_cohorts" WHERE "id" = ${booking.cohortId}::uuid FOR UPDATE`
}

export const lockBooking = (tx: Tx, id: string) => tx.$queryRaw`SELECT 1 FROM "bookings" WHERE "id" = ${id}::uuid FOR UPDATE`

export const isOverdue = (booking: { status: string; paymentDueAt: Date | null; confirmationDueAt?: Date | null }, now: Date) =>
  (booking.status === 'PENDING_PAYMENT' && booking.paymentDueAt !== null && booking.paymentDueAt.getTime() <= now.getTime())
  || (booking.status === 'AWAITING_CONFIRMATION' && booking.confirmationDueAt != null && booking.confirmationDueAt.getTime() <= now.getTime())

export type AuditInput = {
  actorUserId: string | null; actorLabel: 'self' | 'admin' | 'system'; action: string
  bookingId: string; requestId: string | undefined; details: Prisma.InputJsonValue
}
export const auditBooking = (tx: Tx, input: AuditInput) =>
  tx.auditEvent.create({ data: { actorUserId: input.actorUserId, actorLabel: input.actorLabel, action: input.action, targetType: 'booking', targetId: input.bookingId, requestId: input.requestId ?? null, details: input.details } })

/** Closes the booking's open (CREATED) payment attempt, if any. Run with the booking row locked. */
export async function closeOpenAttempts(tx: Tx, booking: Pick<BookingKey, 'id' | 'reference'>, now: Date, reason: string, audit: Omit<AuditInput, 'action' | 'bookingId' | 'details'>) {
  const open = await tx.paymentAttempt.findMany({ where: { bookingId: booking.id, status: 'CREATED' }, select: { id: true } })
  if (open.length === 0) return
  await tx.paymentAttempt.updateMany({ where: { bookingId: booking.id, status: 'CREATED' }, data: { status: 'CANCELLED', completedAt: now, failureReason: reason } })
  for (const attempt of open) {
    await auditBooking(tx, { ...audit, action: 'PAYMENT_ATTEMPT_CANCELLED', bookingId: booking.id, details: { reference: booking.reference, attemptId: attempt.id, reason, simulated: true } })
  }
}

/**
 * Expires one booking if (and only if) it is still PENDING_PAYMENT past its payment deadline, or still
 * AWAITING_CONFIRMATION past its confirmation deadline. The caller must hold the target lock.
 * Conditional updates, so it is idempotent and race-safe: of two concurrent expiries (or an expiry and a
 * cancellation or confirmation) exactly one changes the row, and the seat is released once.
 */
export async function expireIfOverdue(tx: Tx, booking: BookingKey, now: Date, requestId?: string): Promise<boolean> {
  const cancelled = { status: 'CANCELLED' as const, cancelledAt: now, cancelledBy: 'SYSTEM' as const }
  let deadline: 'PAYMENT' | 'CONFIRMATION' = 'PAYMENT'
  let reason = EXPIRY_REASON
  const payment = await tx.booking.updateMany({
    where: { id: booking.id, status: 'PENDING_PAYMENT', paymentDueAt: { not: null, lte: now } },
    data: { ...cancelled, cancelReason: EXPIRY_REASON },
  })
  if (payment.count !== 1) {
    const manual = await tx.booking.updateMany({
      where: { id: booking.id, status: 'AWAITING_CONFIRMATION', confirmationDueAt: { not: null, lte: now } },
      data: { ...cancelled, cancelReason: CONFIRMATION_EXPIRY_REASON },
    })
    if (manual.count !== 1) return false
    deadline = 'CONFIRMATION'
    reason = CONFIRMATION_EXPIRY_REASON
  }
  const system = { actorUserId: null, actorLabel: 'system' as const, requestId }
  if (deadline === 'PAYMENT') await closeOpenAttempts(tx, booking, now, EXPIRY_REASON, system)
  await auditBooking(tx, { ...system, action: 'BOOKING_EXPIRED', bookingId: booking.id, details: { reference: booking.reference, by: 'SYSTEM', reason, deadline } })
  return true
}

/**
 * Expires every overdue hold (optionally only for one target), one short transaction per booking.
 * Returns how many bookings this call expired (0 when another process got there first).
 */
export async function expireOverdue(prisma: PrismaClient, now: Date, { target, limit = 200 }: { target?: TargetFilter; limit?: number } = {}): Promise<number> {
  const overdue = await prisma.booking.findMany({
    where: {
      OR: [{ status: 'PENDING_PAYMENT', paymentDueAt: { lte: now } }, { status: 'AWAITING_CONFIRMATION', confirmationDueAt: { lte: now } }],
      ...(target ?? {}),
    },
    select: { id: true, reference: true, sessionId: true, cohortId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  })
  let expired = 0
  for (const booking of overdue) {
    const done = await prisma.$transaction(async (tx) => {
      await lockTarget(tx, booking)
      return expireIfOverdue(tx, booking, now)
    })
    if (done) expired++
  }
  return expired
}

export type ExpiryScheduler = {
  /** Sweep soon on a read path (availability). Throttled and coalesced; never throws. */
  onRead: () => Promise<void>
  /** Start the background sweep (idempotent). The timer is unref'd and never keeps the process alive. */
  start: () => void
  stop: () => void
  /** One sweep now (shares an in-flight sweep). */
  sweep: () => Promise<number>
}

/** Background and read-triggered expiry. Failures are logged (codes only) and retried on the next run. */
export function createExpiryScheduler({ run, logger, intervalMs = 60_000, minReadIntervalMs = 5_000, now = () => new Date() }: {
  run: (now: Date) => Promise<number>; logger: Logger; intervalMs?: number; minReadIntervalMs?: number; now?: () => Date
}): ExpiryScheduler {
  let inFlight: Promise<number> | null = null
  let lastStarted = 0
  let timer: NodeJS.Timeout | null = null

  const sweep = () => {
    inFlight ??= (async () => {
      lastStarted = Date.now()
      try {
        const expired = await run(now())
        if (expired > 0) logger.info('Expired unpaid bookings', { expired })
        return expired
      } catch (error) {
        logger.warn('Booking expiry sweep failed; will retry', { error: describeForLog(error) })
        return 0
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return {
    sweep,
    async onRead() {
      if (inFlight) {
        await inFlight
        return
      }
      if (Date.now() - lastStarted < minReadIntervalMs) return
      await sweep()
    },
    start() {
      if (timer) return
      timer = setInterval(() => void sweep(), intervalMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
