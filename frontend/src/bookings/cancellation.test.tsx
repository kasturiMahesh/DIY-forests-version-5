// Revision 3 frontend: manual-confirmation wording, cancellation requests and refund-eligibility wording,
// and the admin confirmation form. Unit tests with a fake fetch; no backend is involved.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createAdminApi } from '../admin/admin-api'
import { ManualConfirmForm } from '../admin/BookingsPanel'
import { createApiClient, isCustomerBooking } from '../api/client'
import type { CancellationRequest, CustomerBooking } from '../api/types'
import { CheckoutResults } from '../pages/HomePage'
import { AWAITING_LABEL, awaitingConfirmationText, bookingStatusLabel, cancellationRequestText, CUTOFF_MESSAGE, EXPIRED_MESSAGE, MANUAL_CONFIRMATION } from './booking-display'
import { BookingSummary } from './MyBookings'

const awaiting: CustomerBooking = {
  id: '0199a000-0000-7000-8000-0000000000c1', reference: 'DF-7K2M9QXB', status: 'AWAITING_CONFIRMATION',
  product: { id: 'p1', slug: 'offline-workshop', type: 'OFFLINE_WORKSHOP', name: 'Offline Workshop' },
  price: { amount: '100000.00', currency: 'INR' },
  target: { kind: 'session', id: 's1', startsAt: '2026-11-20T04:30:00.000Z', endsAt: '2026-11-22T12:30:00.000Z', timezone: 'Asia/Kolkata', venue: 'Afforestt, Uttarakhand', status: 'PUBLISHED' },
  cancellation: null, payment: { dueAt: null, openAttemptId: null, attempts: [] }, confirmationDueAt: '2026-10-28T10:00:00.000Z', confirmation: null, cancellationRequest: null,
  createdAt: '2026-10-26T10:00:00.000Z', updatedAt: '2026-10-26T10:00:00.000Z', canCancel: true, canPay: false, canRequestCancellation: false,
  contact: { name: 'Asha Rao', phone: { country: 'IN', dialingCode: '91', nationalNumber: '9876543210', e164: '+919876543210' } },
}
const confirmedManually: CustomerBooking = {
  ...awaiting, status: 'CONFIRMED', canCancel: false, canRequestCancellation: true,
  confirmation: { at: '2026-10-26T12:00:00.000Z', method: 'MANUAL', simulated: false, notice: MANUAL_CONFIRMATION },
}
const request = (overrides: Partial<CancellationRequest> = {}): CancellationRequest => ({
  id: '0199a000-0000-7000-8000-0000000000d1', status: 'PENDING', requestedAt: '2026-11-10T04:30:00.000Z', refundPolicy: 'TRAINING_V1', refundPercent: 100,
  customerReason: null, decidedAt: null, decisionReason: null, refundOutcome: null, ...overrides,
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
type Call = { url: string; init: RequestInit }
const clientAnswering = (respond: () => Response, calls: Call[] = []) =>
  createApiClient({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init: init ?? {} }); return respond() }) as typeof fetch })
// Wording must never say money was received or a refund was made.
// ('nothing paid', 'not yet paid' and 'you paid' are allowed: they never claim money was received.)
const NEVER = /\brefunded\b|refund (has been|was) (issued|processed|made)|payment (was )?received|(?<!nothing |not yet |you )\bpaid\b/i

