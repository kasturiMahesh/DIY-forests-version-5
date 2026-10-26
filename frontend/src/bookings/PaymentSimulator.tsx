import { useState } from 'react'
import { ApiError, newIdempotencyKey, type ApiClient } from '../api/client'
import { formatPrice } from '../api/format'
import type { CustomerBooking } from '../api/types'
import { createSimulatorApi } from './simulator-api'

// DEVELOPMENT-ONLY payment simulator. MyBookings loads this module only when the build is a Vite dev
// build (import.meta.env.DEV) AND the server reports its simulator enabled, so production bundles
// never contain it. It never asks for card numbers, CVVs or bank details, and nothing it does moves money.

const ATTEMPT_WORDS = { CREATED: 'in progress', SUCCEEDED: 'succeeded (simulated)', FAILED: 'failed (simulated)', CANCELLED: 'cancelled' } as const

export default function PaymentSimulator({ booking, csrfToken, client, onChange, onSessionExpired }: {
  booking: CustomerBooking; csrfToken: string; client: ApiClient
  onChange: (booking: CustomerBooking, message: string) => void
  onSessionExpired: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One key per "start" click, reused for its retries, so a double submit never creates two attempts.
  const [startKey, setStartKey] = useState(newIdempotencyKey)
  const simulator = createSimulatorApi(client)
  const openAttemptId = booking.payment?.openAttemptId ?? null
  const latest = booking.payment?.attempts[0]

  const act = async (work: () => Promise<{ booking: CustomerBooking }>, message: string, rotateKey = false) => {
    setBusy(true)
    setError(null)
    try {
      const result = await work()
      if (rotateKey) setStartKey(newIdempotencyKey())
      onChange(result.booking, message)
    } catch (failure) {
      if (failure instanceof ApiError && failure.details.status === 401) return onSessionExpired()
      setError(failure instanceof ApiError && failure.kind === 'http' ? failure.message : 'The simulator request did not complete. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="payment-simulator" role="group" aria-label={`Payment simulator for booking ${booking.reference}`}>
      <p className="payment-simulator-banner"><strong>Test mode — development payment simulator.</strong> No real payment is taken or received, and no card or bank details are ever requested.</p>
      {latest ? <p><small>Last simulated attempt: {ATTEMPT_WORDS[latest.status]} · {formatPrice(latest.amount)}</small></p> : null}
      {openAttemptId ? (
        <span className="booking-confirm">
          <button className="btn btn-small" type="button" disabled={busy} onClick={() => void act(() => simulator.simulatePayment(csrfToken, booking.id, openAttemptId, 'SUCCEEDED'), `${booking.reference}: confirmed — simulated payment, no money received.`)}>Simulate success</button>
          <button className="btn btn-quiet btn-small" type="button" disabled={busy} onClick={() => void act(() => simulator.simulatePayment(csrfToken, booking.id, openAttemptId, 'FAILED'), `${booking.reference}: simulated payment failed. Your seat is still held until the deadline.`)}>Simulate failure</button>
          <button className="btn btn-quiet btn-small" type="button" disabled={busy} onClick={() => void act(() => simulator.cancelPaymentAttempt(csrfToken, booking.id, openAttemptId), `${booking.reference}: payment attempt cancelled. The booking and its seat are kept.`)}>Cancel payment</button>
        </span>
      ) : (
        <button className="btn btn-small" type="button" disabled={busy} onClick={() => void act(() => simulator.startPayment(csrfToken, booking.id, startKey), `${booking.reference}: simulated payment started.`, true)}>
          {busy ? 'Starting…' : 'Start simulated payment'}
        </button>
      )}
      {error ? <p className="auth-message is-error" role="alert">{error}</p> : null}
    </div>
  )
}
