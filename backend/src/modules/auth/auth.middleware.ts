import { parseCookie } from 'cookie'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import type { AuthConfig, IdentityPoolName } from '../../config/auth.js'
import { HttpError } from '../../lib/http-error.js'
import type { AccountUser, AuthRepository } from './auth.repository.js'
import type { IdentityProviders } from './identity-provider.js'
import { checkSessionTimes, clearCookieOptions, csrfTokenFor, hashSessionToken, looksLikeSessionToken, nextIdleExpiry, safeEqual } from './session.js'

export type AuthDeps = {
  config: AuthConfig
  repository: AuthRepository | null
  providers: IdentityProviders | null
  now?: () => Date
}

export type AuthContext = {
  user: AccountUser
  session: { id: string; kind: IdentityPoolName; tokenHash: string; idleExpiresAt: Date; absoluteExpiresAt: Date }
}

export const getAuth = (res: Response): AuthContext | undefined => res.locals.auth as AuthContext | undefined
export const readCookie = (req: Request, name: string): string | undefined => parseCookie(req.headers.cookie ?? '')[name]

export const unavailable = (cause?: unknown) =>
  new HttpError(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again shortly.', { cause })

/** Authentication responses are personal: never cache them anywhere. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
}

/**
 * Resolves the session cookie into res.locals.auth (or leaves it unset). Rejects revoked, expired,
 * disabled-account and mismatched sessions, and clears a cookie that is no longer usable.
 * The role always comes from PostgreSQL, never from the request.
 */
export function loadSession({ config, repository, providers, now = () => new Date() }: AuthDeps): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req, config.cookies.session)
    if (token === undefined) return next()
    const forget = (reason: 'invalid' | 'expired') => {
      res.clearCookie(config.cookies.session, clearCookieOptions(config))
      res.locals.authFailure = reason
      next()
    }
    if (!repository || !providers || !looksLikeSessionToken(token)) return forget('invalid')

    const tokenHash = hashSessionToken(token)
    let stored
    try {
      stored = await repository.findSession(tokenHash)
    } catch (error) {
      return next(unavailable(error))
    }
    if (!stored) return forget('invalid')

    const at = now()
    const timing = checkSessionTimes(stored, at)
    if (timing !== 'valid') return forget(timing === 'revoked' ? 'invalid' : 'expired')
    const { user } = stored
    // The session must belong to an active account from the pool it was issued for, and that
    // pool's currently configured issuer (sessions from a replaced pool stop working).
    if (user.status !== 'ACTIVE' || user.identityPool !== stored.kind || user.identityIssuer !== providers[stored.kind].issuer) return forget('invalid')

    const idle = nextIdleExpiry(stored, config.policies[stored.kind], at)
    if (idle) {
      try {
        await repository.touchSession(stored.id, at, idle)
      } catch (error) {
        return next(unavailable(error))
      }
    }
    const context: AuthContext = { user, session: { id: stored.id, kind: stored.kind, tokenHash, idleExpiresAt: idle ?? stored.idleExpiresAt, absoluteExpiresAt: stored.absoluteExpiresAt } }
    res.locals.auth = context
    next()
  }
}

export const requireSession: RequestHandler = (_req, res, next) => {
  if (getAuth(res)) return next()
  const expired = res.locals.authFailure === 'expired'
  next(new HttpError(401, 'UNAUTHENTICATED', expired ? 'Your session has expired. Please sign in again.' : 'Please sign in to continue.'))
}

/**
 * Admin access needs all of: an ADMIN session (issued only by the admin-pool sign-in), an account
 * from the admin pool with the ADMIN role in PostgreSQL, and the configured admin issuer.
 */
export function requireAdmin(deps: AuthDeps): RequestHandler {
  return (req, res, next) => {
    requireSession(req, res, (error?: unknown) => {
      if (error) return next(error)
      const { user, session } = getAuth(res)!
      const adminIssuer = deps.providers?.ADMIN.issuer
      const allowed = session.kind === 'ADMIN' && user.identityPool === 'ADMIN' && user.role === 'ADMIN' && user.status === 'ACTIVE' && user.identityIssuer === adminIssuer
      if (!allowed) return next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this area.'))
      next()
    })
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export const CSRF_HEADER = 'X-CSRF-Token'

/**
 * For cookie-authenticated state changes: the Origin (or Referer) must be an allowed site origin,
 * and the X-CSRF-Token header must match the token bound to this session. Run after requireSession.
 */
export function requireCsrf({ config }: AuthDeps): RequestHandler {
  return (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next()
    const forbidden = () => next(new HttpError(403, 'CSRF_FAILED', 'This request could not be verified. Reload the page and try again.'))
    const origin = req.get('Origin') ?? refererOrigin(req.get('Referer'))
    if (!origin || !config.allowedOrigins.includes(origin)) return forbidden()
    const auth = getAuth(res)
    const supplied = req.get(CSRF_HEADER)
    if (!auth || !supplied || !safeEqual(supplied, csrfTokenFor(config.sessionSecret, auth.session.tokenHash))) return forbidden()
    next()
  }
}

function refererOrigin(referer: string | undefined): string | null {
  if (!referer) return null
  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}

/** Rate limiter that answers in the API's error shape, with Retry-After. In-memory: per process. */
export function authRateLimit({ windowMinutes, max }: { windowMinutes: number; max: number }) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req: Request, res: Response, next: NextFunction) => {
      const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime
      res.set('Retry-After', String(Math.max(1, Math.ceil(((resetTime?.getTime() ?? Date.now() + windowMinutes * 60_000) - Date.now()) / 1000))))
      next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a moment and try again.'))
    },
  })
}
