// Revision 3 manual confirmation, the 24-hour cutoff, the 48-hour confirmation hold and its expiry, end
// to end over HTTP against PGlite (one connection: requests are serialized, so this is not proof of
// behaviour under real concurrency; see bookings.postgres-concurrency.test.ts). Also bypasses the API to
// show the database itself refuses every invalid state.
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONFIRMATION_EXPIRY_REASON } from '../../src/modules/bookings/booking-holds.js'
import { MANUAL_CONFIRMATION_NOTICE } from '../../src/modules/bookings/booking.repository.js'
import { PUBLIC_ORIGIN } from '../auth/helpers.js'
import { DAY, HOUR, startHarness, type Harness } from './revision3-harness.js'

let h: Harness

beforeAll(async () => {
  h = await startHarness()
}, 240_000)

afterAll(async () => {
  await h?.stop()
})

const webinar = async (startsIn = 20 * DAY, capacity = 5) => {
  const session = await h.newSession('webinar', startsIn, capacity)
  return { session, target: { productId: h.products.webinar, sessionId: session.id } }
}

describe('manual mode booking creation', () => {
  it('a new booking is AWAITING_CONFIRMATION, holds a seat, has no payment deadline and is held for 48 hours', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.asha, target)
    expect(booking.status).toBe('AWAITING_CONFIRMATION')
    expect(booking.payment.dueAt).toBeNull()
    expect(booking.canPay).toBe(false)
    expect(booking.canCancel).toBe(true)
    const stored = await h.row(booking.id)
    expect(stored.confirmationDueAt!.getTime() - stored.createdAt.getTime()).toBe(48 * HOUR)
    expect(stored.paymentDueAt).toBeNull()
    expect(await h.prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(0)
    expect(await h.seats(session.id)).toBe(1)
    const created = await h.prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_CREATED' } })
    expect(created.details).toMatchObject({ mode: 'manual', confirmationDueAt: stored.confirmationDueAt!.toISOString() })
  })

  it('the deadline is start - 24 hours when that is earlier than booking + 48 hours', async () => {
    const { session, target } = await webinar(40 * DAY)
    h.setNow(new Date(session.startsAt.getTime() - 30 * HOUR))
    try {
      const booking = await h.book(h.people.ben, target)
      expect(new Date(booking.confirmationDueAt!).getTime()).toBe(session.startsAt.getTime() - 24 * HOUR)
    } finally {
      h.setNow(null)
    }
  })

  it('online training uses the first cohort session for the deadline', async () => {
    const cohort = await h.newCohort(4)
    h.setNow(new Date(cohort.firstStartsAt.getTime() - 36 * HOUR))
    try {
      const booking = await h.book(h.people.asha, { productId: h.products.training, cohortId: cohort.id })
      expect(new Date(booking.confirmationDueAt!).getTime()).toBe(cohort.firstStartsAt.getTime() - 24 * HOUR)
      expect(await h.cohortSeats(cohort.id)).toBe(1)
    } finally {
      h.setNow(null)
    }
  })

  it('bookings close exactly 24 hours before the start (both modes); nothing is created after the cutoff', async () => {
    const { session, target } = await webinar(30 * DAY)
    const cutoff = session.startsAt.getTime() - 24 * HOUR
    try {
      h.setNow(new Date(cutoff))
      const atCutoff = await h.book(h.people.chen, target, { expectStatus: 409 }) as unknown as { code?: string }
      expect(atCutoff).toBeUndefined()
      const res = await h.as(h.people.chen, 'post', '/me/bookings', { ...target, contactName: 'Revision Three Test', phone: { country: 'IN', number: '9876543210' } }, { 'Idempotency-Key': randomUUID() })
      expect(res.body.error.code).toBe('BOOKING_CUTOFF_PASSED')
      const payment = await h.as(h.people.chen, 'post', '/me/bookings', { ...target, contactName: 'Revision Three Test', phone: { country: 'IN', number: '9876543210' } }, { 'Idempotency-Key': randomUUID() }, 'payment')
      expect(payment.body.error.code).toBe('BOOKING_CUTOFF_PASSED')
      expect(await h.prisma.booking.count({ where: { sessionId: session.id } })).toBe(0)
      h.setNow(new Date(cutoff - 1))
      const justBefore = await h.book(h.people.chen, target)
      expect(new Date(justBefore.confirmationDueAt!).getTime()).toBe(cutoff)
    } finally {
      h.setNow(null)
    }
  })
})

