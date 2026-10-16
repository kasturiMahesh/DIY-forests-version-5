// Loading / empty / error / published states, rendered to HTML (no browser needed).
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { PublicSession } from '../api/types'
import WebinarPage from '../pages/WebinarPage'
import { CatalogContext, type CatalogState } from './catalog-context'
import { WebinarBanner } from './WebinarBanner'

const DAY = 86_400_000
const upcoming: PublicSession = {
  id: '0199a000-0000-7000-8000-000000000002',
  startsAt: new Date(Date.now() + 3 * DAY).toISOString(),
  endsAt: null,
  timezone: 'Asia/Kolkata',
  capacity: 40,
  product: { id: 'p', slug: 'monthly-webinar', name: 'Monthly Webinar', type: 'WEBINAR', price: { amount: '149.00', currency: 'INR' } },
}
const state = (overrides: Partial<CatalogState>): CatalogState => ({ status: 'loading', products: [], nextWebinar: null, retry: () => {}, ...overrides })
const fallback = { amount: '149.00', currency: 'INR' }

const banner = (catalog: CatalogState) => renderToStaticMarkup(<WebinarBanner catalog={catalog} price={fallback} onReserve={() => {}} />)
const page = (catalog: CatalogState) =>
  renderToStaticMarkup(<MemoryRouter><CatalogContext.Provider value={catalog}><WebinarPage /></CatalogContext.Provider></MemoryRouter>)

describe('home page webinar banner', () => {
  it('loading: placeholder heading, nothing bookable', () => {
    const html = banner(state({ status: 'loading' }))
    expect(html).toContain('Loading…')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reserve my seat</)
    expect(html).not.toContain('webinar-countdown-item')
  })

  it('empty: no invented date, no countdown, disabled button', () => {
    const html = banner(state({ status: 'ready', nextWebinar: null }))
    expect(html).toContain('Next date to be announced')
    expect(html).toContain('No upcoming webinar is scheduled yet.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Dates coming soon</)
    expect(html).not.toMatch(/13 Oct|seat-bar|Only \d+ of/)
  })

  it('error: recoverable with a Try again button', () => {
    const html = banner(state({ status: 'error' }))
    expect(html).toContain('Schedule unavailable')
    expect(html).toContain('role="alert"')
    expect(html).toMatch(/<button[^>]*id="webinarRegisterBtn"[^>]*>Try again</)
    expect(html).not.toMatch(/disabled/)
  })

  it('published session: real date, countdown, capacity, enabled button, API price', () => {
    const html = banner(state({ status: 'ready', nextWebinar: upcoming }))
    expect(html).toContain('webinar-countdown-item')
    expect(html).toContain('Limited to 40 seats')
    expect(html).toMatch(/<button[^>]*id="webinarRegisterBtn"[^>]*>Reserve my seat</)
    expect(html).not.toMatch(/disabled/)
    expect(html).toContain('₹149')
    expect(html).not.toContain('seat-bar') // the fake seats-left bar is gone
  })
})

describe('webinar page', () => {
  it('loading: placeholder date, no reserve link', () => {
    const html = page(state({ status: 'loading' }))
    expect(html).toContain('Loading webinar date')
    expect(html).not.toContain('href="/?reserve=webinar#webinar"')
  })

  it('empty: says no date is announced and offers no reservation', () => {
    const html = page(state({ status: 'ready', nextWebinar: null }))
    expect(html).toContain('Date to be announced')
    expect(html).toContain('The next webinar date hasn’t been announced yet.')
    expect(html).toContain('Dates coming soon')
    expect(html).not.toContain('href="/?reserve=webinar#webinar"')
  })

  it('error: explains and offers retry', () => {
    const html = page(state({ status: 'error' }))
    expect(html).toContain('We couldn’t load the webinar schedule.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('href="/?reserve=webinar#webinar"')
  })

  it('published session: reserve links, countdown and price come from the API', () => {
    const html = page(state({ status: 'ready', nextWebinar: upcoming, products: [] }))
    expect(html.match(/href="\/\?reserve=webinar#webinar"/g)).toHaveLength(3) // hero, Q&A, sticky bar
    expect(html).toContain('countdown-item')
    expect(html).toContain('Reserve My Seat — ₹149')
    expect(html).not.toMatch(/Loading webinar date|Date to be announced/)
  })
})
