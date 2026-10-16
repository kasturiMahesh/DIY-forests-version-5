import { formatPrice, formatSessionDateTime } from '../api/format'
import type { Money, PublicSession } from '../api/types'
import type { CatalogState } from './catalog-context'
import { Countdown } from './Countdown'

const statusStyle = { fontSize: '.8rem', fontWeight: 600, color: 'var(--ochre)' } as const

/**
 * Home page "Monthly webinar" banner. Same markup and classes as before; the date, countdown
 * and button now come from the catalog API. Nothing is shown as bookable unless a PUBLISHED
 * upcoming session exists. The old "Only 12 of 40 seats left" bar was a browser-only
 * placeholder, so it is gone; capacity is shown only when the session defines one.
 */
export function WebinarBanner({ catalog, price, onReserve }: { catalog: CatalogState; price: Money; onReserve: (session: PublicSession) => void }) {
  const session = catalog.status === 'ready' ? catalog.nextWebinar : null

  let heading: string
  let status: string | null = null
  if (catalog.status === 'loading') heading = 'Loading…'
  else if (catalog.status === 'error') {
    heading = 'Schedule unavailable'
    status = 'We couldn’t load the webinar schedule. Please try again.'
  } else if (!session) {
    heading = 'Next date to be announced'
    status = 'No upcoming webinar is scheduled yet.'
  } else {
    heading = formatSessionDateTime(session.startsAt)
    status = session.capacity ? `Limited to ${session.capacity} seats` : null
  }

  return (
    <div className="webinar-banner">
      <a className="webinar-details-link" href="/monthly-webinar" aria-label="Learn more about the Monthly Webinar">
        <div className="webinar-icon"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="var(--on-forest)" strokeWidth="1.8" /><path d="M3 10h18M8 3v4M16 3v4" stroke="var(--on-forest)" strokeWidth="1.8" strokeLinecap="round" /></svg></div>
        <div className="webinar-mid">
          <span className="live-tag"><span className="pulse-dot" />NEXT WEBINAR</span>
          <h3 id="webinarDateLine">{heading}</h3>
          <p style={{ marginBottom: '.3em' }}>An open Q&amp;A introduction to the Miyawaki Method — great if you&apos;re not sure which training to start with.</p>
          {session ? <Countdown target={session.startsAt} id="homeWebinarCountdown" containerClass="webinar-countdown" itemClass="webinar-countdown-item" statusClass="webinar-countdown-status" /> : null}
          <span id="seatsLeftText" role={catalog.status === 'error' ? 'alert' : undefined} style={statusStyle}>{status}</span>
        </div>
      </a>
      <div className="webinar-right">
        <span className="price" id="homeWebinarPrice">{formatPrice(session?.product.price ?? price)}</span>
        {catalog.status === 'error' ? (
          <button className="btn btn-primary" id="webinarRegisterBtn" onClick={catalog.retry}>Try again</button>
        ) : (
          <button className="btn btn-primary" id="webinarRegisterBtn" disabled={!session} onClick={() => { if (session) onReserve(session) }}>
            {catalog.status === 'ready' && !session ? 'Dates coming soon' : 'Reserve my seat'}
          </button>
        )}
      </div>
    </div>
  )
}
