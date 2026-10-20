import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../api/client'
import { calendarDaysInclusive, formatDateRange, formatDayMonth } from '../api/format'
import type { AdminCohort, AdminSession } from '../api/types'
import { DateChipModal } from '../pages/HomePage'
import { createAdminApi } from './admin-api'
import { planCohort, validateProductDraft, validateSessionDraft } from './admin-rules'
import { addDaysToIstLocal, formatIst, instantToIstLocal, istLocalToInstant, istLocalWeekday } from './admin-time'
import { CohortEditor } from './CohortsPanel'
import { ProductEditor } from './ProductsPanel'
import { SessionEditor } from './SessionsPanel'

/** The next Friday (IST wall-clock date) at least `weeks` weeks ahead, as "YYYY-MM-DD". */
function futureFriday(weeks: number): string {
  const ist = new Date(Date.now() + 5.5 * 3_600_000 + weeks * 7 * 86_400_000)
  const add = (5 - ist.getUTCDay() + 7) % 7 || 7
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add)).toISOString().slice(0, 10)
}

describe('organizer time (IST) helpers', () => {
  it('converts IST wall-clock values to exact instants and back', () => {
    expect(istLocalToInstant('2026-11-06T18:30')).toBe('2026-11-06T18:30:00+05:30')
    expect(new Date(istLocalToInstant('2026-11-06T18:30')!).toISOString()).toBe('2026-11-06T13:00:00.000Z')
    expect(instantToIstLocal('2026-11-06T13:00:00.000Z')).toBe('2026-11-06T18:30')
    expect(istLocalToInstant('2026-02-30T10:00')).toBeNull()
    expect(istLocalToInstant('nonsense')).toBeNull()
  })
  it('knows Fridays and adds days in IST', () => {
    expect(istLocalWeekday('2026-11-06T18:30')).toBe(5)
    expect(addDaysToIstLocal('2026-11-06T18:30', 7)).toBe('2026-11-13T18:30')
    expect(formatIst('2026-11-06T13:00:00.000Z')).toBe('Fri, 6 Nov 2026, 6:30 pm IST')
  })
})

