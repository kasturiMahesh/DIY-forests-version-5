import { useState, type FormEvent } from 'react'
import { formatPrice } from '../api/format'
import type { AdminBooking, BookingStatus } from '../api/types'
import { bookingStatusLabel, bookingWhen } from '../bookings/booking-display'
import type { AdminApi } from './admin-api'
import { useAction, useLoad } from './admin-hooks'
import { formatIst } from './admin-time'
import { ConfirmAction, LoadState, Notice, Pager } from './ui'

/**
 * Stage 4C bookings. Everything shown comes from /admin/bookings. Phone numbers are fetched only when
 * an admin opens one booking (the list never includes them). No payment exists, so there is no
 * "mark as paid" action: bookings are pending payment until cancelled.
 */
export function BookingsPanel({ api }: { api: AdminApi }) {
  const [filter, setFilter] = useState<{ status: '' | BookingStatus; q: string; page: number }>({ status: '', q: '', page: 1 })
  const [search, setSearch] = useState('')
  const [load, reload] = useLoad((signal) => api.listBookings({ ...(filter.status ? { status: filter.status } : {}), ...(filter.q ? { q: filter.q } : {}), page: filter.page, pageSize: 20 }, signal), [api, filter])
  const [openId, setOpenId] = useState<string | null>(null)
  const action = useAction()

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    setFilter({ ...filter, q: search.trim().length >= 2 ? search.trim() : '', page: 1 })
  }

  return (
    <section aria-labelledby="bookings-heading">
      <div className="admin-toolbar">
        <h2 id="bookings-heading">Bookings</h2>
        <label>Status
          <select value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as '' | BookingStatus, page: 1 })}>
            <option value="">All</option><option value="PENDING_PAYMENT">Pending payment</option><option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <form onSubmit={submitSearch} role="search">
          <label>Reference or email <input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></label>
          <button className="btn btn-quiet btn-small" type="submit">Search</button>
        </form>
      </div>
      <p className="admin-footnote">Online payment isn’t connected yet, so every active booking is <strong>pending payment</strong> and holds one seat. Cancelling releases the seat; customers see your reason.</p>
      <Notice notice={action.notice} />
      <LoadState load={load} retry={reload} empty={(data) => data.items.length === 0}>
        {(data) => (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th scope="col">Reference</th><th scope="col">Customer</th><th scope="col">Offering</th><th scope="col">Price</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {data.items.map((booking) => (
                    <tr key={booking.id}>
                      <td>{booking.reference}<br /><small>{formatIst(booking.createdAt)}</small></td>
                      <td>{booking.contactName}<br /><small>{booking.customer.email}</small></td>
                      <td>{booking.product.name}<br /><small>{bookingWhen(booking.target)}</small></td>
                      <td>{formatPrice(booking.price)}</td>
                      <td><span className={`admin-badge is-${booking.status === 'CANCELLED' ? 'cancelled' : 'draft'}`}>{booking.status === 'CANCELLED' ? 'Cancelled' : 'Pending payment'}</span>
                        {booking.cancellation ? <><br /><small>by {booking.cancellation.by === 'ADMIN' ? 'admin' : 'customer'}{booking.cancellation.reason ? `: ${booking.cancellation.reason}` : ''}</small></> : null}
                      </td>
                      <td className="admin-actions">
                        <button className="btn btn-quiet btn-small" type="button" onClick={() => setOpenId(openId === booking.id ? null : booking.id)}>{openId === booking.id ? 'Hide' : 'Details'}</button>
                        {booking.canCancel ? (
                          <ConfirmAction label="Cancel" confirmLabel={`Cancel booking ${booking.reference}`} withReason="required" disabled={action.pending}
                            onConfirm={(reason) => action.run(() => api.cancelBooking(booking.id, reason ?? ''), `Booking ${booking.reference} cancelled; its seat is released.`).then(reload)} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {openId ? <BookingDetail key={openId} api={api} id={openId} /> : null}
            <Pager meta={data.meta} onPage={(page) => setFilter({ ...filter, page })} />
          </>
        )}
      </LoadState>
    </section>
  )
}

function BookingDetail({ api, id }: { api: AdminApi; id: string }) {
  const [load, retry] = useLoad((signal) => api.getBooking(id, signal), [api, id])
  return (
    <LoadState load={load} retry={retry}>
      {(booking: AdminBooking) => (
        <div className="admin-tile is-live" aria-label={`Booking ${booking.reference}`}>
          <h3>{booking.reference} · {booking.product.name}</h3>
          <p>{bookingWhen(booking.target)}</p>
          <p>{bookingStatusLabel(booking)} · {formatPrice(booking.price)} (price when booked)</p>
          <p>Contact: {booking.contact.name} · <a href={`tel:${booking.contact.phone.e164}`}>{booking.contact.phone.e164}</a> · {booking.customer.email}</p>
        </div>
      )}
    </LoadState>
  )
}
