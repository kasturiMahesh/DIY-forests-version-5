// Stage 2 frontend: development payment simulator client calls, booking status wording, the
// 30-minute hold display and the rules for showing simulator controls. No backend is involved.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createAdminApi } from '../admin/admin-api'
import { createApiClient } from '../api/client'
import type { CustomerBooking, PaymentAttempt, PaymentConfig } from '../api/types'
import { bookingStatusLabel, paymentDeadlineText, SIMULATED_CONFIRMATION, simulatorAvailable } from './booking-display'
import { BookingSummary } from './MyBookings'
import PaymentSimulator from './PaymentSimulator'
import { createSimulatorApi } from './simulator-api'

const attempt: PaymentAttempt = {
  id: '0199a000-0000-7000-8000-00000000a001', status: 'CREATED', provider: 'DEV_SIMULATOR', simulated: true,
  amount: { amount: '149.00', currency: 'INR' }, failureReason: null, completedAt: null, createdAt: '2026-10-26T10:00:00.000Z',
}
const pending: CustomerBooking = {
  id: '0199a000-0000-7000-8000-0000000000b1', reference: 'DF-7K2M9QXA', status: 'PENDING_PAYMENT',
  product: { id: 'p1', slug: 'monthly-webinar', type: 'WEBINAR', name: 'Monthly Webinar' },
  price: { amount: '149.00', currency: 'INR' },
  target: { kind: 'session', id: 's1', startsAt: '2026-11-06T13:00:00.000Z', endsAt: null, timezone: 'Asia/Kolkata', venue: null, status: 'PUBLISHED' },
  cancellation: null, payment: { dueAt: '2026-10-26T10:30:00.000Z', openAttemptId: null, attempts: [] }, confirmation: null,
  createdAt: '2026-10-26T10:00:00.000Z', updatedAt: '2026-10-26T10:00:00.000Z', canCancel: true, canPay: true,
  contact: { name: 'Asha Rao', phone: { country: 'IN', dialingCode: '91', nationalNumber: '9876543210', e164: '+919876543210' } },
}
const confirmed: CustomerBooking = {
  ...pending, status: 'CONFIRMED', canCancel: false, canPay: false,
  payment: { dueAt: pending.payment!.dueAt, openAttemptId: null, attempts: [{ ...attempt, status: 'SUCCEEDED', completedAt: '2026-10-26T10:05:00.000Z' }] },
  confirmation: { at: '2026-10-26T10:05:00.000Z', simulated: true, notice: 'Confirmed — simulated payment, no money received.' },
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
type Call = { url: string; init: RequestInit }
const clientAnswering = (respond: () => Response, calls: Call[] = []) =>
  createApiClient({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init: init ?? {} }); return respond() }) as typeof fetch })