describe('manual confirmation (admin)', () => {
  it('confirms with a reason: CONFIRMED by MANUAL, no payment attempt, seat unchanged, audited without the note text; identical repeat is a replay', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.asha, target)
    const res = await h.confirm(booking.id, { reason: 'PAYMENT_ARRANGED_OFFLINE', note: 'Bank transfer agreed by phone' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'CONFIRMED', canConfirm: false, canCancel: false, confirmation: { method: 'MANUAL', simulated: false, notice: MANUAL_CONFIRMATION_NOTICE } })
    expect(res.body.data.manualConfirmation).toMatchObject({ reason: 'PAYMENT_ARRANGED_OFFLINE', note: 'Bank transfer agreed by phone', by: { id: h.people.admin.userId } })
    const stored = await h.row(booking.id)
    expect(stored).toMatchObject({ status: 'CONFIRMED', confirmationMethod: 'MANUAL', confirmedByUserId: h.people.admin.userId, confirmationReason: 'PAYMENT_ARRANGED_OFFLINE' })
    expect(await h.prisma.paymentAttempt.count({ where: { bookingId: booking.id } })).toBe(0)
    expect(await h.seats(session.id)).toBe(1)
    const event = await h.prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_CONFIRMED_MANUALLY' } })
    expect(event).toMatchObject({ actorUserId: h.people.admin.userId, actorLabel: 'admin' })
    expect(event.details).toEqual({ reference: booking.reference, method: 'MANUAL', reason: 'PAYMENT_ARRANGED_OFFLINE', hasNote: true })
    expect(JSON.stringify(event.details)).not.toContain('Bank transfer')

    const again = await h.confirm(booking.id, { reason: 'PAYMENT_ARRANGED_OFFLINE', note: 'Bank transfer agreed by phone' })
    expect(again.status).toBe(200)
    expect(again.headers['idempotent-replayed']).toBe('true')
    const different = await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })
    expect(different.status).toBe(409)
    expect(different.body.error.code).toBe('BOOKING_NOT_CONFIRMABLE')
    expect(await h.prisma.auditEvent.count({ where: { targetId: booking.id, action: 'BOOKING_CONFIRMED_MANUALLY' } })).toBe(1)

    const customerView = await h.as(h.people.asha, 'get', `/me/bookings/${booking.id}`)
    expect(customerView.body.data.confirmation).toMatchObject({ method: 'MANUAL', notice: MANUAL_CONFIRMATION_NOTICE })
    expect(JSON.stringify(customerView.body.data)).not.toContain('Bank transfer') // notes are admin-only
  })

  it.each([
    ['OTHER without a note', { reason: 'OTHER' }, /note/],
    ['OTHER with a 2-character note', { reason: 'OTHER', note: 'ok' }, /note/],
    ['an unknown reason', { reason: 'PAID' }, /reason/],
    ['a card-like number in the note', { reason: 'OTHER', note: 'card 4111 1111 1111 1111' }, /long numbers/],
    ['a 501-character note', { reason: 'COMPLIMENTARY', note: 'x'.repeat(501) }, /500/],
    ['an extra field', { reason: 'COMPLIMENTARY', confirmedBy: 'someone' }, /unknown field/],
  ])('rejects %s (400) and changes nothing', async (_label, body, message) => {
    const { target } = await webinar()
    const booking = await h.book(h.people.ben, target)
    const res = await h.confirm(booking.id, body)
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(message)
    expect((await h.row(booking.id)).status).toBe('AWAITING_CONFIRMATION')
  })

  it('OTHER with an explanation and COMPLIMENTARY without a note are accepted', async () => {
    for (const body of [{ reason: 'OTHER', note: 'Partner organisation place' }, { reason: 'COMPLIMENTARY' }]) {
      const { target } = await webinar()
      const booking = await h.book(h.people.chen, target)
      expect((await h.confirm(booking.id, body)).status).toBe(200)
    }
  })

  it('only signed-in admins can confirm, with CSRF and an allowed Origin', async () => {
    const { target } = await webinar()
    const booking = await h.book(h.people.asha, target)
    const path = `/api/v1/admin/bookings/${booking.id}/confirm`
    expect((await request(h.apps.manual).post(path).set('Origin', PUBLIC_ORIGIN).send({ reason: 'COMPLIMENTARY' })).status).toBe(401)
    expect((await h.confirm(booking.id, { reason: 'COMPLIMENTARY' }, h.people.asha)).status).toBe(403)
    const badOrigin = await request(h.apps.manual).post(path).set('Cookie', h.people.admin.cookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', h.people.admin.csrf).send({ reason: 'COMPLIMENTARY' })
    expect(badOrigin.body.error.code).toBe('CSRF_FAILED')
    const noCsrf = await request(h.apps.manual).post(path).set('Cookie', h.people.admin.cookie).set('Origin', PUBLIC_ORIGIN).send({ reason: 'COMPLIMENTARY' })
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED')
    expect((await h.row(booking.id)).status).toBe('AWAITING_CONFIRMATION')
  })

  it('a payment-mode (PENDING_PAYMENT) booking cannot be confirmed manually', async () => {
    const { target } = await webinar()
    const booking = await h.book(h.people.ben, target, { mode: 'payment' })
    expect(booking.status).toBe('PENDING_PAYMENT')
    const res = await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('BOOKING_NOT_CONFIRMABLE')
    expect((await h.row(booking.id)).status).toBe('PENDING_PAYMENT')
  })
})

