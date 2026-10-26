import { ApiError, type ApiClient } from '../api/client'
import type { BookingRequest, CustomerBooking } from '../api/types'

export type CheckoutItem = { cartId: string; title: string; booking: Pick<BookingRequest, 'productId' | 'sessionId' | 'cohortId'>; bookingKey: string }

/** One booking request's outcome: only `ok` results carry a booking the server actually created. */
export type CheckoutResult = { cartId: string; title: string } & ({ ok: true; booking: CustomerBooking } | { ok: false; message: string })

export type CheckoutOutcome =
  /** The session ended: nothing more was sent. Already-created bookings are replayed safely on retry (same keys). */
  | { kind: 'expired' }
  /** The contact details were rejected before anything was booked (the same details go with every item). */
  | { kind: 'field-error'; message: string }
  /** `rotateKeys`: items whose key the server had already seen for a different booking. */
  | { kind: 'done'; results: CheckoutResult[]; rotateKeys: string[] }

const FIELD_ERRORS = new Set(['PHONE_INVALID', 'PHONE_COUNTRY_UNSUPPORTED', 'INVALID_REQUEST'])

/** The server's contact-name rule (booking.schemas.ts): letters and marks first, then letters, marks, spaces and . ' ’ - */
const CONTACT_NAME = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u

/**
 * A suggested "Full name" for checkout, from the account's display name. Parenthesised notes such as
 * "(DEV)" and characters the server would reject are dropped; if nothing valid is left the field starts
 * empty. Only a suggestion: the customer can edit it, and the server still validates what is sent.
 */
export function suggestedContactName(displayName: string | null | undefined): string {
  const cleaned = (displayName ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{M}\s.'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{M}]+/u, '')
    .slice(0, 100)
    .trim()
  return CONTACT_NAME.test(cleaned) ? cleaned : ''
}
export const UNCONFIRMED_MESSAGE = 'We couldn’t confirm this booking. Please try again; it won’t be booked twice.'

/**
 * Sends one booking request per item, one after another, each with the item's own idempotency key.
 * Results mirror exactly what the server answered; a network failure is never reported as a booking.
 */
export async function requestBookings(
  client: Pick<ApiClient, 'createBooking'>,
  csrfToken: string,
  items: CheckoutItem[],
  contact: { contactName: string; phone: { country: string; number: string } },
): Promise<CheckoutOutcome> {
  const results: CheckoutResult[] = []
  const rotateKeys: string[] = []
  for (const item of items) {
    try {
      // Explicit fields only: the cart comes from localStorage, so nothing else it may contain is sent.
      const { productId, sessionId, cohortId } = item.booking
      const target = sessionId !== undefined ? { sessionId } : cohortId !== undefined ? { cohortId } : {}
      const { booking } = await client.createBooking(csrfToken, { productId, ...target, contactName: contact.contactName, phone: { country: contact.phone.country, number: contact.phone.number } }, item.bookingKey)
      results.push({ cartId: item.cartId, title: item.title, ok: true, booking })
    } catch (error) {
      if (error instanceof ApiError && error.details.status === 401) return { kind: 'expired' }
      if (error instanceof ApiError && error.details.status === 400 && FIELD_ERRORS.has(error.details.code ?? '') && results.length === 0) {
        return { kind: 'field-error', message: error.message }
      }
      if (error instanceof ApiError && error.details.code === 'IDEMPOTENCY_KEY_REUSED') rotateKeys.push(item.cartId)
      // 4xx answers carry the server's readable reason (sold out, already booked, dates closed …).
      const message = error instanceof ApiError && error.kind === 'http' && error.details.status !== undefined && error.details.status < 500 ? error.message : UNCONFIRMED_MESSAGE
      results.push({ cartId: item.cartId, title: item.title, ok: false, message })
    }
  }
  return { kind: 'done', results, rotateKeys }
}
