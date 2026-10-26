// Revision 3 cancellation requests and refund ELIGIBILITY, end to end over HTTP against PGlite (one
// connection: requests are serialized, so this is not proof of behaviour under real concurrency; see
// bookings.postgres-concurrency.test.ts). The clock is only moved forward from real time.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DAY, startHarness, type Harness, type Who } from './revision3-harness.js'

let h: Harness

beforeAll(async () => {
  h = await startHarness()
}, 240_000)

afterAll(async () => {
  await h?.stop()
})

type Kind = 'webinar' | 'workshop'
/** A booking on a fresh session, confirmed manually (or by the simulator when reason = 'SIMULATED'). */
async function confirmedBooking(who: Who, { kind = 'workshop' as Kind, startsIn = 20 * DAY, reason = 'COMPLIMENTARY' as string } = {}) {
  const session = await h.newSession(kind, startsIn)
  const target = { productId: h.products[kind], sessionId: session.id }
  if (reason === 'SIMULATED') {
    const booking = await h.book(who, target, { mode: 'payment' })
    const started = await h.as(who, 'post', `/me/bookings/${booking.id}/payment-attempts`, {}, { 'Idempotency-Key': randomUUID() }, 'payment')
    const paid = await h.as(who, 'post', `/me/bookings/${booking.id}/payment-attempts/${started.body.data.attempt.id}/simulate`, { outcome: 'SUCCEEDED' }, {}, 'payment')
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    return { booking, session }
  }
  const booking = await h.book(who, target)
  const confirmed = await h.confirm(booking.id, reason === 'OTHER' ? { reason, note: 'Partner organisation place' } : { reason })
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
  return { booking, session }
}
const requestCancel = (who: Who, bookingId: string, body: Record<string, unknown> = {}, mode: 'manual' | 'payment' = 'manual') =>
  h.as(who, 'post', `/me/bookings/${bookingId}/cancellation-request`, body, {}, mode)
const decide = (bookingId: string, decision: 'approve' | 'reject', reason = 'Reviewed under the cancellation policy') =>
  h.as(h.people.admin, 'post', `/admin/bookings/${bookingId}/cancellation-request/${decision}`, { reason })
/** Runs `work` with the clock fixed at `instant`. */
async function at<T>(instant: Date, work: () => Promise<T>): Promise<T> {
  h.setNow(instant)
  try {
    return await work()
  } finally {
    h.setNow(null)
  }
}

describe('who can request, and when', () => {
  it('only the owner of a CONFIRMED booking, before the start; direct cancellation of CONFIRMED stays refused', async () => {
    const session = await h.newSession('workshop', 20 * DAY)
    const awaiting = await h.book(h.people.asha, { productId: h.products.workshop, sessionId: session.id })
    const early = await requestCancel(h.people.asha, awaiting.id)
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe('BOOKING_NOT_CANCELLABLE_BY_REQUEST')

    const { booking } = await confirmedBooking(h.people.asha)
    expect((await requestCancel(h.people.ben, booking.id)).status).toBe(404) // another customer: never disclosed
    expect((await h.as(h.people.admin, 'post', `/me/bookings/${booking.id}/cancellation-request`, {})).status).toBe(403) // staff account
    expect((await h.as(h.people.asha, 'post', `/me/bookings/${booking.id}/cancel`, {})).body.error.message).toMatch(/cancelled by request/)
    for (const body of [{ reason: 'x'.repeat(501) }, { reason: 'refund to account 123456789012' }, { amount: '1.00' }]) {
      expect((await requestCancel(h.people.asha, booking.id, body)).status).toBe(400)
    }
    expect(await h.prisma.bookingCancellationRequest.count({ where: { bookingId: booking.id } })).toBe(0)
  })

  it('at or after the start an online request is refused (REQUEST_AFTER_START)', async () => {
    const { booking, session } = await confirmedBooking(h.people.ben, { kind: 'webinar' })
    const res = await at(session.startsAt, () => requestCancel(h.people.ben, booking.id))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('REQUEST_AFTER_START')
  })
})

