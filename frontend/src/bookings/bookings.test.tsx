// Stage 4C frontend: booking client, checkout logic and the checkout/result screens (rendered to HTML).
// Unit tests with a fake fetch / fake client — no backend is involved.
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ApiError, createApiClient, newIdempotencyKey } from '../api/client'
import type { CustomerBooking, MeResponse, PublicSession } from '../api/types'
import { AuthContext, type AuthState } from '../auth/auth-context'
import { CatalogContext, type CatalogState } from '../catalog/catalog-context'
import { WebinarBanner } from '../catalog/WebinarBanner'
import HomePage, { CheckoutPanel, CheckoutResults, DateChipModal } from '../pages/HomePage'
import { requestBookings, UNCONFIRMED_MESSAGE, type CheckoutItem } from './checkout'

const booking: CustomerBooking = {
  id: '0199a000-0000-7000-8000-0000000000b1', reference: 'DF-7K2M9QXA', status: 'PENDING_PAYMENT',
  product: { id: 'p1', slug: 'monthly-webinar', type: 'WEBINAR', name: 'Monthly Webinar' },
  price: { amount: '149.00', currency: 'INR' },
  target: { kind: 'session', id: 's1', startsAt: '2026-11-06T13:00:00.000Z', endsAt: null, timezone: 'Asia/Kolkata', venue: null, status: 'PUBLISHED' },
  cancellation: null, createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', canCancel: true,
  contact: { name: 'Asha Rao', phone: { country: 'IN', dialingCode: '91', nationalNumber: '9876543210', e164: '+919876543210' } },
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
type Call = { url: string; init: RequestInit }
const clientAnswering = (respond: () => Response, calls: Call[] = []) =>
  createApiClient({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init: init ?? {} }); return respond() }) as typeof fetch })

describe('api.createBooking', () => {
  it('POSTs to /me/bookings with the Idempotency-Key and CSRF headers and returns the server booking', async () => {
    const calls: Call[] = []
    const client = clientAnswering(() => json({ data: booking }, 201), calls)
    const result = await client.createBooking('csrf-1', { productId: 'p1', sessionId: 's1', contactName: 'Asha Rao', phone: { country: 'IN', number: '9876543210' } }, 'key-0123456789abcdef')
    expect(result).toEqual({ booking, replayed: false })
    expect(calls[0]!.url).toBe('/api/v1/me/bookings')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers).toMatchObject({ 'Idempotency-Key': 'key-0123456789abcdef', 'X-CSRF-Token': 'csrf-1' })
    // The client never sends a price, status or user: the server decides those.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ productId: 'p1', sessionId: 's1', contactName: 'Asha Rao', phone: { country: 'IN', number: '9876543210' } })
  })

  it('generates idempotency keys the server accepts (16–64 URL-safe characters), unique per call', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()))
    expect(keys.size).toBe(50)
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('200 means the server replayed an earlier identical request', async () => {
    expect((await clientAnswering(() => json({ data: booking }, 200)).createBooking('c', { productId: 'p1', sessionId: 's1', contactName: 'A', phone: { country: 'IN', number: '1' } }, 'k'.repeat(16))).replayed).toBe(true)
  })

  it.each([
    ['a "paid" status the API never sends', { ...booking, status: 'PAID' }],
    ['no reference', { ...booking, reference: undefined }],
    ['a malformed price', { ...booking, price: { amount: 149, currency: 'INR' } }],
  ])('rejects a success response with %s (nothing is shown as booked)', async (_label, data) => {
    await expect(clientAnswering(() => json({ data }, 201)).createBooking('c', { productId: 'p1', sessionId: 's1', contactName: 'A', phone: { country: 'IN', number: '1' } }, 'k'.repeat(16)))
      .rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('passes the server error code and message through', async () => {
    const error = await clientAnswering(() => json({ error: { code: 'SOLD_OUT', message: 'These dates are fully booked', requestId: 'r' } }, 409))
      .createBooking('c', { productId: 'p1', sessionId: 's1', contactName: 'A', phone: { country: 'IN', number: '1' } }, 'k'.repeat(16)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message: 'These dates are fully booked', details: { status: 409, code: 'SOLD_OUT' } })
  })
})