describe('payment simulator API client', () => {
  it('reads the server’s simulator configuration', async () => {
    const config = await clientAnswering(() => json({ data: { simulator: { enabled: true, environment: 'development' }, realPayments: false } })).getPaymentConfig()
    expect(config.simulator.enabled).toBe(true)
    await expect(clientAnswering(() => json({ data: { simulator: 'on' } })).getPaymentConfig()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('starts an attempt with the Idempotency-Key and CSRF headers and sends no money or card fields', async () => {
    const calls: Call[] = []
    const result = await createSimulatorApi(clientAnswering(() => json({ data: { attempt, booking: { ...pending, payment: { ...pending.payment!, openAttemptId: attempt.id, attempts: [attempt] } } } }, 201), calls))
      .startPayment('csrf-1', pending.id, 'key-0123456789abcdef')
    expect(result.attempt.id).toBe(attempt.id)
    expect(calls[0]!.url).toBe(`/api/v1/me/bookings/${pending.id}/payment-attempts`)
    expect(calls[0]!.init.headers).toMatchObject({ 'Idempotency-Key': 'key-0123456789abcdef', 'X-CSRF-Token': 'csrf-1' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({})
  })

  it('rejects a malformed simulator response', async () => {
    await expect(createSimulatorApi(clientAnswering(() => json({ data: { attempt: { ...attempt, provider: 'CARD' }, booking: pending } }))).cancelPaymentAttempt('c', pending.id, attempt.id))
      .rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('simulates only an outcome; nothing else is sent', async () => {
    const calls: Call[] = []
    await createSimulatorApi(clientAnswering(() => json({ data: { attempt: { ...attempt, status: 'SUCCEEDED', completedAt: confirmed.confirmation!.at }, booking: confirmed } }), calls))
      .simulatePayment('csrf-1', pending.id, attempt.id, 'SUCCEEDED')
    expect(calls[0]!.url).toBe(`/api/v1/me/bookings/${pending.id}/payment-attempts/${attempt.id}/simulate`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ outcome: 'SUCCEEDED' })
  })

  it.each([
    ['a "PAID" status the API never sends', { ...confirmed, status: 'PAID' }],
    ['a CONFIRMED booking without its confirmation', { ...confirmed, confirmation: null }],
    ['an attempt from an unknown provider', { ...confirmed, payment: { ...confirmed.payment!, attempts: [{ ...attempt, provider: 'CARD' }] } }],
  ])('rejects a booking with %s', async (_label, booking) => {
    await expect(clientAnswering(() => json({ data: booking })).cancelMyBooking('c', pending.id, null)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('the admin client accepts CONFIRMED bookings', async () => {
    const client = clientAnswering(() => json({ data: [{ ...confirmed, customer: { id: 'u', email: 'a@example.test', displayName: null }, contactName: 'Asha Rao' }], meta: { page: 1, pageSize: 20, total: 1 } }))
    const page = await createAdminApi(client, 'csrf').listBookings({ status: 'CONFIRMED' })
    expect(page.items[0]!.status).toBe('CONFIRMED')
  })
})

describe('booking status wording', () => {
  it('a simulated confirmation always says no money was received', () => {
    expect(SIMULATED_CONFIRMATION).toBe('Confirmed — simulated payment, no money received.')
    expect(bookingStatusLabel(confirmed)).toBe(SIMULATED_CONFIRMATION)
    // Even if the server's notice were missing, the simulated wording is shown (no real provider exists).
    expect(bookingStatusLabel({ ...confirmed, confirmation: { ...confirmed.confirmation!, notice: null } })).toBe(SIMULATED_CONFIRMATION)
    const html = renderToStaticMarkup(<BookingSummary booking={confirmed} now={new Date('2026-10-26T10:10:00Z')} />)
    expect(html).toContain('Confirmed — simulated payment, no money received.')
    expect(html).toContain('no payment was received')
    expect(html).not.toMatch(/\bpaid\b/i)
  })

  it('pending bookings show their 30-minute deadline; older bookings without one show none', () => {
    const now = new Date('2026-10-26T10:10:00Z')
    expect(paymentDeadlineText(pending, now)).toMatch(/^Seat held until .+\(30 minutes from booking\)\. Unpaid bookings are released automatically\.$/)
    expect(paymentDeadlineText(pending, new Date('2026-10-26T10:31:00Z'))).toMatch(/window has passed/)
    expect(paymentDeadlineText({ ...pending, payment: { ...pending.payment!, dueAt: null } }, now)).toBeNull()
    expect(paymentDeadlineText(confirmed, now)).toBeNull()
    expect(renderToStaticMarkup(<BookingSummary booking={pending} now={now} />)).toContain('Seat held until')
  })

  it('an expired booking says why', () => {
    const expired: CustomerBooking = { ...pending, status: 'CANCELLED', canCancel: false, canPay: false, cancellation: { at: '2026-10-26T10:31:00.000Z', by: 'SYSTEM', reason: 'Payment not completed in time' } }
    expect(bookingStatusLabel(expired)).toBe('Cancelled · payment not completed in time')
    expect(renderToStaticMarkup(<BookingSummary booking={expired} />)).toContain('automatically: Payment not completed in time')
  })
})

describe('when simulator controls appear', () => {
  const on: PaymentConfig = { simulator: { enabled: true, environment: 'development' }, realPayments: false }
  it('only in a development build, and only when the server reports the simulator enabled', () => {
    expect(simulatorAvailable(true, on)).toBe(true)
    expect(simulatorAvailable(false, on)).toBe(false) // production build: never
    expect(simulatorAvailable(true, { simulator: { enabled: false }, realPayments: false })).toBe(false)
    expect(simulatorAvailable(true, null)).toBe(false) // config unavailable: hidden
    expect(simulatorAvailable(true, { ...on, realPayments: true })).toBe(false)
  })

  it('the simulator is clearly test-only and has no card, CVV or bank inputs', () => {
    const client = createApiClient({ fetch: (async () => json({})) as typeof fetch })
    const idle = renderToStaticMarkup(<PaymentSimulator booking={pending} csrfToken="c" client={client} onChange={() => {}} onSessionExpired={() => {}} />)
    expect(idle).toContain('Test mode — development payment simulator.')
    expect(idle).toContain('No real payment is taken or received')
    expect(idle).toContain('Start simulated payment')
    expect(idle).not.toMatch(/<input|<select|<textarea/)
    const open = renderToStaticMarkup(<PaymentSimulator booking={{ ...pending, payment: { ...pending.payment!, openAttemptId: attempt.id, attempts: [attempt] } }} csrfToken="c" client={client} onChange={() => {}} onSessionExpired={() => {}} />)
    expect(open).toContain('Simulate success')
    expect(open).toContain('Simulate failure')
    expect(open).toContain('Cancel payment')
    expect(open).toContain('aria-label="Payment simulator for booking DF-7K2M9QXA"')
  })
})