describe('refund eligibility is fixed at the request time', () => {
  // One booking; each request is rejected so the next one can be made at another instant.
  it.each(['workshop', 'online training'] as const)('TRAINING_V1 boundaries (%s): 7 days 100%%, 7 days - 1 ms 50%%, 3 days 50%%, 3 days - 1 ms 0%%, 1 ms before 0%%', async (offering) => {
    let bookingId: string
    let start: Date
    if (offering === 'workshop') {
      const made = await confirmedBooking(h.people.chen, { kind: 'workshop', startsIn: 20 * DAY })
      bookingId = made.booking.id
      start = made.session.startsAt
    } else {
      const cohort = await h.newCohort(3)
      const booking = await h.book(h.people.chen, { productId: h.products.training, cohortId: cohort.id })
      expect((await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })).status).toBe(200)
      bookingId = booking.id
      start = cohort.firstStartsAt
    }
    for (const [remaining, percent] of [[7 * DAY, 100], [7 * DAY - 1, 50], [3 * DAY, 50], [3 * DAY - 1, 0], [1, 0]] as const) {
      const res = await at(new Date(start.getTime() - remaining), () => requestCancel(h.people.chen, bookingId))
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body.data.request).toMatchObject({ status: 'PENDING', refundPolicy: 'TRAINING_V1', refundPercent: percent })
      expect((await decide(bookingId, 'reject')).status).toBe(200)
    }
    expect((await h.row(bookingId)).status).toBe('CONFIRMED')
  })

  it('WEBINAR_V1: 1 ms before the start is 100%', async () => {
    const { booking, session } = await confirmedBooking(h.people.asha, { kind: 'webinar' })
    const res = await at(new Date(session.startsAt.getTime() - 1), () => requestCancel(h.people.asha, booking.id))
    expect(res.body.data.request).toMatchObject({ refundPolicy: 'WEBINAR_V1', refundPercent: 100 })
  })

  it('a later approval never changes the percentage fixed at the request', async () => {
    const { booking, session } = await confirmedBooking(h.people.ben, { kind: 'workshop', startsIn: 20 * DAY })
    const requested = await at(new Date(session.startsAt.getTime() - 7 * DAY), () => requestCancel(h.people.ben, booking.id))
    expect(requested.body.data.request.refundPercent).toBe(100)
    // Decided when only 2 days remain (the 0% tier): still 100%.
    const approved = await at(new Date(session.startsAt.getTime() - 2 * DAY), () => decide(booking.id, 'approve'))
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.data.request).toMatchObject({ status: 'APPROVED', refundPercent: 100 })
  })
})

