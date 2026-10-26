import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CookieOptions } from 'express'
import type { AuthConfig, IdentityPoolName, SessionPolicy } from '../../config/auth.js'

// ---- session tokens -------------------------------------------------------------------------

/** 256 bits of randomness, base64url. Lives only in the browser cookie. */
export const newSessionToken = () => randomBytes(32).toString('base64url')

/** Only this hash is stored in PostgreSQL; a database leak does not reveal usable cookies. */
export const hashSessionToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')

/** Rejects anything that is not shaped like our tokens before touching the database. */
export const looksLikeSessionToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export function sessionExpiry(policy: SessionPolicy, now: Date) {
  const absoluteExpiresAt = new Date(now.getTime() + policy.absoluteHours * 3_600_000)
  return { absoluteExpiresAt, idleExpiresAt: minDate(new Date(now.getTime() + policy.idleMinutes * 60_000), absoluteExpiresAt) }
}

const minDate = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b)

export type SessionCheck = 'valid' | 'revoked' | 'idle_expired' | 'absolute_expired'

export function checkSessionTimes(session: { revokedAt: Date | null; idleExpiresAt: Date; absoluteExpiresAt: Date }, now: Date): SessionCheck {
  if (session.revokedAt) return 'revoked'
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) return 'absolute_expired'
  if (now.getTime() >= session.idleExpiresAt.getTime()) return 'idle_expired'
  return 'valid'
}

/** Sliding idle expiry, never beyond the absolute limit. Writes are throttled to once a minute. */
export function nextIdleExpiry(session: { lastSeenAt: Date; absoluteExpiresAt: Date }, policy: SessionPolicy, now: Date): Date | null {
  if (now.getTime() - session.lastSeenAt.getTime() < 60_000) return null
  return minDate(new Date(now.getTime() + policy.idleMinutes * 60_000), session.absoluteExpiresAt)
}

// ---- CSRF -----------------------------------------------------------------------------------

/** Session-bound CSRF token: HMAC of the session hash. Nothing extra to store; rotates with the session. */
export const csrfTokenFor = (secret: Buffer, tokenHash: string) => createHmac('sha256', secret).update(`csrf:${tokenHash}`).digest('base64url')

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// ---- cookies --------------------------------------------------------------------------------

export function sessionCookieOptions(config: AuthConfig, policy: SessionPolicy): CookieOptions {
  return { httpOnly: true, secure: config.cookies.secure, sameSite: 'lax', path: '/', maxAge: policy.absoluteHours * 3_600_000 }
}

// SameSite=Lax is required: the provider redirects back with a top-level GET from another site.
export const loginStateCookieOptions = (config: AuthConfig): CookieOptions => ({ httpOnly: true, secure: config.cookies.secure, sameSite: 'lax', path: '/', maxAge: 10 * 60_000 })

export const clearCookieOptions = (config: AuthConfig): CookieOptions => ({ httpOnly: true, secure: config.cookies.secure, sameSite: 'lax', path: '/' })

// ---- login state (state, nonce, PKCE verifier, returnTo) -------------------------------------

export type LoginState = { pool: IdentityPoolName; state: string; nonce: string; codeVerifier: string; returnTo: string; expiresAt: number }

const sign = (secret: Buffer, payload: string) => createHmac('sha256', secret).update(`login:${payload}`).digest('base64url')

export function sealLoginState(secret: Buffer, value: LoginState): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

/** Returns null for anything tampered, malformed or expired. */
export function openLoginState(secret: Buffer, sealed: unknown, now: Date): LoginState | null {
  if (typeof sealed !== 'string' || sealed.length > 4096) return null
  const [payload, signature, extra] = sealed.split('.')
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, sign(secret, payload))) return null
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LoginState
    if (typeof value.expiresAt !== 'number' || value.expiresAt <= now.getTime()) return null
    if (value.pool !== 'CUSTOMER' && value.pool !== 'ADMIN') return null
    if (![value.state, value.nonce, value.codeVerifier, value.returnTo].every((part) => typeof part === 'string' && part.length > 0)) return null
    return value
  } catch {
    return null
  }
}