describe('client-side validation (mirrors the server)', () => {
  const product = { slug: 'weekend-webinar', name: 'Weekend', type: 'WEBINAR' as const, summary: '', description: '', audience: '', durationLabel: '', amount: '149', currency: 'INR' }
  it.each([
    ['a bad slug', { slug: 'Weekend Webinar' }, /Slug/],
    ['a blank name', { name: ' ' }, /Name/],
    ['a negative price', { amount: '-1' }, /Price/],
    ['three decimals', { amount: '1.005' }, /Price/],
    ['a lower-case currency', { currency: 'inr' }, /Currency/],
  ])('rejects a product with %s', (_label, change, message) => {
    expect(validateProductDraft({ ...product, ...change })).toMatch(message)
  })
  it('accepts a valid product', () => expect(validateProductDraft(product)).toBeNull())

  const future = `${futureFriday(2)}T09:30`
  const later = `${futureFriday(2).slice(0, 8)}${futureFriday(2).slice(8)}T17:30`
  it('requires venue and end date for workshops, not for webinars', () => {
    const draft = { productId: 'p', start: future, end: '', venue: '', capacity: '', internalNote: '' }
    expect(validateSessionDraft('WEBINAR', draft)).toBeNull()
    expect(validateSessionDraft('OFFLINE_WORKSHOP', draft)).toMatch(/end date/)
    expect(validateSessionDraft('OFFLINE_WORKSHOP', { ...draft, end: later })).toMatch(/venue/)
    expect(validateSessionDraft('OFFLINE_WORKSHOP', { ...draft, end: later, venue: 'Farm' })).toBeNull()
    expect(validateSessionDraft('WEBINAR', { ...draft, end: future })).toMatch(/after the start/)
    expect(validateSessionDraft('WEBINAR', { ...draft, capacity: '0' })).toMatch(/Capacity/)
    expect(validateSessionDraft('WEBINAR', { ...draft, start: '2020-01-01T10:00' })).toMatch(/future/)
  })

  it('plans two 4-hour Fridays exactly one week apart, and rejects other days and past dates', () => {
    const friday = futureFriday(2)
    const plan = planCohort(friday, '18:30')
    expect(typeof plan).toBe('object')
    if (typeof plan === 'string') throw new Error(plan)
    expect(new Date(plan.second.start).getTime() - new Date(plan.first.start).getTime()).toBe(7 * 86_400_000)
    expect(new Date(plan.first.end).getTime() - new Date(plan.first.start).getTime()).toBe(4 * 3_600_000)
    expect(instantToIstLocal(plan.second.start)).toBe(`${addDaysToIstLocal(`${friday}T18:30`, 7)}`)
    const thursday = new Date(Date.parse(`${friday}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    expect(planCohort(thursday, '18:30')).toBe('The first session must be on a Friday.')
    expect(planCohort('2020-01-03', '18:30')).toBe('The first session must be in the future.')
  })
})

describe('admin API client', () => {
  it('sends the CSRF token on writes only, and rejects malformed responses', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const client = createApiClient({
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return String(url).includes('/products?')
          ? respond({ data: [], meta: { page: 1, pageSize: 20, total: 0 } })
          : respond({ data: { id: 'p1', slug: 's', isActive: false, price: { amount: '1.00', currency: 'INR' } } })
      }) as typeof fetch,
    })
    const api = createAdminApi(client, 'csrf-123')
    await api.listProducts({ type: 'WEBINAR', active: false, page: 2 })
    await api.setProductActive('p1', true)
    expect(calls[0]!.url).toBe('/api/v1/admin/products?type=WEBINAR&active=false&page=2')
    expect(new Headers(calls[0]!.init.headers).has('X-CSRF-Token')).toBe(false)
    expect(calls[1]).toMatchObject({ url: '/api/v1/admin/products/p1/activate', init: { method: 'POST', credentials: 'include' } })
    expect(new Headers(calls[1]!.init.headers).get('X-CSRF-Token')).toBe('csrf-123')

    const broken = createAdminApi(createApiClient({ fetch: (async () => respond({ data: { id: 1 } })) as typeof fetch }), 'c')
    await expect(broken.getProduct('x')).rejects.toMatchObject({ kind: 'invalid-response' })
  })
})

const render = (element: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>)
const api = createAdminApi(createApiClient({ fetch: (async () => new Response('{}')) as typeof fetch }), 'c')
const noop = () => {}

describe('admin forms', () => {
  it('product form: type is fixed when editing, prices are exact strings with a currency', () => {
    const create = render(<ProductEditor api={api} initial={{ slug: '', name: '', type: 'WEBINAR', summary: '', description: '', audience: '', durationLabel: '', amount: '', currency: 'INR' }} productId={null} onDone={noop} onCancel={noop} />)
    expect(create).toContain('<select')
    expect(create).toContain('No conversion or tax is applied')
    const edit = render(<ProductEditor api={api} initial={{ slug: 'x', name: 'X', type: 'WEBINAR', summary: '', description: '', audience: '', durationLabel: '', amount: '149.00', currency: 'INR' }} productId="p1" onDone={noop} onCancel={noop} />)
    expect(edit).toMatch(/<input[^>]*disabled=""[^>]*value="Webinar"|value="Webinar"[^>]*disabled=""/)
  })

  it('workshop form: venue and end date are required and editable', () => {
    const session: AdminSession = {
      id: 's1', startsAt: '2026-11-07T04:00:00.000Z', endsAt: '2026-11-11T12:00:00.000Z', timezone: 'Asia/Kolkata', capacity: 12, seatsHeld: 0, status: 'PUBLISHED',
      venue: 'Afforestt Farm, Kashipur', internalNote: null, cohortId: null, cohortSequence: null,
      product: { id: 'p', slug: 'offline-workshop', name: 'Offline Workshop', type: 'OFFLINE_WORKSHOP', isActive: true }, createdAt: '', updatedAt: '',
    }
    const html = render(<SessionEditor api={api} kind="OFFLINE_WORKSHOP" products={[{ id: 'p', name: 'Offline Workshop', isActive: true }]} session={session} onDone={noop} onCancel={noop} />)
    expect(html).toContain('value="Afforestt Farm, Kashipur"')
    expect(html).toContain('value="2026-11-07T09:30"') // shown in IST
    expect(html).toContain('value="2026-11-11T17:30"')
    expect(html.match(/required=""/g)!.length).toBeGreaterThanOrEqual(4) // product, start, end, venue
    const webinar = render(<SessionEditor api={api} kind="WEBINAR" products={[]} session={null} onDone={noop} onCancel={noop} />)
    expect(webinar).not.toContain('Venue')
    expect(webinar).toContain('(optional)')
  })

  it('training form: shows both Fridays (4 hours each, one week apart) for an existing cohort', () => {
    const cohort: AdminCohort = {
      id: 'c1', status: 'DRAFT', timezone: 'Asia/Kolkata', capacity: 20, seatsHeld: 0, internalNote: null,
      product: { id: 'p', slug: 'online-training', name: 'Online Training', type: 'ONLINE_TRAINING', isActive: true },
      sessions: [], createdAt: '', updatedAt: '',
    }
    const friday = futureFriday(3)
    const first = istLocalToInstant(`${friday}T18:30`)!
    cohort.sessions = [{ id: 'a', sequence: 1, startsAt: new Date(first).toISOString(), endsAt: null, status: 'DRAFT' }]
    const html = render(<CohortEditor api={api} products={[]} cohort={cohort} onDone={noop} onCancel={noop} />)
    expect(html).toContain('Session 1:')
    expect(html).toContain('Session 2:')
    expect(html).toContain(formatIst(new Date(Date.parse(first) + 7 * 86_400_000).toISOString()))
    expect(html).toContain('(4 hours, one week later)')
  })
})

describe('public date picker (real published dates)', () => {
  const base = { heading: 'Online Training', art: { src: '/x.png', alt: '' }, intro: null, chipLabel: 'Choose', emptyLabel: 'Select dates to continue', noneText: 'New Friday dates will be announced soon.', addLabel: 'Add', onRetry: noop, onClose: noop, onAdd: noop }
  it.each([
    ['loading', 'loading' as const, 'Loading dates'],
    ['error', 'error' as const, 'couldn’t load the dates'],
    ['empty', 'ready' as const, 'New Friday dates will be announced soon.'],
  ])('%s state: a message instead of invented dates, and no way to add', (_label, availability, text) => {
    const html = render(<DateChipModal {...base} chips={[]} availability={availability} />)
    expect(html).toContain(text)
    expect(html).not.toContain('chip-date')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>No dates available yet</)
  })

  it('ready: one chip per published date', () => {
    const html = render(<DateChipModal {...base} chips={[{ key: 'c1', label: 'Fri, 6 Nov', small: '& Fri, 13 Nov · 6:30 PM' }]} availability="ready" />)
    expect(html.match(/class="chip-date"/g)).toHaveLength(1)
    expect(html).toContain('Fri, 6 Nov')
  })

  it('formats batches and Fridays in the visitor zone', () => {
    expect(formatDateRange('2026-11-07T04:00:00Z', '2026-11-11T12:00:00Z', 'Asia/Kolkata')).toBe('7–11 Nov')
    expect(formatDateRange('2026-11-28T04:00:00Z', '2026-12-02T12:00:00Z', 'Asia/Kolkata')).toBe('28 Nov – 2 Dec')
    expect(calendarDaysInclusive('2026-11-07T04:00:00Z', '2026-11-11T12:00:00Z', 'Asia/Kolkata')).toBe(5)
    expect(formatDayMonth('2026-11-06T13:00:00Z', 'America/New_York')).toBe('Fri, 6 Nov')
    expect(formatDayMonth('2026-11-06T13:00:00Z', 'Pacific/Auckland')).toBe('Sat, 7 Nov')
  })
})