describe('confirmation deadline and expiry', () => {
  it('confirmation 1 ms before the deadline succeeds', async () => {
    const { target } = await webinar()
    const booking = await h.book(h.people.asha, target)
    h.setNow(new Date(new Date(booking.confirmationDueAt!).getTime() - 1))
    try {
      expect((await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })).status).toBe(200)
    } finally {
      h.setNow(null)
    }
  })

  it('confirmation exactly at the deadline expires the booking (committed and audited) and answers 409; it can never be confirmed afterwards', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.ben, target)
    h.setNow(new Date(booking.confirmationDueAt!))
    try {
      const late = await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })
      expect(late.status).toBe(409)
      expect(late.body.error.code).toBe('CONFIRMATION_WINDOW_EXPIRED')
      expect(await h.row(booking.id)).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: CONFIRMATION_EXPIRY_REASON, confirmedAt: null, confirmationMethod: null })
      expect(await h.seats(session.id)).toBe(0)
      expect(await h.auditActions(booking.id)).toEqual(['BOOKING_CONFIRMATION_REJECTED_LATE', 'BOOKING_CREATED', 'BOOKING_EXPIRED'])
      const again = await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })
      expect(again.body.error.code).toBe('BOOKING_NOT_CONFIRMABLE')
      expect(again.body.error.message).toMatch(/expired/)
      expect(await h.seats(session.id)).toBe(0)
    } finally {
      h.setNow(null)
    }
  })

  it('the sweep expires at the deadline, not 1 ms before; repeated sweeps release the seat once', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.chen, target)
    const due = new Date(booking.confirmationDueAt!)
    expect(await h.bookings.manual.expireOverdue(new Date(due.getTime() - 1), { sessionId: session.id })).toBe(0)
    expect((await h.row(booking.id)).status).toBe('AWAITING_CONFIRMATION')
    expect(await h.bookings.manual.expireOverdue(due, { sessionId: session.id })).toBe(1)
    expect(await h.bookings.manual.expireOverdue(due, { sessionId: session.id })).toBe(0)
    expect(await h.seats(session.id)).toBe(0)
    const expired = await h.prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_EXPIRED' } })
    expect(expired).toMatchObject({ actorUserId: null, actorLabel: 'system' })
    expect(expired.details).toMatchObject({ by: 'SYSTEM', reason: CONFIRMATION_EXPIRY_REASON, deadline: 'CONFIRMATION' })
    const view = await h.as(h.people.chen, 'get', `/me/bookings/${booking.id}`)
    expect(view.body.data.cancellation).toMatchObject({ by: 'SYSTEM', reason: CONFIRMATION_EXPIRY_REASON })
  })

  it('a confirmed booking never expires', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.asha, target)
    await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })
    await h.bookings.manual.expireOverdue(new Date(Date.now() + 10 * DAY), { sessionId: session.id })
    expect((await h.row(booking.id)).status).toBe('CONFIRMED')
    expect(await h.seats(session.id)).toBe(1)
  })
})