describe('requestBookings (checkout logic)', () => {
  const items: CheckoutItem[] = [
    { cartId: 'a', title: 'Monthly Webinar', booking: { productId: 'p1', sessionId: 's1' }, bookingKey: 'key-a-0123456789ab' },
    { cartId: 'b', title: 'Online Training', booking: { productId: 'p2', cohortId: 'c1' }, bookingKey: 'key-b-0123456789ab' },
  ]
  const contact = { contactName: 'Asha Rao', phone: { country: 'IN', number: '9876543210' } }
  const http = (status: number, code: string, message = code) => new ApiError('http', message, { status, code })
  const fake = (answers: (Error | CustomerBooking)[]) => {
    const sent: { key: string; body: unknown }[] = []
    return {
      sent,
      client: {
        createBooking: async (_csrf: string, body: unknown, key: string) => {
          sent.push({ key, body })
          const answer = answers.shift()!
          if (answer instanceof Error) throw answer
          return { booking: answer, replayed: false }
        },
      },
    }
  }

  it('one request per item, each with its own key; only server bookings count as booked', async () => {
    const { client, sent } = fake([booking, http(409, 'SOLD_OUT', 'These dates are fully booked')])
    const outcome = await requestBookings(client, 'csrf', items, contact)
    expect(sent.map((call) => call.key)).toEqual(['key-a-0123456789ab', 'key-b-0123456789ab'])
    expect(outcome).toEqual({ kind: 'done', rotateKeys: [], results: [
      { cartId: 'a', title: 'Monthly Webinar', ok: true, booking },
      { cartId: 'b', title: 'Online Training', ok: false, message: 'These dates are fully booked' },
    ] })
  })

  it('a network failure is reported as unconfirmed, never as a booking', async () => {
    const { client } = fake([new ApiError('network', 'Could not reach the server.'), new ApiError('timeout', 'slow')])
    const outcome = await requestBookings(client, 'csrf', items, contact)
    expect(outcome.kind === 'done' && outcome.results.every((result) => !result.ok && result.message === UNCONFIRMED_MESSAGE)).toBe(true)
  })

  it('a rejected phone number stops the checkout before anything is booked', async () => {
    const { client, sent } = fake([http(400, 'PHONE_INVALID', 'Enter a valid phone number for the selected country (+91).')])
    expect(await requestBookings(client, 'csrf', items, contact)).toEqual({ kind: 'field-error', message: 'Enter a valid phone number for the selected country (+91).' })
    expect(sent).toHaveLength(1)
  })

  it('an expired session stops immediately', async () => {
    const { client, sent } = fake([http(401, 'UNAUTHENTICATED')])
    expect(await requestBookings(client, 'csrf', items, contact)).toEqual({ kind: 'expired' })
    expect(sent).toHaveLength(1)
  })

  it('sends only the booking fields, even if the stored cart item carries anything else', async () => {
    const { client, sent } = fake([booking])
    const tampered = { ...items[0]!, booking: { ...items[0]!.booking, price: { amount: '1.00' }, status: 'PAID' } as CheckoutItem['booking'] }
    await requestBookings(client, 'csrf', [tampered], contact)
    expect(sent[0]!.body).toEqual({ productId: 'p1', sessionId: 's1', contactName: 'Asha Rao', phone: { country: 'IN', number: '9876543210' } })
  })

  it('a key the server saw for a different booking is flagged for rotation', async () => {
    const { client } = fake([http(409, 'IDEMPOTENCY_KEY_REUSED', 'reused'), booking])
    const outcome = await requestBookings(client, 'csrf', items, contact)
    expect(outcome).toMatchObject({ kind: 'done', rotateKeys: ['a'] })
  })
})

const customer: MeResponse = {
  user: { id: 'u1', email: 'asha@example.test', emailVerified: true, displayName: 'Asha Rao', role: 'CUSTOMER', pool: 'CUSTOMER' },
  session: { kind: 'CUSTOMER', idleExpiresAt: '2026-10-16T22:00:00.000Z', absoluteExpiresAt: '2026-10-23T10:00:00.000Z' },
  csrfToken: 'csrf',
}
const auth = (overrides: Partial<AuthState>): AuthState => ({ status: 'loading', me: null, expired: false, refresh: () => {}, sessionExpired: () => {}, signOut: async () => {}, ...overrides })
const cart = [{ cartId: 'a', title: 'Monthly Webinar', price: 149, currency: 'INR' as const, meta: 'Fri 6 Nov', art: { src: '/x.png', alt: '' }, booking: { productId: 'p1', sessionId: 's1' }, bookingKey: 'key-a-0123456789ab' }]
const renderWith = (state: AuthState, element: React.ReactElement) =>
  renderToStaticMarkup(<MemoryRouter><AuthContext.Provider value={state}>{element}</AuthContext.Provider></MemoryRouter>)
const panel = (state: AuthState) => renderWith(state, <CheckoutPanel cart={cart} onClose={() => {}} onDone={() => {}} onRotateKey={() => {}} />)

