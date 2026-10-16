import { createHash } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { IdentityPoolName } from '../../config/auth.js'
import { HttpError } from '../../lib/http-error.js'
import type { Logger } from '../../lib/logger.js'
import { authRateLimit, getAuth, loadSession, noStore, readCookie, requireCsrf, requireSession, unavailable, type AuthDeps } from './auth.middleware.js'
import { DEV_AUTHORIZE_PATH, DEV_IDENTITIES, type DevProvider } from './dev-provider.js'
import { IdentityProviderError } from './identity-provider.js'
import { safeReturnTo } from './return-to.js'
import {
  clearCookieOptions, csrfTokenFor, hashSessionToken, loginStateCookieOptions, looksLikeSessionToken, newSessionToken, openLoginState, sealLoginState, sessionCookieOptions,
} from './session.js'

export const CALLBACK_PATHS: Record<IdentityPoolName, string> = { CUSTOMER: '/api/v1/auth/callback', ADMIN: '/api/v1/admin/auth/callback' }
const DEFAULT_RETURN: Record<IdentityPoolName, string> = { CUSTOMER: '/account', ADMIN: '/admin' }

/** Codes the frontend's /sign-in page understands. They never carry provider or database details. */
export type SignInErrorCode =
  | 'auth_unavailable' | 'provider_unavailable' | 'service_unavailable' | 'login_expired' | 'invalid_state'
  | 'invalid_response' | 'cancelled' | 'email_unverified' | 'account_disabled' | 'not_authorized'

const loginQuery = z.object({ returnTo: z.string().max(512).optional() }).strict()
// Only the parameters an OIDC provider may send back; values are bounded, then handed to the validator.
const callbackQuery = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(100).optional(),
  error_description: z.string().max(1000).optional(),
  iss: z.string().max(512).optional(),
}).strict()

export type AuthRouteDeps = AuthDeps & { logger: Logger; devProviders: Record<IdentityPoolName, DevProvider> | null }

const opaqueIdentity = (issuer: string, subject: string) => createHash('sha256').update(`${issuer}\n${subject}`).digest('hex').slice(0, 32)

