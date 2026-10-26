import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redact } from '../../src/lib/logger.js'
import { createDevProvider } from '../../src/modules/auth/dev-provider.js'
import { safeReturnTo } from '../../src/modules/auth/return-to.js'
import {
  checkSessionTimes, csrfTokenFor, hashSessionToken, looksLikeSessionToken, newSessionToken, nextIdleExpiry, openLoginState, sealLoginState, sessionExpiry,
} from '../../src/modules/auth/session.js'

const ORIGIN = 'http://localhost:5173'
const secret = randomBytes(32)

describe('safeReturnTo', () => {
  it.each([
    ['/account', '/account'],
    ['/admin?tab=1#top', '/admin?tab=1#top'],
    ['/a/../b', '/b'],
    ['//evil.example', '/x'],
    ['/\\evil.example', '/x'],
    ['https://evil.example/', '/x'],
    ['javascript:alert(1)', '/x'],
    ['account', '/x'],
    ['/api/v1/auth/logout', '/x'],
    ['/api', '/x'],
    ['/ok\nSet-Cookie: x=1', '/x'],
    ['', '/x'],
    [`/${'a'.repeat(600)}`, '/x'],
    [42, '/x'],
  ])('%j → %s', (value, expected) => {
    expect(safeReturnTo(value, ORIGIN, '/x')).toBe(expected)
  })
})

describe('session tokens and CSRF', () => {
  it('generates 256-bit tokens and stores only their SHA-256 hash', () => {
    const token = newSessionToken()
    expect(looksLikeSessionToken(token)).toBe(true)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(hashSessionToken(token)).toBe(createHash('sha256').update(token).digest('hex'))
    expect(new Set(Array.from({ length: 100 }, newSessionToken)).size).toBe(100)
    expect(looksLikeSessionToken('short')).toBe(false)
    expect(looksLikeSessionToken(`${'A'.repeat(42)}=`)).toBe(false)
  })

  it('binds CSRF tokens to the session and the server secret', () => {
    const a = hashSessionToken(newSessionToken())
    const b = hashSessionToken(newSessionToken())
    expect(csrfTokenFor(secret, a)).toBe(csrfTokenFor(secret, a))
    expect(csrfTokenFor(secret, a)).not.toBe(csrfTokenFor(secret, b))
    expect(csrfTokenFor(secret, a)).not.toBe(csrfTokenFor(randomBytes(32), a))
  })

  it('computes idle/absolute expiry and slides idle expiry at most once a minute, never past absolute', () => {
    const now = new Date('2026-10-16T10:00:00Z')
    const { idleExpiresAt, absoluteExpiresAt } = sessionExpiry({ idleMinutes: 60, absoluteHours: 12 }, now)
    expect(idleExpiresAt.toISOString()).toBe('2026-10-16T11:00:00.000Z')
    expect(absoluteExpiresAt.toISOString()).toBe('2026-10-16T22:00:00.000Z')
    expect(nextIdleExpiry({ lastSeenAt: new Date(now.getTime() - 30_000), absoluteExpiresAt }, { idleMinutes: 60, absoluteHours: 12 }, now)).toBeNull()
    const late = new Date('2026-10-16T21:30:00Z')
    expect(nextIdleExpiry({ lastSeenAt: now, absoluteExpiresAt }, { idleMinutes: 60, absoluteHours: 12 }, late)?.toISOString()).toBe('2026-10-16T22:00:00.000Z')
    expect(checkSessionTimes({ revokedAt: null, idleExpiresAt, absoluteExpiresAt }, now)).toBe('valid')
    expect(checkSessionTimes({ revokedAt: null, idleExpiresAt, absoluteExpiresAt }, idleExpiresAt)).toBe('idle_expired')
    expect(checkSessionTimes({ revokedAt: null, idleExpiresAt: absoluteExpiresAt, absoluteExpiresAt }, absoluteExpiresAt)).toBe('absolute_expired')
    expect(checkSessionTimes({ revokedAt: now, idleExpiresAt, absoluteExpiresAt }, now)).toBe('revoked')
  })
})

describe('login state cookie', () => {
  const now = new Date('2026-10-16T10:00:00Z')
  const state = { pool: 'CUSTOMER' as const, state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/account', expiresAt: now.getTime() + 600_000 }

  it('round-trips and rejects tampering, another key, expiry and malformed input', () => {
    const sealed = sealLoginState(secret, state)
    expect(openLoginState(secret, sealed, now)).toEqual(state)
    const [payload, signature] = sealed.split('.')
    const forged = Buffer.from(JSON.stringify({ ...state, pool: 'ADMIN' })).toString('base64url')
    expect(openLoginState(secret, `${forged}.${signature}`, now)).toBeNull()
    expect(openLoginState(randomBytes(32), sealed, now)).toBeNull()
    expect(openLoginState(secret, sealed, new Date(state.expiresAt))).toBeNull()
    expect(openLoginState(secret, `${payload}.${signature}.x`, now)).toBeNull()
    expect(openLoginState(secret, undefined, now)).toBeNull()
  })
})

describe('dev identity provider', () => {
  const provider = createDevProvider('CUSTOMER', secret, ORIGIN)
  const redirectUri = `${ORIGIN}/api/v1/auth/callback`

  async function attempt() {
    const start = await provider.beginLogin({ redirectUri, screen: 'signin' })
    const url = new URL(start.url)
    const code = provider.issueCode({ subject: 'dev-customer-1', nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, redirectUri })
    const callbackUrl = new URL(`${redirectUri}?code=${encodeURIComponent(code)}&state=${start.state}`)
    return { start, callbackUrl }
  }

  it('completes a valid login', async () => {
    const { start, callbackUrl } = await attempt()
    await expect(provider.completeLogin({ callbackUrl, redirectUri, state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier })).resolves.toMatchObject({ subject: 'dev-customer-1', emailVerified: true })
  })

  it.each([
    ['a wrong PKCE verifier', { codeVerifier: 'wrong-verifier' }, /PKCE/],
    ['a wrong nonce', { nonce: 'wrong-nonce' }, /nonce/],
    ['a wrong state', { state: 'wrong-state' }, /state/],
    ['a different redirect URI', { redirectUri: `${ORIGIN}/elsewhere` }, /another client/],
  ])('rejects %s', async (_label, change, message) => {
    const { start, callbackUrl } = await attempt()
    await expect(provider.completeLogin({ callbackUrl, redirectUri, state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier, ...change })).rejects.toThrow(message)
  })

  it('rejects a replayed code', async () => {
    const { start, callbackUrl } = await attempt()
    const input = { callbackUrl, redirectUri, state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier }
    await provider.completeLogin(input)
    await expect(provider.completeLogin(input)).rejects.toThrow(/already used/)
  })

  it('rejects codes signed for the other pool', async () => {
    const admin = createDevProvider('ADMIN', secret, ORIGIN)
    const { start, callbackUrl } = await attempt()
    await expect(admin.completeLogin({ callbackUrl, redirectUri, state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier })).rejects.toThrow(/signature/)
  })
})

describe('log redaction', () => {
  it('removes secret-looking keys at any depth and keeps the rest', () => {
    expect(redact({ requestId: 'r', cookie: 'diyf_sid=abc', nested: { token: 't', csrfToken: 'c', ok: 1, list: [{ password: 'p' }] }, code: 'P1001' })).toEqual({
      requestId: 'r', cookie: '[REDACTED]', nested: { token: '[REDACTED]', csrfToken: '[REDACTED]', ok: 1, list: [{ password: '[REDACTED]' }] }, code: 'P1001',
    })
  })
})