describe('direct cancellation of a booking awaiting confirmation', () => {
  it('the customer can cancel it; it cannot be confirmed afterwards; the seat is released once', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.ben, target)
    const res = await h.as(h.people.ben, 'post', `/me/bookings/${booking.id}/cancel`, {})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('CANCELLED')
    expect(await h.seats(session.id)).toBe(0)
    expect((await h.confirm(booking.id, { reason: 'COMPLIMENTARY' })).body.error.code).toBe('BOOKING_NOT_CONFIRMABLE')
    expect(await h.seats(session.id)).toBe(0)
  })

  it('an admin can decline it with a reason (audited as a decline)', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.chen, target)
    const res = await h.as(h.people.admin, 'post', `/admin/bookings/${booking.id}/cancel`, { reason: 'Dates no longer available for this group' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancellation: { by: 'ADMIN' } })
    expect(await h.seats(session.id)).toBe(0)
    const event = await h.prisma.auditEvent.findFirstOrThrow({ where: { targetId: booking.id, action: 'BOOKING_CANCELLED' } })
    expect(event.details).toMatchObject({ by: 'ADMIN', kind: 'DECLINED' })
  })

  it('awaiting, pending and confirmed bookings all count as the one active booking per customer and dates', async () => {
    const { target } = await webinar()
    await h.book(h.people.asha, target)
    const again = await h.as(h.people.asha, 'post', '/me/bookings', { ...target, contactName: 'Revision Three Test', phone: { country: 'IN', number: '9876543210' } }, { 'Idempotency-Key': randomUUID() })
    expect(again.body.error.code).toBe('ALREADY_BOOKED')
  })
})

describe('admin lists and dashboard', () => {
  it('filters awaiting / manually confirmed / cancellation requested, and counts each category without revenue', async () => {
    const { target } = await webinar()
    const awaiting = await h.book(h.people.ben, target)
    const awaitingList = await h.as(h.people.admin, 'get', '/admin/bookings?view=AWAITING_CONFIRMATION&pageSize=100')
    expect(awaitingList.body.data.every((item: { status: string }) => item.status === 'AWAITING_CONFIRMATION')).toBe(true)
    expect(awaitingList.body.data.map((item: { id: string }) => item.id)).toContain(awaiting.id)
    await h.confirm(awaiting.id, { reason: 'OTHER', note: 'Scholarship place' })
    const manualList = await h.as(h.people.admin, 'get', '/admin/bookings?view=MANUALLY_CONFIRMED&pageSize=100')
    expect(manualList.body.data.map((item: { id: string }) => item.id)).toContain(awaiting.id)
    expect(manualList.body.data.every((item: { confirmation: { method: string } }) => item.confirmation.method === 'MANUAL')).toBe(true)

    const dashboard = await h.as(h.people.admin, 'get', '/admin/dashboard')
    const counts = dashboard.body.data.bookings
    expect(counts.awaitingConfirmation).toBe(await h.prisma.booking.count({ where: { status: 'AWAITING_CONFIRMATION' } }))
    expect(counts.confirmedManual.OTHER).toBe(await h.prisma.booking.count({ where: { status: 'CONFIRMED', confirmationReason: 'OTHER' } }))
    expect(counts.confirmedManual.total).toBe(await h.prisma.booking.count({ where: { status: 'CONFIRMED', confirmationMethod: 'MANUAL' } }))
    expect(counts.confirmedPaid).toBe(0)
    expect(JSON.stringify(dashboard.body.data)).not.toMatch(/revenue/i)
  })
})