export function authRouter(deps: AuthRouteDeps): Router {
  const { config, repository, providers, logger, devProviders, now = () => new Date() } = deps
  const router = Router()
  const signInLimiter = authRateLimit(config.rateLimit)
  const sessionLimiter = authRateLimit({ windowMinutes: config.rateLimit.windowMinutes, max: config.rateLimit.max * 3 })
  const session = loadSession(deps)

  const errorRedirect = (res: Response, pool: IdentityPoolName, code: SignInErrorCode) => {
    res.clearCookie(config.cookies.loginState, clearCookieOptions(config))
    const target = `${config.publicOrigin}/sign-in?error=${code}${pool === 'ADMIN' ? '&pool=admin' : ''}`
    res.set('Cache-Control', 'no-store').redirect(303, target)
  }

  // ---- start sign-in: GET /auth/login, /auth/register, /admin/auth/login --------------------
  const startLogin = (pool: IdentityPoolName, screen: 'signin' | 'signup') => async (req: Request, res: Response) => {
    const parsed = loginQuery.safeParse(req.query)
    if (!parsed.success) throw new HttpError(400, 'INVALID_QUERY', 'Invalid query parameters: only returnTo is accepted')
    const provider = providers?.[pool]
    if (!provider || !repository) return errorRedirect(res, pool, 'auth_unavailable')

    const returnTo = safeReturnTo(parsed.data.returnTo, config.publicOrigin, DEFAULT_RETURN[pool])
    let start
    try {
      start = await provider.beginLogin({ redirectUri: `${config.publicOrigin}${CALLBACK_PATHS[pool]}`, screen })
    } catch (error) {
      logger.error('Sign-in could not start', { requestId: res.locals.requestId, pool, cause: describe(error) })
      return errorRedirect(res, pool, 'provider_unavailable')
    }
    const sealed = sealLoginState(config.sessionSecret, { pool, state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier, returnTo, expiresAt: now().getTime() + 10 * 60_000 })
    res.cookie(config.cookies.loginState, sealed, loginStateCookieOptions(config))
    res.set('Cache-Control', 'no-store').redirect(303, start.url)
  }

  // ---- finish sign-in: GET /auth/callback, /admin/auth/callback ------------------------------
  const finishLogin = (pool: IdentityPoolName) => async (req: Request, res: Response) => {
    const provider = providers?.[pool]
    if (!provider || !repository) return errorRedirect(res, pool, 'auth_unavailable')
    const loginState = openLoginState(config.sessionSecret, readCookie(req, config.cookies.loginState), now())
    res.clearCookie(config.cookies.loginState, clearCookieOptions(config)) // single use, whatever happens next
    const query = callbackQuery.safeParse(req.query)
    if (!loginState || loginState.pool !== pool) return errorRedirect(res, pool, 'login_expired')
    if (!query.success) return errorRedirect(res, pool, 'invalid_response')
    if (query.data.error) return errorRedirect(res, pool, query.data.error === 'access_denied' ? 'cancelled' : 'invalid_response')
    if (query.data.state !== loginState.state) return errorRedirect(res, pool, 'invalid_state')

    const redirectUri = `${config.publicOrigin}${CALLBACK_PATHS[pool]}`
    const callbackUrl = new URL(redirectUri)
    for (const [key, value] of Object.entries(query.data)) if (value !== undefined) callbackUrl.searchParams.set(key, value)

    let identity
    try {
      identity = await provider.completeLogin({ callbackUrl, redirectUri, state: loginState.state, nonce: loginState.nonce, codeVerifier: loginState.codeVerifier })
    } catch (error) {
      const reason = error instanceof IdentityProviderError ? error.reason : 'invalid_response'
      logger.warn('Sign-in callback rejected', { requestId: res.locals.requestId, pool, reason, cause: describe(error) })
      return errorRedirect(res, pool, reason === 'unavailable' ? 'provider_unavailable' : 'invalid_response')
    }
    if (identity.issuer !== provider.issuer) return errorRedirect(res, pool, 'invalid_response')
    if (!identity.emailVerified) return errorRedirect(res, pool, 'email_unverified')

    try {
      const at = now()
      const outcome = pool === 'ADMIN' ? await repository.signInAdmin(identity, at) : await repository.signInCustomer(identity, at)
      if (outcome.kind !== 'ok') {
        if (pool === 'ADMIN') {
          await repository.audit({ actorLabel: 'admin-pool-identity', action: 'ADMIN_SIGN_IN_DENIED', targetType: 'identity', targetId: opaqueIdentity(identity.issuer, identity.subject), requestId: res.locals.requestId, details: { reason: outcome.kind } })
        }
        return errorRedirect(res, pool, outcome.kind === 'disabled' ? 'account_disabled' : 'not_authorized')
      }

      // Session rotation: any session this browser already had is revoked; a fresh token is issued.
      const previous = readCookie(req, config.cookies.session)
      if (looksLikeSessionToken(previous)) await repository.revokeSession(hashSessionToken(previous), 'ROTATED', at)
      const token = newSessionToken()
      const policy = config.policies[pool]
      await repository.createSession({ userId: outcome.user.id, kind: pool, tokenHash: hashSessionToken(token), policy, userAgent: req.get('User-Agent') ?? null, now: at })
      if (pool === 'ADMIN') await repository.audit({ actorUserId: outcome.user.id, actorLabel: 'admin', action: 'ADMIN_SIGNED_IN', targetType: 'user', targetId: outcome.user.id, requestId: res.locals.requestId })

      res.cookie(config.cookies.session, token, sessionCookieOptions(config, policy))
      res.set('Cache-Control', 'no-store').redirect(303, `${config.publicOrigin}${loginState.returnTo}`)
    } catch (error) {
      logger.error('Sign-in could not be completed', { requestId: res.locals.requestId, pool, cause: describe(error) })
      return errorRedirect(res, pool, 'service_unavailable')
    }
  }

  router.get('/auth/login', signInLimiter, startLogin('CUSTOMER', 'signin'))
  router.get('/auth/register', signInLimiter, startLogin('CUSTOMER', 'signup'))
  router.get('/auth/callback', signInLimiter, finishLogin('CUSTOMER'))
  router.get('/admin/auth/login', signInLimiter, startLogin('ADMIN', 'signin'))
  router.get('/admin/auth/callback', signInLimiter, finishLogin('ADMIN'))

  // ---- current user --------------------------------------------------------------------------
  router.get('/auth/me', noStore, sessionLimiter, (req, res, next) => {
    if (!repository || !providers) return next(unavailable())
    session(req, res, next)
  }, requireSession, (_req, res) => {
    const { user, session: current } = getAuth(res)!
    res.json({
      data: {
        user: { id: user.id, email: user.email, emailVerified: user.emailVerified, displayName: user.displayName, role: user.role, pool: user.identityPool },
        session: { kind: current.kind, idleExpiresAt: current.idleExpiresAt.toISOString(), absoluteExpiresAt: current.absoluteExpiresAt.toISOString() },
        csrfToken: csrfTokenFor(config.sessionSecret, current.tokenHash),
      },
    })
  })

  // ---- logout ----------------------------------------------------------------------------------
  router.post('/auth/logout', noStore, sessionLimiter, session, requireSession, requireCsrf(deps), async (_req, res) => {
    const { user, session: current } = getAuth(res)!
    try {
      await repository!.revokeSession(current.tokenHash, 'LOGOUT', now())
      if (current.kind === 'ADMIN') await repository!.audit({ actorUserId: user.id, actorLabel: 'admin', action: 'ADMIN_SIGNED_OUT', targetType: 'user', targetId: user.id, requestId: res.locals.requestId })
    } catch (error) {
      throw unavailable(error)
    }
    res.clearCookie(config.cookies.session, clearCookieOptions(config))
    // Also end the provider's own sign-in session (Cognito managed login), then come back home.
    res.json({ data: { logoutUrl: providers?.[current.kind].logoutUrl(`${config.publicOrigin}/`) ?? null } })
  })

  // ---- development sign-in page (AUTH_MODE=dev only) --------------------------------------------
  if (devProviders) {
    const devQuery = z.object({
      pool: z.enum(['CUSTOMER', 'ADMIN']), redirect_uri: z.string().max(512), state: z.string().max(256), nonce: z.string().max(256),
      code_challenge: z.string().max(256), code_challenge_method: z.literal('S256'), screen: z.enum(['signin', 'signup']), subject: z.string().max(100).optional(),
    }).strict()
    const parseDev = (req: Request) => {
      const parsed = devQuery.safeParse(req.query)
      if (!parsed.success) throw new HttpError(400, 'INVALID_QUERY', 'Invalid development sign-in request')
      if (parsed.data.redirect_uri !== `${config.publicOrigin}${CALLBACK_PATHS[parsed.data.pool]}`) throw new HttpError(400, 'INVALID_QUERY', 'Unexpected redirect_uri')
      return parsed.data
    }
    router.get(DEV_AUTHORIZE_PATH.replace('/api/v1', ''), noStore, signInLimiter, (req, res) => {
      const query = parseDev(req)
      res.type('html').send(devSignInPage(query, config.publicOrigin))
    })
    router.get(`${DEV_AUTHORIZE_PATH.replace('/api/v1', '')}/approve`, noStore, signInLimiter, (req, res) => {
      const query = parseDev(req)
      if (!query.subject) throw new HttpError(400, 'INVALID_QUERY', 'Choose a test identity')
      const code = devProviders[query.pool].issueCode({ subject: query.subject, nonce: query.nonce, challenge: query.code_challenge, redirectUri: query.redirect_uri })
      const target = new URL(query.redirect_uri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', query.state)
      res.redirect(303, target.href)
    })
  }

  return router
}

function describe(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  return { name: error.name, message: error.message, ...(error.cause instanceof Error ? { cause: { name: error.cause.name, message: error.cause.message } } : {}) }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function devSignInPage(query: Record<string, string | undefined> & { pool: IdentityPoolName }, publicOrigin: string): string {
  const link = (subject: string) => {
    const url = new URL(`${DEV_AUTHORIZE_PATH}/approve`, publicOrigin)
    for (const [key, value] of Object.entries(query)) if (value !== undefined && key !== 'subject') url.searchParams.set(key, value)
    url.searchParams.set('subject', subject)
    return `${url.pathname}${url.search}`
  }
  const items = DEV_IDENTITIES[query.pool]
    .map((identity) => `<li><a href="${escapeHtml(link(identity.subject))}">${escapeHtml(identity.name)}</a><br><small>${escapeHtml(identity.email)} · ${escapeHtml(identity.note)}</small></li>`)
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Development sign-in (not a real login)</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:#f4f1e8;color:#292724}
.warn{background:#a5644b;color:#fff;padding:12px 16px;border-radius:8px;font-weight:600}li{margin:14px 0}a{color:#493631;font-weight:600}small{color:#625d57}</style></head>
<body><p class="warn">DEVELOPMENT SIGN-IN — test identities only. This page does not exist in production.</p>
<h1>${query.pool === 'ADMIN' ? 'Admin pool' : 'Customer pool'}: choose a test identity</h1><ul>${items}</ul>
<p><a href="/">Cancel</a></p></body></html>`
}
