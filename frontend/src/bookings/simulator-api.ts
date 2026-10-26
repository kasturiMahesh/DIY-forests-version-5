import { ApiError, isCustomerBooking, isPaymentAttempt, type ApiClient } from '../api/client'
import type { CustomerBooking, PaymentAttempt } from '../api/types'

// DEVELOPMENT payment simulator calls. Imported only by PaymentSimulator.tsx, which MyBookings loads
// only in Vite dev builds, so production bundles contain neither the controls nor these requests.
// Only an outcome is ever sent: never an amount, card number, CVV or bank detail.

export type AttemptResult = { attempt: PaymentAttempt; booking: CustomerBooking }

const isAttemptResult = (value: unknown): value is AttemptResult =>
  typeof value === 'object' && value !== null && isPaymentAttempt((value as Record<string, unknown>).attempt) && isCustomerBooking((value as Record<string, unknown>).booking)

function expectResult(body: unknown): AttemptResult {
  const data = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).data : undefined
  if (isAttemptResult(data)) return data
  throw new ApiError('invalid-response', 'The server sent an unexpected response.')
}

export function createSimulatorApi(client: ApiClient) {
  const base = (bookingId: string) => `/me/bookings/${encodeURIComponent(bookingId)}/payment-attempts`
  return {
    /** Starts a simulated payment attempt (reuse the key to retry safely). */
    startPayment: async (csrfToken: string, bookingId: string, idempotencyKey: string) =>
      expectResult(await client.send(base(bookingId), { method: 'POST', csrfToken, body: {}, headers: { 'Idempotency-Key': idempotencyKey } })),
    /** Chooses the fake outcome of an open attempt. */
    simulatePayment: async (csrfToken: string, bookingId: string, attemptId: string, outcome: 'SUCCEEDED' | 'FAILED') =>
      expectResult(await client.send(`${base(bookingId)}/${encodeURIComponent(attemptId)}/simulate`, { method: 'POST', csrfToken, body: { outcome } })),
    /** Cancels the payment attempt only; the booking stays pending and keeps its seat. */
    cancelPaymentAttempt: async (csrfToken: string, bookingId: string, attemptId: string) =>
      expectResult(await client.send(`${base(bookingId)}/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST', csrfToken, body: {} })),
  }
}