describe('request, approval and rejection', () => {
  it('a duplicate request while one is pending returns the existing request; the booking keeps its seat', async () => {
    const { booking, session } = await confirmedBooking(h.people.asha)
    const first = await requestCancel(h.people.asha, booking.id, { reason: 'Family event' })
    expect(first.status).toBe(201)
    expect(first.body.data.booking).toMatchObject({ status: 'CONFIRMED', canRequestCancellation: false, cancellationRequest: { id: first.body.data.request.id, status: 'PENDING' } })
    const again = await requestCancel(h.people.asha, booking.id, { reason: 'Family event' })
    expect(again.status).toBe(200)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(again.body.data.request.id).toBe(first.body.data.request.id)
    expect(await h.prisma.bookingCancellationRequest.count({ where: { bookingId: booking.id } })).toBe(1)
    expect(await h.seats(session.id)).toBe(1)
    const event = await h.prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_CANCELLATION_REQUESTED' } })
    expect(JSON.stringify(event.details)).not.toContain('Family event')
    expect(event.details).toMatchObject({ refundPolicy: 'TRAINING_V1', refundPercent: 100, hasReason: true })
  })

  it('approval cancels the booking in the same transaction, releases the seat once and keeps the confirmation history; decisions are final', async () => {
    const { booking, session } = await confirmedBooking(h.people.ben, { reason: 'PAYMENT_ARRANGED_OFFLINE' })
    const confirmedAt = (await h.row(booking.id)).confirmedAt
    await requestCancel(h.people.ben, booking.id)
    const approved = await decide(booking.id, 'approve', 'Approved under the training policy')
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.data.request).toMatchObject({ status: 'APPROVED', refundOutcome: 'NOT_PROCESSED_BY_WEBSITE', decisionReason: 'Approved under the training policy' })
    expect(approved.body.data.booking).toMatchObject({ status: 'CANCELLED', cancellation: { by: 'ADMIN' }, confirmation: { method: 'MANUAL' } })
    expect(await h.row(booking.id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ADMIN', confirmedAt, confirmationMethod: 'MANUAL', confirmationReason: 'PAYMENT_ARRANGED_OFFLINE' })
    expect(await h.seats(session.id)).toBe(0)
    expect((await decide(booking.id, 'approve')).body.error.code).toBe('ALREADY_DECIDED')
    expect((await decide(booking.id, 'reject')).body.error.code).toBe('ALREADY_DECIDED')
    expect(await h.seats(session.id)).toBe(0)
    const actions = await h.auditActions(booking.id)
    expect(actions.filter((action) => action === 'BOOKING_CANCELLATION_APPROVED')).toHaveLength(1)
    expect(actions.filter((action) => action === 'BOOKING_CANCELLED')).toHaveLength(1)
    const event = await h.prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_CANCELLATION_APPROVED' } })
    expect(JSON.stringify(event.details)).not.toContain('Approved under')
  })

  it('rejection leaves the booking confirmed with its seat; a new request may follow', async () => {
    const { booking, session } = await confirmedBooking(h.people.chen)
    await requestCancel(h.people.chen, booking.id)
    const rejected = await decide(booking.id, 'reject', 'Outside the policy window')
    expect(rejected.body.data.request).toMatchObject({ status: 'REJECTED', refundOutcome: null, decisionReason: 'Outside the policy window' })
    expect(rejected.body.data.booking.status).toBe('CONFIRMED')
    expect(await h.seats(session.id)).toBe(1)
    const view = await h.as(h.people.chen, 'get', `/me/bookings/${booking.id}`)
    expect(view.body.data).toMatchObject({ canRequestCancellation: true, cancellationRequest: { status: 'REJECTED', decisionReason: 'Outside the policy window' } })
    expect((await requestCancel(h.people.chen, booking.id)).status).toBe(201)
  })

  it('competing decisions: exactly one wins, the other gets ALREADY_DECIDED', async () => {
    const { booking, session } = await confirmedBooking(h.people.asha)
    await requestCancel(h.people.asha, booking.id)
    const results = await Promise.all([decide(booking.id, 'approve'), decide(booking.id, 'reject'), decide(booking.id, 'approve')])
    expect(results.filter((res) => res.status === 200)).toHaveLength(1)
    expect(results.filter((res) => res.body.error?.code === 'ALREADY_DECIDED')).toHaveLength(2)
    const winner = results.find((res) => res.status === 200)!.body.data.request.status
    expect((await h.row(booking.id)).status).toBe(winner === 'APPROVED' ? 'CANCELLED' : 'CONFIRMED')
    expect(await h.seats(session.id)).toBe(winner === 'APPROVED' ? 0 : 1)
  })

  it('without a pending request, approve/reject answer 404', async () => {
    const { booking } = await confirmedBooking(h.people.ben)
    expect((await decide(booking.id, 'approve')).body.error.code).toBe('CANCELLATION_REQUEST_NOT_FOUND')
    expect((await decide(booking.id, 'reject', 'no')).status).toBe(400) // reason too short
  })
})

describe('refund outcomes never claim a refund', () => {
  it.each([
    ['COMPLIMENTARY', 'NO_REFUND_COMPLIMENTARY'],
    ['PAYMENT_ARRANGED_OFFLINE', 'NOT_PROCESSED_BY_WEBSITE'],
    ['OTHER', 'NOT_PROCESSED_BY_WEBSITE'],
    ['SIMULATED', 'NO_REFUND_SIMULATED_PAYMENT'],
  ])('confirmation %s: %s', async (reason, outcome) => {
    const { booking, session } = await confirmedBooking(h.people.chen, { reason })
    const mode = reason === 'SIMULATED' ? 'payment' : 'manual'
    expect((await requestCancel(h.people.chen, booking.id, {}, mode)).status).toBe(201)
    const approved = await decide(booking.id, 'approve')
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body.data.request.refundOutcome).toBe(outcome)
    expect(await h.seats(session.id)).toBe(0)
    if (reason === 'SIMULATED') {
      // No real refund and no change to the simulated attempt.
      expect(await h.prisma.paymentAttempt.findMany({ where: { bookingId: booking.id }, select: { status: true, isSimulated: true } })).toEqual([{ status: 'SUCCEEDED', isSimulated: true }])
    }
  })

  it('the dashboard counts requests by status and keeps simulated/manual confirmations out of paid', async () => {
    const dashboard = await h.as(h.people.admin, 'get', '/admin/dashboard')
    const counts = dashboard.body.data.bookings
    expect(counts.cancellationRequests).toEqual({
      pending: await h.prisma.bookingCancellationRequest.count({ where: { status: 'PENDING' } }),
      approved: await h.prisma.bookingCancellationRequest.count({ where: { status: 'APPROVED' } }),
      rejected: await h.prisma.bookingCancellationRequest.count({ where: { status: 'REJECTED' } }),
    })
    expect(counts.confirmedPaid).toBe(0)
    const requested = await h.as(h.people.admin, 'get', '/admin/bookings?view=CANCELLATION_REQUESTED&pageSize=100')
    expect(requested.body.data.every((item: { cancellationRequests: { status: string }[] }) => item.cancellationRequests.some((r) => r.status === 'PENDING'))).toBe(true)
  })
})

