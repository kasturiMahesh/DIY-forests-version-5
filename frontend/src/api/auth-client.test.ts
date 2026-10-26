import { describe, expect, it } from 'vitest'
import { ApiError, createApiClient } from './client'

const user = { id: 'u1', email: 'test.customer.one@example.test', emailVerified: true, displayName: 'Test', role: 'CUSTOMER', pool: 'CUSTOMER' }
const session = { kind: 'CUSTOMER', idleExpiresAt: '2026-10-16T22:00:00.000Z', absoluteExpiresAt: '2026-10-23T10:00:00.000Z' }
type Call = { url: string; init: RequestInit }

function client(respond: (call: Call) => Response, calls: Call[] = []) {
  return createApiClient({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      return respond(call)
    }) as typeof fetch,
  })
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const headers = (call: Call) => new Headers(call.init.headers)

async function apiError(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected an ApiError')
}

describe('auth API client', () => {
  it('sends cookies with every request (credentials: include) and parses /auth/me', async () => {
    const calls: Call[] = []
    const api = client(() => json({ data: { user, session, csrfToken: 'csrf-1' } }), calls)
    expect(await api.getMe()).toEqual({ user, session, csrfToken: 'csrf-1' })
    expect(calls[0]).toMatchObject({ url: '/api/v1/auth/me', init: { method: 'GET', credentials: 'include' } })
    expect(headers(calls[0]!).has('X-CSRF-Token')).toBe(false)
  })

  it('reports 401 (signed out) and 503 (unavailable) as http ApiErrors with codes', async () => {
    const unauth = await apiError(client(() => json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.', requestId: 'r' } }, 401)).getMe())
    expect(unauth.details).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' })
    const down = await apiError(client(() => json({ error: { code: 'AUTH_UNAVAILABLE', message: 'x', requestId: 'r' } }, 503)).getMe())
    expect(down.details).toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' })
  })

  it('rejects an unexpected /auth/me shape (e.g. a role the client does not know)', async () => {
    const error = await apiError(client(() => json({ data: { user: { ...user, role: 'SUPERUSER' }, session, csrfToken: 'c' } })).getMe())
    expect(error.kind).toBe('invalid-response')
  })

  it('logs out with POST and the CSRF header', async () => {
    const calls: Call[] = []
    const api = client(() => json({ data: { logoutUrl: 'https://login.example.test/logout?client_id=x&logout_uri=y' } }), calls)
    expect(await api.logout('csrf-1')).toEqual({ logoutUrl: 'https://login.example.test/logout?client_id=x&logout_uri=y' })
    expect(calls[0]).toMatchObject({ url: '/api/v1/auth/logout', init: { method: 'POST', credentials: 'include' } })
    expect(headers(calls[0]!).get('X-CSRF-Token')).toBe('csrf-1')
  })

  it('refuses a non-https logout URL (never navigates to an arbitrary scheme)', async () => {
    expect((await apiError(client(() => json({ data: { logoutUrl: 'javascript:alert(1)' } })).logout('c'))).kind).toBe('invalid-response')
  })

  it('updates the profile with PATCH, JSON body and CSRF header', async () => {
    const calls: Call[] = []
    const api = client(() => json({ data: { ...user, displayName: 'Ana' } }), calls)
    expect((await api.updateProfile('csrf-1', 'Ana')).displayName).toBe('Ana')
    expect(calls[0]!.init).toMatchObject({ method: 'PATCH', body: JSON.stringify({ displayName: 'Ana' }) })
    expect(headers(calls[0]!).get('Content-Type')).toBe('application/json')
    expect(headers(calls[0]!).get('X-CSRF-Token')).toBe('csrf-1')
  })

  it('reports a 403 from /admin/me', async () => {
    const error = await apiError(client(() => json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this area.', requestId: 'r' } }, 403)).getAdminMe())
    expect(error.details).toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })

  it('builds sign-in navigation URLs with an encoded returnTo', () => {
    const api = createApiClient({ baseUrl: 'https://api.example.test' })
    expect(api.signInUrl('/account?x=1')).toBe('https://api.example.test/api/v1/auth/login?returnTo=%2Faccount%3Fx%3D1')
    expect(api.registerUrl()).toBe('https://api.example.test/api/v1/auth/register?returnTo=%2Faccount')
    expect(api.adminSignInUrl()).toBe('https://api.example.test/api/v1/admin/auth/login?returnTo=%2Fadmin')
  })
})
