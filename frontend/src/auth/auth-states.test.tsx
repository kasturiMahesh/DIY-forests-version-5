// Loading / signed-out / expired / unavailable / signed-in / forbidden states, rendered to HTML.
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { MeResponse } from '../api/types'
import AccountPage from '../pages/AccountPage'
import { AdminView, type AdminCheck } from '../pages/AdminPage'
import SignInPage from '../pages/SignInPage'
import { AccountLink } from './AccountLink'
import { AuthContext, type AuthState } from './auth-context'

const customer: MeResponse = {
  user: { id: 'u1', email: 'test.customer.one@example.test', emailVerified: true, displayName: 'Test Customer One', role: 'CUSTOMER', pool: 'CUSTOMER' },
  session: { kind: 'CUSTOMER', idleExpiresAt: '2026-10-16T22:00:00.000Z', absoluteExpiresAt: '2026-10-23T10:00:00.000Z' },
  csrfToken: 'csrf',
}
const admin: MeResponse = {
  user: { id: 'a1', email: 'test.admin@example.test', emailVerified: true, displayName: 'Test Admin', role: 'ADMIN', pool: 'ADMIN' },
  session: { kind: 'ADMIN', idleExpiresAt: '2026-10-16T11:00:00.000Z', absoluteExpiresAt: '2026-10-16T22:00:00.000Z' },
  csrfToken: 'csrf',
}
const state = (overrides: Partial<AuthState>): AuthState => ({
  status: 'loading', me: null, expired: false, refresh: () => {}, sessionExpired: () => {}, signOut: async () => {}, ...overrides,
})
const render = (auth: AuthState, element: React.ReactElement, path = '/') =>
  renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><AuthContext.Provider value={auth}>{element}</AuthContext.Provider></MemoryRouter>)

describe('header Sign in / Account control', () => {
  it('shows "Sign in" (a full-page link to the backend) while loading and when signed out', () => {
    for (const status of ['loading', 'signed-out', 'unavailable', 'error'] as const) {
      const html = render(state({ status }), <AccountLink />)
      expect(html).toContain('href="/api/v1/auth/login?returnTo=%2Faccount"')
      expect(html).toContain('Sign in')
    }
  })

  it('shows "Account" for customers and "Admin" only for an admin session', () => {
    expect(render(state({ status: 'signed-in', me: customer }), <AccountLink />)).toMatch(/href="\/account"[^>]*>.*Account/)
    expect(render(state({ status: 'signed-in', me: admin }), <AccountLink />)).toMatch(/href="\/admin"[^>]*>.*Admin/)
  })

  it('uses the same pill styling as the Cart button', () => {
    expect(render(state({ status: 'signed-out' }), <AccountLink />)).toMatch(/class="icon-toggle account-link"/)
  })
})

describe('account page', () => {
  it('loading', () => {
    expect(render(state({ status: 'loading' }), <AccountPage />)).toContain('Loading your account…')
  })

  it('signed out: sign in / create account', () => {
    const html = render(state({ status: 'signed-out' }), <AccountPage />)
    expect(html).toContain('Please sign in to see your account.')
    expect(html).toContain('/api/v1/auth/register?returnTo=%2Faccount')
    expect(html).not.toContain('test.customer.one@example.test')
  })

  it('expired session: says so', () => {
    expect(render(state({ status: 'signed-out', expired: true }), <AccountPage />)).toContain('Your session has expired. Please sign in again.')
  })

  it('unavailable / error: recoverable', () => {
    expect(render(state({ status: 'unavailable' }), <AccountPage />)).toMatch(/isn’t available.*Try again/)
    expect(render(state({ status: 'error' }), <AccountPage />)).toMatch(/couldn’t reach the server.*Try again/)
  })

  it('signed in: own details, editable name, sign out; no invented bookings', () => {
    const html = render(state({ status: 'signed-in', me: customer }), <AccountPage />)
    expect(html).toContain('Hello, Test Customer One')
    expect(html).toContain('test.customer.one@example.test')
    expect(html).toContain('name="displayName"')
    expect(html).toContain('Sign out')
    // Stage 4C: bookings are loaded from GET /me/bookings; nothing is rendered before the server answers.
    expect(html).toContain('Your bookings')
    expect(html).toContain('Loading your bookings…')
    expect(html).toContain('pending payment')
    expect(html).not.toMatch(/DF-[0-9A-Z]{8}|₹|\$\d/)
    expect(html).not.toContain('csrf') // the CSRF token is never rendered
  })
})

describe('admin page', () => {
  const view = (auth: AuthState, check: AdminCheck) => render(auth, <AdminView auth={auth} check={check} />, '/admin')

  it('signed out: staff sign-in entry point (admin pool)', () => {
    const html = view(state({ status: 'signed-out' }), { state: 'checking' })
    expect(html).toContain('href="/api/v1/admin/auth/login?returnTo=%2Fadmin"')
    expect(html).toContain('This area is for DIY Forests staff.')
  })

  it('waits for the server check before showing anything admin-only', () => {
    const html = view(state({ status: 'signed-in', me: admin }), { state: 'checking' })
    expect(html).toContain('Checking access…')
    expect(html).not.toContain('Admin dashboard')
  })

  it('forbidden: a customer session sees an explanation, not the dashboard', () => {
    const html = view(state({ status: 'signed-in', me: customer }), { state: 'forbidden' })
    expect(html).toContain('doesn’t have access to the admin area')
    expect(html).not.toContain('Admin dashboard')
  })

  it('expired session and server errors', () => {
    expect(view(state({ status: 'signed-out', expired: true }), { state: 'checking' })).toContain('Your session has expired.')
    expect(view(state({ status: 'signed-in', me: admin }), { state: 'error' })).toMatch(/couldn’t reach the server.*Try again/)
  })

  it('confirmed admin: functional dashboard (Stage 4B) with section tabs, loading real data, no fake figures', () => {
    const html = view(state({ status: 'signed-in', me: admin }), { state: 'ok', data: { user: admin.user, session: admin.session } })
    expect(html).toContain('Admin dashboard')
    expect(html).toContain('Welcome, Test Admin')
    for (const tab of ['Overview', 'Products', 'Webinars', 'Workshops', 'Online training', 'Bookings']) expect(html).toContain(`>${tab}</a>`)
    expect(html).toContain('Loading…') // panels fetch from the admin API; nothing is pre-filled
    expect(html).not.toContain('Bookings and customer records are not available yet')
    expect(html).not.toMatch(/\d+ bookings|₹|\$\d/)
  })
})

describe('sign-in page', () => {
  it.each([
    ['not_authorized', 'admin', 'This staff account hasn’t been given access'],
    ['account_disabled', null, 'This account has been disabled.'],
    ['login_expired', null, 'Please start again.'],
    ['something_unknown', null, 'Sign-in didn’t complete.'],
  ])('explains error %s', (error, pool, text) => {
    const html = render(state({ status: 'signed-out' }), <SignInPage />, `/sign-in?error=${error}${pool ? `&pool=${pool}` : ''}`)
    expect(html).toContain(text)
    expect(html).toContain('role="alert"')
  })

  it('offers the staff flow only for staff errors', () => {
    expect(render(state({}), <SignInPage />, '/sign-in?error=not_authorized&pool=admin')).toContain('/api/v1/admin/auth/login')
    expect(render(state({}), <SignInPage />, '/sign-in')).not.toContain('/api/v1/admin/auth/login')
  })
})