describe('database integrity (bypassing the API)', () => {
  it('approval and cancellation commit together or not at all', async () => {
    const { booking } = await confirmedBooking(h.people.asha, { reason: 'COMPLIMENTARY' })
    const created = await requestCancel(h.people.asha, booking.id)
    const requestId = created.body.data.request.id as string
    const approve = { status: 'APPROVED' as const, decidedByUserId: h.people.admin.userId, decisionReason: 'Direct SQL approval', decidedAt: new Date(), refundOutcome: 'NO_REFUND_COMPLIMENTARY' as const }

    // Approved without cancelling the booking: refused at COMMIT (deferred check).
    await expect(h.prisma.bookingCancellationRequest.update({ where: { id: requestId }, data: approve })).rejects.toThrow(/approved but its booking was not cancelled/)
    // Approved, then a booking update that fails (customer may not cancel a confirmed booking): everything rolls back.
    await expect(h.prisma.$transaction(async (tx) => {
      await tx.bookingCancellationRequest.update({ where: { id: requestId }, data: approve })
      await tx.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CUSTOMER' } })
    })).rejects.toThrow(/approved cancellation request/)
    expect((await h.prisma.bookingCancellationRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('PENDING')
    expect((await h.row(booking.id)).status).toBe('CONFIRMED')
    // Wrong outcome or a non-admin decider: refused.
    await expect(h.prisma.bookingCancellationRequest.update({ where: { id: requestId }, data: { ...approve, refundOutcome: 'NOT_PROCESSED_BY_WEBSITE' } })).rejects.toThrow(/refund outcome does not match/)
    await expect(h.prisma.bookingCancellationRequest.update({ where: { id: requestId }, data: { ...approve, decidedByUserId: h.people.asha.userId } })).rejects.toThrow(/active administrator/)
    // The correct pair in one transaction commits.
    await h.prisma.$transaction(async (tx) => {
      await tx.bookingCancellationRequest.update({ where: { id: requestId }, data: approve })
      await tx.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'ADMIN', cancelReason: 'Direct SQL approval' } })
    })
    await expect(h.prisma.bookingCancellationRequest.update({ where: { id: requestId }, data: { status: 'REJECTED', refundOutcome: null } })).rejects.toThrow(/decision is final/)
  })

  it('refuses requests for another customer, with a wrong percentage, a back-dated time, a second pending request, or on an unconfirmed booking', async () => {
    const { booking, session } = await confirmedBooking(h.people.ben, { startsIn: 20 * DAY })
    const now = new Date()
    const valid = { bookingId: booking.id, requestedByUserId: h.people.ben.userId, requestedAt: now, refundPolicy: 'TRAINING_V1' as const, refundPercent: 100 }
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, requestedByUserId: h.people.asha.userId } })).rejects.toThrow(/only the customer who owns the booking/)
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, refundPercent: 50 } })).rejects.toThrow(/does not match the policy/)
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, refundPolicy: 'WEBINAR_V1' } })).rejects.toThrow(/does not match the policy/)
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, requestedAt: new Date(now.getTime() - 10 * 60_000) } })).rejects.toThrow(/more than 5 minutes in the past/)
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, requestedAt: session.startsAt, refundPercent: 0 } })).rejects.toThrow(/before the start/)
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, status: 'APPROVED' } })).rejects.toThrow(/starts as PENDING/)
    await h.prisma.bookingCancellationRequest.create({ data: valid })
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, requestedAt: new Date() } })).rejects.toThrow(/booking_cancellation_requests_one_pending|Unique constraint/)
    const awaitingSession = await h.newSession('workshop', 20 * DAY)
    const awaiting = await h.book(h.people.ben, { productId: h.products.workshop, sessionId: awaitingSession.id })
    await expect(h.prisma.bookingCancellationRequest.create({ data: { ...valid, bookingId: awaiting.id, requestedAt: new Date() } })).rejects.toThrow(/only a confirmed booking/)
    expect(await h.seats(session.id)).toBe(1)
  })
})
