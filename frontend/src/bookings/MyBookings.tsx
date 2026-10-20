import { useState } from 'react'
import { useLoad } from '../admin/admin-hooks'
import { ApiError, api as defaultApi, type ApiClient } from '../api/client'
import { formatPrice } from '../api/format'
import type { CustomerBooking } from '../api/types'
import { useAuth } from '../auth/auth-context'
import { bookingStatusLabel, bookingWhen } from './booking-display'

const PAGE_SIZE = 10
const formatDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

/** The signed-in customer's bookings, straight from GET /me/bookings (the server is the only source). */
export function MyBookings({ csrfToken, client = defaultApi }: { csrfToken: string; client?: ApiClient }) {
  const { sessionExpired } = useAuth()
  const [page, setPage] = useState(1)
  // Same loader as the admin panels: aborts stale requests, and a 401 ends the session in the UI.
  const [load, reload] = useLoad((signal) => client.listMyBookings({ page, pageSize: PAGE_SIZE }, signal), [client, page])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

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
              <div>
                <strong>{booking.product.name}</strong> <span className="booking-ref">{booking.reference}</span>
                <p>{bookingWhen(booking.target)}</p>
                <p><span className={`booking-status is-${booking.status.toLowerCase()}`}>{bookingStatusLabel(booking)}</span> · {formatPrice(booking.price)}</p>
                {booking.cancellation ? <p><small>Cancelled {formatDate(booking.cancellation.at)}{booking.cancellation.by === 'ADMIN' ? ' by DIY Forests' : ''}{booking.cancellation.reason ? `: ${booking.cancellation.reason}` : ''}</small></p> : <p><small>Requested {formatDate(booking.createdAt)}</small></p>}
              </div>
              {booking.canCancel ? (
                confirming === booking.id ? (
                  <span className="booking-confirm" role="group" aria-label={`Cancel booking ${booking.reference}`}>
                    <button className="btn btn-small" type="button" disabled={busy !== null} onClick={() => void cancel(booking)}>{busy === booking.id ? 'Cancelling…' : 'Yes, cancel it'}</button>
                    <button className="btn btn-quiet btn-small" type="button" disabled={busy !== null} onClick={() => setConfirming(null)}>Keep</button>
                  </span>
                ) : <button className="btn btn-quiet btn-small" type="button" disabled={busy !== null} onClick={() => setConfirming(booking.id)}>Cancel booking</button>
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
