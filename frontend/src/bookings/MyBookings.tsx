import { lazy, Suspense, useEffect, useState } from 'react'
import { useLoad } from '../admin/admin-hooks'
import { ApiError, api as defaultApi, type ApiClient } from '../api/client'
import { formatPrice } from '../api/format'
import type { CustomerBooking, PaymentConfig } from '../api/types'
import { useAuth } from '../auth/auth-context'
import { awaitingConfirmationText, bookingStatusLabel, bookingWhen, cancellationRequestText, EXPIRED_MESSAGE, paymentDeadlineText, simulatorAvailable } from './booking-display'

const PAGE_SIZE = 10
const formatDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

// Stage 2 development payment simulator. `import.meta.env.DEV` is false in production builds, so this
// branch (and the simulator module) is removed from them entirely.
const PaymentSimulator = import.meta.env.DEV ? lazy(() => import('./PaymentSimulator')) : null

const cancelledBy = (booking: CustomerBooking) => {
  const by = booking.cancellation?.by
  return by === 'ADMIN' ? ' by DIY Forests' : by === 'SYSTEM' ? ' automatically' : ''
}

/** One booking as the customer sees it (status, price, dates, deadline or confirmation, cancellation request). */
export function BookingSummary({ booking, now }: { booking: CustomerBooking; now?: Date }) {
  const deadline = paymentDeadlineText(booking, now)
  const awaiting = awaitingConfirmationText(booking)
  const notConfirmedInTime = booking.cancellation?.by === 'SYSTEM' && booking.cancellation.reason === 'Not confirmed in time'
  const simulated = booking.confirmation?.method !== 'MANUAL' && booking.confirmation?.simulated !== false
  return (
    <div>
      <strong>{booking.product.name}</strong> <span className="booking-ref">{booking.reference}</span>
      <p>{bookingWhen(booking.target)}</p>
      <p><span className={`booking-status is-${booking.status.toLowerCase()}`}>{bookingStatusLabel(booking)}</span> · {formatPrice(booking.price)}</p>
      {booking.status === 'CONFIRMED' && booking.confirmation && simulated ? <p><small>Confirmed {formatDate(booking.confirmation.at)}. This was a test-mode confirmation: no payment was received.</small></p> : null}
      {booking.status === 'CONFIRMED' && booking.confirmation?.method === 'MANUAL' ? <p><small>Confirmed {formatDate(booking.confirmation.at)}.</small></p> : null}
      {awaiting ? <p><small>{awaiting}</small></p> : null}
      {notConfirmedInTime ? <p><small>{EXPIRED_MESSAGE}</small></p> : null}
      {deadline ? <p><small>{deadline}</small></p> : null}
      {booking.cancellationRequest ? <p className="booking-request"><small>{cancellationRequestText(booking.cancellationRequest)}</small></p> : null}
      {booking.cancellation ? <p><small>Cancelled {formatDate(booking.cancellation.at)}{cancelledBy(booking)}{booking.cancellation.reason ? `: ${booking.cancellation.reason}` : ''}</small></p> : <p><small>Requested {formatDate(booking.createdAt)}</small></p>}
    </div>
  )
}