describe('awaiting confirmation', () => {
  it('uses the approved label and explanation: seat held, nothing paid, phone contact target, no email promise', () => {
    expect(bookingStatusLabel(awaiting)).toBe('Awaiting confirmation · seat held, nothing paid')
    expect(AWAITING_LABEL).toBe(bookingStatusLabel(awaiting))
    const text = awaitingConfirmationText(awaiting)!
    expect(text).toMatch(/^Your booking request has been received\. We are holding your seat until .+\. No payment has been taken through this website\. Our team aims to contact you by phone within 24 hours to confirm your booking and explain the next steps\. If we cannot confirm your request before the deadline, the request will be cancelled and the seat released\.$/)
    expect(text).not.toMatch(/email/i)
    const html = renderToStaticMarkup(<BookingSummary booking={awaiting} />)
    expect(html).toContain('Awaiting confirmation · seat held, nothing paid')
    expect(html).toContain('within 24 hours')
    expect(html).not.toMatch(NEVER)
  })

  it('an expired request explains the cancellation and seat release', () => {
    const expired: CustomerBooking = { ...awaiting, status: 'CANCELLED', canCancel: false, cancellation: { at: '2026-10-28T10:00:00.000Z', by: 'SYSTEM', reason: 'Not confirmed in time' } }
    expect(bookingStatusLabel(expired)).toBe('Cancelled · not confirmed in time')
    expect(renderToStaticMarkup(<BookingSummary booking={expired} />)).toContain(EXPIRED_MESSAGE)
    expect(EXPIRED_MESSAGE).toBe('We could not confirm your booking before the deadline, so your request has been cancelled and the seat released.')
  })

  it('explains the 24-hour booking cutoff', () => {
    expect(CUTOFF_MESSAGE).toBe('Bookings close 24 hours before the start time. Please contact us if you’d like to join.')
  })

  it('checkout results for a manual booking say awaiting confirmation, never paid', () => {
    const html = renderToStaticMarkup(<CheckoutResults results={[{ cartId: 'a', title: 'Offline Workshop', ok: true, booking: awaiting }]} onClose={() => {}} />)
    expect(html).toContain('awaiting confirmation')
    expect(html).toContain('Awaiting confirmation · seat held, nothing paid')
    expect(html).toContain('No payment has been taken')
    expect(html).not.toMatch(/email/i)
    expect(html).not.toMatch(NEVER)
  })
})

describe('manual confirmation', () => {
  it('says no payment was taken through the website (never a test-mode or paid message)', () => {
    expect(bookingStatusLabel(confirmedManually)).toBe(MANUAL_CONFIRMATION)
    expect(MANUAL_CONFIRMATION).toBe('Confirmed by DIY Forests. No payment was taken through this website. Our team will explain any agreed payment arrangements separately.')
    const html = renderToStaticMarkup(<BookingSummary booking={confirmedManually} />)
    expect(html).toContain('No payment was taken through this website')
    expect(html).not.toContain('test-mode')
    // Even without the server's notice, a manual confirmation is never described as simulated.
    expect(bookingStatusLabel({ ...confirmedManually, confirmation: { ...confirmedManually.confirmation!, notice: null } })).toBe(MANUAL_CONFIRMATION)
  })
})

