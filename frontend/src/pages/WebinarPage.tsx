import { useEffect, useState } from 'react'
import { formatPrice, formatSessionDateTime, staticMoney } from '../api/format'
import { priceFor, useCatalog, type CatalogState } from '../catalog/catalog-context'
import { Countdown } from '../catalog/Countdown'
import webinarCss from '../styles/webinar.css?inline'
import { webinar, webinarResourceCards } from '../webinarData'

const RESERVE_URL = '/?reserve=webinar#webinar'
const DISMISS_KEY = 'diy-webinar-booking-dismissed'
// Same look as the home page's disabled .btn-primary (opacity .75, not-allowed cursor).
const unavailableButton = { opacity: 0.75, cursor: 'not-allowed' } as const

/** Reserve link while a published session exists; otherwise a retry or a non-interactive placeholder. */
function ReserveAction({ catalog, label }: { catalog: CatalogState; label: string }) {
  if (catalog.status === 'error') return <button className="btn" type="button" onClick={catalog.retry}>Try again</button>
  if (catalog.status === 'ready' && catalog.nextWebinar) return <a className="btn" data-reserve-webinar href={RESERVE_URL}>{label}</a>
  return <span className="btn" aria-disabled="true" style={unavailableButton}>{catalog.status === 'loading' ? label : 'Dates coming soon'}</span>
}

export default function WebinarPage() {
  const catalog = useCatalog()
  const session = catalog.status === 'ready' ? catalog.nextWebinar : null
  const dateLabel = session
    ? formatSessionDateTime(session.startsAt) // the one real instant, in the visitor's own time zone
    : { loading: 'Loading webinar date', error: 'Schedule unavailable', ready: 'Date to be announced' }[catalog.status]
  const priceLabel = formatPrice(session?.product.price ?? priceFor(catalog, 'monthly-webinar', staticMoney(webinar.price, 'INR')))
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === 'true' } catch { return false }
  })
  const [stickyVisible, setStickyVisible] = useState(false)

  useEffect(() => { document.title = 'Monthly Webinar — DIY Forests' }, [])

  useEffect(() => {
    const updateSticky = () => {
      const threshold = document.documentElement.scrollHeight * 0.18
      // The booking bar only appears when there is a real session to reserve.
      setStickyVisible(!dismissed && session !== null && window.scrollY > 0 && window.scrollY + window.innerHeight >= threshold)
    }
    window.addEventListener('scroll', updateSticky, { passive: true })
    return () => window.removeEventListener('scroll', updateSticky)
  }, [dismissed, session])

  return (
    <>
      <style>{webinarCss}</style>
      <header className="site-header">
        <div className="wrap header-inner">
          <a className="brand" href="/#top" aria-label="DIY Forests home">
            <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="var(--forest)" /><path d="M20 30V19M20 19C15 19 12 15 12 10C17 10 20 13 20 17C20 13 23 10 28 10C28 15 25 19 20 19Z" stroke="var(--on-forest)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></svg>
            <span>DIY Forests</span>
          </a>
          <a className="btn header-return" href="/#top" aria-label="Back to the main DIY Forests website">Back to Main Website</a>
        </div>
      </header>
      <main>
        <section className="webinar-hero">
          <div className="wrap hero-grid">
            <div className="hero-copy-wrap">
              <span className="eyebrow">DIY Forests · Live online</span>
              <h1>Learn to Grow a Forest</h1>
              <p className="hero-subheading">A simple introduction to growing native forests.</p>
              <p className="hero-copy">Explore the basics of the Miyawaki Method through practical examples before joining our live Q&amp;A webinar.</p>
              <div className="event-meta"><span id="heroWebinarDate">{dateLabel}</span><span id="heroWebinarFormat">{webinar.format}</span><span id="heroWebinarPrice">{priceLabel}</span></div>
              {session ? (
                <Countdown target={session.startsAt} id="heroCountdown" containerClass="countdown" itemClass="countdown-item" statusClass="countdown-status" />
              ) : catalog.status === 'loading' ? null : (
                <div className="countdown-status" id="heroCountdown" role={catalog.status === 'error' ? 'alert' : undefined}>
                  {catalog.status === 'error' ? 'We couldn’t load the webinar schedule.' : 'The next webinar date hasn’t been announced yet.'}
                </div>
              )}
              <ReserveAction catalog={catalog} label={`Reserve My Seat — ${priceLabel}`} />
            </div>
            <div className="hero-image"><iframe src="https://www.youtube.com/embed/8xEZv7Pbes0?controls=1" title="Learn the Miyawaki Method — Monthly Webinar" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen /></div>
          </div>
        </section>

        <section className="section" aria-labelledby="preview-heading">
          <div className="wrap">
            <div className="section-heading">
              <span className="section-kicker">Sample learning resources</span>
              <h2 id="preview-heading">A preview of what you&apos;ll learn</h2>
              <p>Explore a few simple concepts from the Miyawaki Method before joining the live session.</p>
            </div>
            <div className="resource-grid" id="resourceGrid">
              {webinarResourceCards.map((card) => (
                <article className="resource-card" key={card.title}>
                  <div className="resource-image"><img src={card.image} alt={card.alt} loading="lazy" decoding="async" /></div>
                  <div className="resource-copy"><span className="resource-label">{card.label}</span><h3>{card.title}</h3><p>{card.description}</p></div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="qa-section" aria-labelledby="qa-heading">
          <div className="wrap qa-inner">
            <div className="qa-copy">
              <span className="section-kicker">Live Q&amp;A</span>
              <h2 id="qa-heading">Still have questions?</h2>
              <p>Join the live Q&amp;A and ask your questions about the Miyawaki Method, forest creation, training options, or how to get started.</p>
            </div>
            <div className="qa-details">
              <div><strong id="qaWebinarDate">{dateLabel}</strong><br /><span id="qaWebinarFormat">{webinar.format}</span></div>
              <span className="qa-price" id="qaWebinarPrice">{priceLabel}</span>
              <ReserveAction catalog={catalog} label="Reserve My Seat" />
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <div className="wrap footer-inner">
          <span>DIY Forests · A live introduction to the Miyawaki Method</span>
          <a href="/">Return to DIY Forests</a>
        </div>
      </footer>
      <aside className={`sticky-booking${stickyVisible ? ' is-visible' : ''}`} id="stickyBooking" aria-label="Reserve a webinar seat" aria-hidden={stickyVisible ? 'false' : 'true'} inert={!stickyVisible}>
        <div className="sticky-info">
          <span className="sticky-label" id="stickyWebinarDate">LIVE Q&amp;A · {dateLabel}</span>
          <span className="sticky-question">Have questions about the Miyawaki Method?</span>
        </div>
        <div className="sticky-action">
          <span className="sticky-price" id="stickyWebinarPrice">{priceLabel}</span>
          <ReserveAction catalog={catalog} label="Reserve My Seat" />
        </div>
        <button className="sticky-close" id="closeStickyBooking" type="button" aria-label="Close webinar booking bar" onClick={() => {
          setDismissed(true)
          setStickyVisible(false)
          try { sessionStorage.setItem(DISMISS_KEY, 'true') } catch { /* storage unavailable */ }
        }}>×</button>
      </aside>
    </>
  )
}