describe('database invariants (bypassing the API)', () => {
  const rawBooking = (sessionId: string, userId: string, extra: Record<string, unknown>) => ({
    reference: `DF-${randomUUID().replace(/[^0-9A-F]/gi, '').slice(0, 8).toUpperCase().replace(/[01IOL]/g, '2')}`,
    userId, productId: h.products.webinar, sessionId, priceAmount: '149.00', currency: 'INR', productName: 'Monthly Webinar',
    contactName: 'Revision Three Test', phoneCountry: 'IN', phoneDialingCode: '91', phoneNational: '9876543210', phoneE164: '+919876543210',
    idempotencyKey: `raw-${randomUUID()}`, ...extra,
  })

  it('refuses inserting CONFIRMED / CANCELLED rows, fabricated confirmation history, or a wrong confirmation deadline', async () => {
    const { session } = await webinar()
    const now = new Date()
    const due = new Date(now.getTime() + 48 * HOUR)
    for (const extra of [
      { status: 'CONFIRMED', confirmedAt: now, confirmationMethod: 'MANUAL', confirmedByUserId: h.people.admin.userId, confirmationReason: 'COMPLIMENTARY', createdAt: now, confirmationDueAt: due },
      { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'CUSTOMER', createdAt: now, confirmationDueAt: due },
      { status: 'AWAITING_CONFIRMATION', createdAt: now, confirmationDueAt: due, confirmedAt: now, confirmationMethod: 'PAYMENT' },
      { status: 'AWAITING_CONFIRMATION', createdAt: now, confirmationDueAt: due, paymentDueAt: new Date(now.getTime() + 30 * 60_000) },
    ]) {
      await expect(h.prisma.booking.create({ data: rawBooking(session.id, h.people.asha.userId, extra) as never })).rejects.toThrow(/must be AWAITING_CONFIRMATION with a confirmation deadline or PENDING_PAYMENT/)
    }
    await expect(h.prisma.booking.create({ data: rawBooking(session.id, h.people.asha.userId, { status: 'AWAITING_CONFIRMATION', createdAt: now, confirmationDueAt: new Date(due.getTime() - 1) }) as never }))
      .rejects.toThrow(/earlier of 48 hours after booking and 24 hours before the start/)
    await expect(h.prisma.booking.create({ data: rawBooking(session.id, h.people.asha.userId, { status: 'AWAITING_CONFIRMATION', createdAt: new Date(session.startsAt.getTime() - 24 * HOUR), confirmationDueAt: new Date(session.startsAt.getTime() - 24 * HOUR) }) as never }))
      .rejects.toThrow(/close 24 hours before the start/)
    expect(await h.seats(session.id)).toBe(0)
  })

  it('refuses invalid manual confirmations: wrong method, non-admin or disabled admin, at the deadline, back-dated, payment attempts', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.ben, target)
    const due = new Date(booking.confirmationDueAt!)
    const manual = (extra: Record<string, unknown>) => h.prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED', confirmationMethod: 'MANUAL', confirmedByUserId: h.people.admin.userId, confirmationReason: 'COMPLIMENTARY', confirmedAt: new Date(), ...extra } as never })
    await expect(manual({ confirmationMethod: 'PAYMENT', confirmedByUserId: null, confirmationReason: null })).rejects.toThrow(/can only be confirmed manually/)
    await expect(manual({ confirmedByUserId: h.people.ben.userId })).rejects.toThrow(/active administrator/)
    const disabled = await h.prisma.user.create({ data: { identityPool: 'ADMIN', identityIssuer: 'test', identitySubject: `disabled-${randomUUID()}`, email: 'disabled.admin@example.test', role: 'ADMIN', status: 'DISABLED', disabledAt: new Date() } })
    await expect(manual({ confirmedByUserId: disabled.id })).rejects.toThrow(/active administrator/)
    await expect(manual({ confirmedAt: due })).rejects.toThrow(/deadline has passed/)
    await expect(manual({ confirmedAt: new Date(Date.now() - 10 * 60_000) })).rejects.toThrow(/more than 5 minutes in the past/)
    await expect(manual({ confirmationReason: 'OTHER', confirmationNote: null })).rejects.toThrow(/bookings_other_reason_has_note/)
    await expect(h.prisma.paymentAttempt.create({ data: { bookingId: booking.id, provider: 'DEV_SIMULATOR', isSimulated: true, amount: '149.00', currency: 'INR', idempotencyKey: `raw-${randomUUID()}` } }))
      .rejects.toThrow(/only be started while the booking is pending payment/)
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { status: 'PENDING_PAYMENT' } })).rejects.toThrow(/status cannot change/)
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'SYSTEM', cancelReason: CONFIRMATION_EXPIRY_REASON } }))
      .rejects.toThrow(/deadline has passed can expire/)
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CUSTOMER', confirmedAt: new Date(), confirmationMethod: 'MANUAL', confirmedByUserId: h.people.admin.userId, confirmationReason: 'COMPLIMENTARY' } }))
      .rejects.toThrow(/confirmation history/)
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { confirmationDueAt: new Date(due.getTime() + DAY) } })).rejects.toThrow(/cannot change/)
    expect((await h.row(booking.id)).status).toBe('AWAITING_CONFIRMATION')
    expect(await h.seats(session.id)).toBe(1)
  })

  it('refuses editing or clearing confirmation history, and cancelling a confirmed booking without an approved request', async () => {
    const { session, target } = await webinar()
    const booking = await h.book(h.people.chen, target)
    await h.confirm(booking.id, { reason: 'PAYMENT_ARRANGED_OFFLINE', note: 'Arranged by phone' })
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { confirmationNote: 'Edited later' } })).rejects.toThrow(/confirmation history/)
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { confirmationReason: 'COMPLIMENTARY' } })).rejects.toThrow(/confirmation history/)
    for (const by of ['CUSTOMER', 'ADMIN', 'SYSTEM'] as const) {
      await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date(Date.now() + 100 * DAY), cancelledBy: by, cancelReason: 'Direct cancellation attempt' } }))
        .rejects.toThrow(/except through an approved cancellation request/)
    }
    await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { status: 'AWAITING_CONFIRMATION' } })).rejects.toThrow(/except through an approved cancellation request/)
    const customerCancel = await h.as(h.people.chen, 'post', `/me/bookings/${booking.id}/cancel`, {})
    expect(customerCancel.body.error.message).toMatch(/cancelled by request/)
    const adminCancel = await h.as(h.people.admin, 'post', `/admin/bookings/${booking.id}/cancel`, { reason: 'Direct admin cancel' })
    expect(adminCancel.body.error.message).toMatch(/cancelled by request/)
    expect(await h.row(booking.id)).toMatchObject({ status: 'CONFIRMED', confirmationNote: 'Arranged by phone' })
    expect(await h.seats(session.id)).toBe(1)
  })
})