/** The signed-in customer's bookings, straight from GET /me/bookings (the server is the only source). */
export function MyBookings({ csrfToken, client = defaultApi }: { csrfToken: string; client?: ApiClient }) {
  const { sessionExpired } = useAuth()
  const [page, setPage] = useState(1)
  // Same loader as the admin panels: aborts stale requests, and a 401 ends the session in the UI.
  const [load, reload] = useLoad((signal) => client.listMyBookings({ page, pageSize: PAGE_SIZE }, signal), [client, page])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null)
  const [requesting, setRequesting] = useState<string | null>(null)

  useEffect(() => {
    if (!PaymentSimulator) return
    const controller = new AbortController()
    // Failure simply leaves the simulator hidden.
    client.getPaymentConfig(controller.signal).then(setPaymentConfig, () => setPaymentConfig(null))
    return () => controller.abort()
  }, [client])
  const showSimulator = simulatorAvailable(import.meta.env.DEV, paymentConfig)

  const cancel = async (booking: CustomerBooking) => {
    setBusy(booking.id)
    setNotice(null)
    try {
      const updated = await client.cancelMyBooking(csrfToken, booking.id, null)
      setNotice({ kind: 'ok', text: `Booking ${updated.reference} was cancelled and its seat released.` })
      setConfirming(null)
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.details.status === 401) return sessionExpired()
      // 404/409 carry a readable reason from the server (e.g. already cancelled, dates started).
      setNotice({ kind: 'error', text: error instanceof ApiError && (error.details.status === 404 || error.details.status === 409) ? error.message : 'Couldn’t cancel the booking. Please try again.' })
      reload()
    } finally {
      setBusy(null)
    }
  }

  const requestCancellation = async (booking: CustomerBooking) => {
    setBusy(booking.id)
    setNotice(null)
    try {
      const { request } = await client.requestCancellation(csrfToken, booking.id, null)
      setNotice({ kind: 'ok', text: `Cancellation requested for ${booking.reference}. ${cancellationRequestText(request)}` })
      setRequesting(null)
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.details.status === 401) return sessionExpired()
      setNotice({ kind: 'error', text: error instanceof ApiError && (error.details.status === 404 || error.details.status === 409) ? error.message : 'Couldn’t send the cancellation request. Please try again.' })
      reload()
    } finally {
      setBusy(null)
    }
  }

  if (load.state === 'loading') return <p aria-busy="true">Loading your bookings…</p>
  if (load.state === 'error') {
    return <><p className="auth-message is-error" role="alert">We couldn’t load your bookings.</p><div className="auth-actions"><button className="btn btn-quiet" type="button" onClick={reload}>Try again</button></div></>
  }
  const { items, meta } = load.data
  const pages = Math.max(1, Math.ceil(meta.total / meta.pageSize))
  return (
    <>
      {notice ? <p className={`auth-message${notice.kind === 'error' ? ' is-error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
      {items.length === 0 ? <p>You haven’t made any bookings yet.</p> : (
        <ul className="booking-list">
          {items.map((booking) => (
            <li key={booking.id} className={`booking-item is-${booking.status.toLowerCase()}`}>
              <BookingSummary booking={booking} />
              {booking.canCancel ? (
                confirming === booking.id ? (
                  <span className="booking-confirm" role="group" aria-label={`Cancel booking ${booking.reference}`}>
                    <button className="btn btn-small" type="button" disabled={busy !== null} onClick={() => void cancel(booking)}>{busy === booking.id ? 'Cancelling…' : 'Yes, cancel it'}</button>
                    <button className="btn btn-quiet btn-small" type="button" disabled={busy !== null} onClick={() => setConfirming(null)}>Keep</button>
                  </span>
                ) : <button className="btn btn-quiet btn-small" type="button" disabled={busy !== null} onClick={() => setConfirming(booking.id)}>Cancel booking</button>
              ) : null}
              {booking.canRequestCancellation ? (
                requesting === booking.id ? (
                  <span className="booking-confirm" role="group" aria-label={`Request cancellation of booking ${booking.reference}`}>
                    <small>Our team will review your request. Your booking stays active until then, and your refund eligibility is fixed when you send it.</small>
                    <button className="btn btn-small" type="button" disabled={busy !== null} onClick={() => void requestCancellation(booking)}>{busy === booking.id ? 'Sending…' : 'Send request'}</button>
                    <button className="btn btn-quiet btn-small" type="button" disabled={busy !== null} onClick={() => setRequesting(null)}>Keep booking</button>
                  </span>
                ) : <button className="btn btn-quiet btn-small" type="button" disabled={busy !== null} onClick={() => setRequesting(booking.id)}>Request cancellation</button>
              ) : null}
              {showSimulator && PaymentSimulator && booking.canPay ? (
                <Suspense fallback={null}>
                  <PaymentSimulator booking={booking} csrfToken={csrfToken} client={client} onSessionExpired={sessionExpired}
                    onChange={(_updated, message) => { setNotice({ kind: 'ok', text: message }); reload() }} />
                </Suspense>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav className="admin-pager" aria-label="Booking pages">
          <button className="btn btn-quiet btn-small" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button className="btn btn-quiet btn-small" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </nav>
      ) : null}
    </>
  )
}
