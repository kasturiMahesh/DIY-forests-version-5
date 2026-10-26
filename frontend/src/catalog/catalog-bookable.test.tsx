// Stage 3F: the website asks the server only for bookable dates (bookings close 24 hours before the
// start), so the webinar banner shows the next bookable webinar. Fake fetch; no backend involved.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../api/client'
import type { PublicSession } from '../api/types'
import { CatalogContext, type CatalogState } from './catalog-context'
import { loadCatalog } from './CatalogContext'
import { WebinarBanner } from './WebinarBanner'

const webinar = (id: string, startsAt: string): PublicSession => ({
  id, startsAt, endsAt: null, timezone: 'Asia/Kolkata', capacity: 40, seatsAvailable: 10,
  product: { id: 'p', slug: 'monthly-webinar', name: 'Monthly Webinar', type: 'WEBINAR', price: { amount: '149.00', currency: 'INR' } },
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const meta = (count: number) => ({ from: '2031-03-03T06:00:00.000Z', limit: 1, count })

/** A fake API: records every URL and answers like the server would for each catalog call. */
function fakeClient(bookableWebinars: PublicSession[]) {
  const urls: string[] = []
  const client = createApiClient({
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/products')) return json({ data: [] })
      if (url.includes('/cohorts')) return json({ data: [] })
      if (url.includes('type=WEBINAR')) return json({ data: bookableWebinars, meta: meta(bookableWebinars.length) })
      return json({ data: [], meta: meta(0) })
    }) as typeof fetch,
  })
  return { client, urls }
}

describe('loadCatalog', () => {
  it('requests bookable dates only, for webinars, workshops and training cohorts', async () => {
    const { client, urls } = fakeClient([])
    await loadCatalog(client, new AbortController().signal)
    const catalogCalls = urls.filter((url) => /\/(sessions|cohorts)\?/.test(url))
    expect(catalogCalls).toHaveLength(3)
    for (const url of catalogCalls) expect(new URL(url, 'http://x').searchParams.get('bookable')).toBe('true')
  })

  it('the banner shows the next bookable webinar the server returns', async () => {
    const next = webinar('0199a000-0000-7000-8000-0000000000aa', '2031-03-04T13:00:00.000Z')
    const { client } = fakeClient([next])
    const loaded = await loadCatalog(client, new AbortController().signal)
    expect(loaded.nextWebinar?.id).toBe(next.id)
    const html = renderToStaticMarkup(<CatalogContext.Provider value={{ ...loaded, retry: () => {} } as CatalogState}><WebinarBanner catalog={{ ...loaded, retry: () => {} }} price={{ amount: '149.00', currency: 'INR' }} onReserve={() => {}} /></CatalogContext.Provider>)
    expect(html).toMatch(/<button[^>]*>Reserve my seat</)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reserve my seat</)
    expect(html).not.toContain('Next date to be announced')
  })

  it('no bookable webinar: nextWebinar is null and the banner renders its empty state without crashing', async () => {
    const { client } = fakeClient([])
    const loaded = await loadCatalog(client, new AbortController().signal)
    expect(loaded).toMatchObject({ status: 'ready', nextWebinar: null })
    const html = renderToStaticMarkup(<WebinarBanner catalog={{ ...loaded, retry: () => {} }} price={{ amount: '149.00', currency: 'INR' }} onReserve={() => {}} />)
    // The existing empty state: no date, no countdown, a disabled button.
    expect(html).toContain('Next date to be announced')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Dates coming soon</)
    expect(html).not.toContain('webinar-countdown')
  })
})
