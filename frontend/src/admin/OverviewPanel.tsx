import type { AdminApi } from './admin-api'
import { formatIst } from './admin-time'
import { useLoad } from './admin-hooks'
import { LoadState } from './ui'

const TYPES = [
  { key: 'WEBINAR', label: 'Webinars' },
  { key: 'OFFLINE_WORKSHOP', label: 'Offline workshop batches' },
  { key: 'ONLINE_TRAINING', label: 'Online training (2-Friday cohorts)' },
] as const

/** Real figures from PostgreSQL only. Booking-based numbers arrive with bookings in Stage 4C. */
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
          <p className="admin-footnote">Seats taken and “nearly full” alerts need bookings, which arrive in a later stage. Capacities set here are limits only.</p>
        </>
      )}
    </LoadState>
  )
}