describe('checkout screen', () => {
  it('signed out: asks to sign in (cart kept); no form, no booking claims', () => {
    const html = panel(auth({ status: 'signed-out' }))
    expect(html).toContain('href="/api/v1/auth/login?returnTo=%2F%23trainings"')
    expect(html).toContain('Your cart is kept')
    expect(html).not.toContain('checkoutForm')
  })

  it('signed in: real contact form, account email, server-validated phone; no payment method, no GST', () => {
    const html = panel(auth({ status: 'signed-in', me: customer }))
    expect(html).toContain('id="checkoutForm"')
    expect(html).toContain('value="asha@example.test"')
    expect(html).toContain('India (+91)')
    expect(html).toContain('Request booking')
    expect(html).toContain('No payment is taken now')
    expect(html).toMatch(/Total.*₹149/)
    for (const removed of ['GST', 'UPI', 'Netbanking', 'Card', 'Complete demo booking', 'Demo only', 'pay-chip']) expect(html).not.toContain(removed)
    // Browsers compile `pattern` with the regex v flag; an invalid pattern is silently ignored.
    const pattern = /id="checkoutPhone"[^>]*pattern="([^"]+)"/.exec(html)![1]!
    expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow()
    expect(new RegExp(`^(?:${pattern})$`, 'v').test('+91 (98765) 43210')).toBe(true)
  })

  it('staff sessions are told to use a customer account', () => {
    const admin: MeResponse = { ...customer, user: { ...customer.user, role: 'ADMIN', pool: 'ADMIN' }, session: { ...customer.session, kind: 'ADMIN' } }
    const html = panel(auth({ status: 'signed-in', me: admin }))
    expect(html).toContain('staff account')
    expect(html).not.toContain('checkoutForm')
  })

  it('sign-in unavailable: a clear error, no form', () => {
    expect(panel(auth({ status: 'unavailable' }))).toMatch(/Booking isn’t available at the moment/)
  })
})

describe('checkout results', () => {
  it('shows exactly the bookings the server returned, as pending payment (never paid)', () => {
    const html = renderToStaticMarkup(<CheckoutResults results={[{ cartId: 'a', title: 'Monthly Webinar', ok: true, booking }]} onClose={() => {}} />)
    expect(html).toContain('DF-7K2M9QXA')
    expect(html).toContain('payment pending')
    expect(html).toContain('No payment has been taken')
    expect(html).toContain('href="/account"')
    expect(html).not.toMatch(/\bpaid\b(?! )/i)
    expect(html).not.toContain('confetti')
  })

  it('when nothing was booked: no success mark, the server reason, items kept', () => {
    const html = renderToStaticMarkup(<CheckoutResults results={[{ cartId: 'a', title: 'Monthly Webinar', ok: false, message: 'These dates are fully booked' }]} onClose={() => {}} />)
    expect(html).toContain('Booking not completed')
    expect(html).toContain('These dates are fully booked')
    expect(html).toContain('still in your cart')
    expect(html).not.toContain('M20 33l8 8 16-18') // the success check mark
    expect(html).not.toContain('DF-')
  })
})

describe('home page: no demo checkout left', () => {
  const catalog: CatalogState = { status: 'ready', products: [], nextWebinar: null, workshopBatches: [], trainingCohorts: [], retry: () => {} }
  it('renders no GST, payment methods, confetti or demo-booking text', () => {
    const html = renderWith(auth({ status: 'signed-out' }), <CatalogContext.Provider value={catalog}><HomePage /></CatalogContext.Provider>)
    expect(html).toContain('id="cartTotal"')
    for (const removed of ['GST', 'cartGst', 'confetti-piece', 'Complete demo booking', 'payMethods']) expect(html).not.toContain(removed)
  })
})

describe('server-driven availability', () => {
  const soldOut: PublicSession = { id: 's1', startsAt: '2099-11-06T13:00:00.000Z', endsAt: null, timezone: 'Asia/Kolkata', capacity: 40, seatsAvailable: 0, venue: null, product: { id: 'p1', slug: 'monthly-webinar', name: 'Monthly Webinar', type: 'WEBINAR', price: { amount: '149.00', currency: 'INR' } } }
  const ready = (nextWebinar: PublicSession): CatalogState => ({ status: 'ready', products: [], nextWebinar, workshopBatches: [], trainingCohorts: [], retry: () => {} })

  it('a sold-out webinar cannot be reserved', () => {
    const html = renderToStaticMarkup(<WebinarBanner catalog={ready(soldOut)} price={soldOut.product.price} onReserve={() => {}} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Fully booked</)
  })

  it('a webinar with seats left stays reservable (no invented seat count)', () => {
    const html = renderToStaticMarkup(<WebinarBanner catalog={ready({ ...soldOut, seatsAvailable: 3 })} price={soldOut.product.price} onReserve={() => {}} />)
    expect(html).toMatch(/<button[^>]*id="webinarRegisterBtn"[^>]*>Reserve my seat</)
    expect(html).not.toContain('disabled')
    expect(html).toContain('Limited to 40 seats')
  })

  it('sold-out dates are disabled in the date picker', () => {
    const html = renderToStaticMarkup(<DateChipModal heading="Offline Workshop" art={{ src: '/x.png', alt: '' }} intro={null} availability="ready" chipLabel="Choose" emptyLabel="Select" noneText="none" addLabel="Add"
      chips={[{ key: 'a', label: '7–11 Nov', small: '5 days', soldOut: true }, { key: 'b', label: '14–18 Nov', small: '5 days' }]} onRetry={() => {}} onClose={() => {}} onAdd={() => {}} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>7–11 Nov<small>Fully booked<\/small>/)
    expect(html).toMatch(/<button class="chip-date" data-idx="1">14–18 Nov<small>5 days<\/small>/)
  })
})
