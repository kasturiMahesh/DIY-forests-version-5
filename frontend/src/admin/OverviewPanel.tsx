import type { AdminApi } from './admin-api'
import { formatIst } from './admin-time'
import { useLoad } from './admin-hooks'
import { LoadState } from './ui'

const TYPES = [
  { key: 'WEBINAR', label: 'Webinars' },
  { key: 'OFFLINE_WORKSHOP', label: 'Offline workshop batches' },
  { key: 'ONLINE_TRAINING', label: 'Online training (2-Friday cohorts)' },
] as const

/** Real figures from PostgreSQL only. */
export function OverviewPanel({ api }: { api: AdminApi }) {
  const [load, retry] = useLoad((signal) => api.dashboard(signal), [api])
  return (
    <LoadState load={load} retry={retry}>
      {(data) => (
        <>
          <div className="admin-grid">
            <div className="admin-tile is-live">
              <h3>Products</h3>
              <p><strong>{data.products.active}</strong> active · {data.products.inactive} inactive</p>
            </div>
            <div className="admin-tile is-live">
              <h3>Bookings</h3>
              <p><strong>{data.bookings.awaitingConfirmation ?? 0}</strong> awaiting confirmation · {data.bookings.pendingPayment} pending payment · {data.bookings.cancelled} cancelled{data.bookings.expired ? ` (${data.bookings.expired} expired)` : ''}</p>
            </div>
            <div className="admin-tile is-live">
              <h3>Manual confirmations</h3>
              <p><strong>{data.bookings.confirmedManual?.total ?? 0}</strong> confirmed by staff</p>
              {data.bookings.confirmedManual ? <p>{data.bookings.confirmedManual.PAYMENT_ARRANGED_OFFLINE} payment arranged offline · {data.bookings.confirmedManual.COMPLIMENTARY} complimentary · {data.bookings.confirmedManual.OTHER} other</p> : null}
              <p className="admin-empty">Not proof of payment. Not revenue.</p>
            </div>
            <div className="admin-tile is-live">
              <h3>Cancellation requests</h3>
              <p><strong>{data.bookings.cancellationRequests?.pending ?? 0}</strong> awaiting review · {data.bookings.cancellationRequests?.approved ?? 0} approved · {data.bookings.cancellationRequests?.rejected ?? 0} rejected</p>
              <p className="admin-empty">Eligibility only: no refunds are processed by the website.</p>
            </div>
            <div className="admin-tile is-live">
              <h3>Simulated confirmations</h3>
              <p><strong>{data.bookings.confirmedSimulated ?? 0}</strong> confirmed by the development simulator</p>
              <p className="admin-empty">Test mode only — no money received. Not revenue.</p>
            </div>
            <div className="admin-tile is-live">
              <h3>Cancelled (upcoming)</h3>
              <p><strong>{data.cancelledUpcoming}</strong> kept for the record, hidden from the website</p>
            </div>
            {TYPES.map(({ key, label }) => {
              const stats = data.upcoming[key]
              return (
                <div className="admin-tile is-live" key={key}>
                  <h3>{label}</h3>
                  <p><strong>{stats.published}</strong> upcoming published · {stats.draft} draft</p>
                  {stats.next.length ? (
                    <ul className="admin-next">{stats.next.map((next) => <li key={next.id}>{formatIst(next.startsAt)} · {next.productName}</li>)}</ul>
                  ) : <p className="admin-empty">No upcoming published dates.</p>}
                </div>
              )
            })}
          </div>
          <p className="admin-footnote">Online payment isn’t connected, so there is no revenue figure and paid bookings stay at {data.bookings.confirmedPaid ?? 0}. Awaiting, pending and confirmed bookings each hold one seat; unconfirmed requests are released at their deadline. Seats held are shown next to each capacity.</p>
        </>
      )}
    </LoadState>
  )
}