describe('cancellation requests', () => {
  it('pending: shows the fixed eligibility and that the booking stays active', () => {
    expect(cancellationRequestText(request({ refundPercent: 50 }))).toMatch(/^Cancellation requested on .+\. Under our policy this request is eligible for a 50% refund of any amount you paid\. Our team will review it; your booking remains active until then\.$/)
  })

  it('approved: truthful wording for each outcome; never claims a refund was made', () => {
    const offline = cancellationRequestText(request({ status: 'APPROVED', refundOutcome: 'NOT_PROCESSED_BY_WEBSITE', refundPercent: 50 }))
    expect(offline).toBe('Your booking has been cancelled. No payment was taken and no refund has been made through this website. If you paid our team directly, they will contact you about any refund due under our policy (50%).')
    expect(cancellationRequestText(request({ status: 'APPROVED', refundOutcome: 'NO_REFUND_COMPLIMENTARY' }))).toBe('Your booking has been cancelled. This booking was complimentary, so there is no payment to refund.')
    expect(cancellationRequestText(request({ status: 'APPROVED', refundOutcome: 'NO_REFUND_SIMULATED_PAYMENT' }))).toBe('Your booking has been cancelled. Its payment was a test-mode simulation: no money was received and no refund is issued.')
    for (const text of [offline, cancellationRequestText(request({ status: 'APPROVED', refundOutcome: 'NO_REFUND_COMPLIMENTARY' }))]) expect(text).not.toMatch(/\brefunded\b/i)
  })

  it('rejected: the reason and that the booking remains confirmed', () => {
    expect(cancellationRequestText(request({ status: 'REJECTED', decisionReason: 'Outside the policy window' }))).toBe('Your cancellation request was not approved: Outside the policy window. Your booking remains confirmed.')
  })

  it('a confirmed booking with a pending request shows it', () => {
    const html = renderToStaticMarkup(<BookingSummary booking={{ ...confirmedManually, canRequestCancellation: false, cancellationRequest: request() }} />)
    expect(html).toContain('eligible for a 100% refund of any amount you paid')
  })

  it('the client sends only an optional reason and validates the answer', async () => {
    const calls: Call[] = []
    const answer = { data: { request: request(), booking: { ...confirmedManually, cancellationRequest: request(), canRequestCancellation: false } } }
    const result = await clientAnswering(() => json(answer, 201), calls).requestCancellation('csrf-1', confirmedManually.id, null)
    expect(result.request.refundPercent).toBe(100)
    expect(calls[0]!.url).toBe(`/api/v1/me/bookings/${confirmedManually.id}/cancellation-request`)
    expect(calls[0]!.init.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({})
    await expect(clientAnswering(() => json({ data: { request: { ...request(), refundPercent: 75 }, booking: confirmedManually } })).requestCancellation('c', confirmedManually.id, null)).rejects.toMatchObject({ kind: 'invalid-response' })
    await expect(clientAnswering(() => json({ data: { request: { ...request(), refundOutcome: 'REFUNDED' }, booking: confirmedManually } })).requestCancellation('c', confirmedManually.id, null)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('bookings awaiting confirmation pass the response check', () => {
    expect(isCustomerBooking(awaiting)).toBe(true)
    expect(isCustomerBooking({ ...awaiting, status: 'AWAITING' })).toBe(false)
  })
})

describe('admin', () => {
  it('the confirmation form warns that offline arrangements are not proof of payment, and never asks for card or bank details', () => {
    const html = renderToStaticMarkup(<ManualConfirmForm disabled={false} onConfirm={async () => {}} />)
    expect(html).toContain('Payment arranged offline is not proof of payment.')
    expect(html).toContain('Never enter card numbers, CVVs or bank details')
    expect(html).toContain('Payment arranged offline')
    expect(html).toContain('Complimentary')
    expect(html).toContain('Other (explain)')
    expect(html).not.toMatch(/<input/)
  })

  it('the admin client posts confirmations and decisions with CSRF; only the reason and an optional note are sent', async () => {
    const calls: Call[] = []
    const adminBooking = { ...confirmedManually, customer: { id: 'u', email: 'a@example.test', displayName: null }, contactName: 'Asha Rao' }
    const admin = createAdminApi(clientAnswering(() => json({ data: adminBooking }), calls), 'csrf-admin')
    await admin.confirmBooking(awaiting.id, 'COMPLIMENTARY', null)
    expect(calls[0]!.url).toBe(`/api/v1/admin/bookings/${awaiting.id}/confirm`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ reason: 'COMPLIMENTARY' })
    expect(calls[0]!.init.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-admin' })
    const decided = createAdminApi(clientAnswering(() => json({ data: { request: request({ status: 'APPROVED', refundOutcome: 'NO_REFUND_COMPLIMENTARY' }), booking: { ...adminBooking, status: 'CANCELLED' } } }), calls), 'csrf-admin')
    await decided.approveCancellation(awaiting.id, 'Within the policy')
    expect(calls[1]!.url).toBe(`/api/v1/admin/bookings/${awaiting.id}/cancellation-request/approve`)
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ reason: 'Within the policy' })
  })
})
