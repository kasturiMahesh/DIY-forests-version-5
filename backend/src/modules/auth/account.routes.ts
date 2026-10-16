import { Router } from 'express'
import { z } from 'zod'
import { HttpError } from '../../lib/http-error.js'
import { authRateLimit, getAuth, loadSession, noStore, requireAdmin, requireCsrf, requireSession, unavailable, type AuthDeps } from './auth.middleware.js'
import type { AccountUser } from './auth.repository.js'

// Strict: role, email, status, ids … are rejected (400), so a profile update can never change privileges.
const profileUpdate = z.object({
  displayName: z.union([z.string().trim().min(1, 'must not be blank').max(80, 'must be at most 80 characters'), z.null()]),
}).strict()

const publicUser = (user: AccountUser) => ({ id: user.id, email: user.email, emailVerified: user.emailVerified, displayName: user.displayName, role: user.role, pool: user.identityPool })

/**
 * Signed-in user's own account. Every route is scoped to the session's user: no route takes a user
 * id from the URL or body, so one customer can never address another customer's data.
 */
export function accountRouter(deps: AuthDeps): Router {
  const router = Router()
  const limiter = authRateLimit({ windowMinutes: deps.config.rateLimit.windowMinutes, max: deps.config.rateLimit.max * 3 })
  const session = loadSession(deps)
  router.use('/me', noStore, limiter, (req, res, next) => (deps.repository && deps.providers ? session(req, res, next) : next(unavailable())), requireSession, requireCsrf(deps))

  router.get('/me/profile', (_req, res) => {
    res.json({ data: publicUser(getAuth(res)!.user) })
  })

  router.patch('/me/profile', async (req, res) => {
    const parsed = profileUpdate.safeParse(req.body)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => (issue.code === 'unrecognized_keys' ? `unknown field(s): ${issue.keys.join(', ')}` : `${String(issue.path[0] ?? 'body')}: ${issue.message}`)).join('; ')
      throw new HttpError(400, 'INVALID_REQUEST', `Invalid profile update: ${detail}`)
    }
    const { user } = getAuth(res)!
    try {
      const updated = await deps.repository!.updateDisplayName(user.id, parsed.data.displayName)
      await deps.repository!.audit({ actorUserId: user.id, actorLabel: 'self', action: 'PROFILE_UPDATED', targetType: 'user', targetId: user.id, requestId: res.locals.requestId, details: { fields: ['displayName'] } })
      res.json({ data: publicUser(updated) })
    } catch (error) {
      throw unavailable(error)
    }
  })

  return router
}

/** Admin area: authorization probe plus (Stage 4B) the management API, all behind the same guards. */
export function adminRouter(deps: AuthDeps, management?: Router): Router {
  const router = Router()
  const limiter = authRateLimit({ windowMinutes: deps.config.rateLimit.windowMinutes, max: deps.config.rateLimit.max * 10 })
  const session = loadSession(deps)
  router.use('/admin', noStore, limiter, (req, res, next) => (deps.repository && deps.providers ? session(req, res, next) : next(unavailable())), requireAdmin(deps), requireCsrf(deps))

  router.get('/admin/me', (_req, res) => {
    const { user, session } = getAuth(res)!
    res.json({ data: { user: publicUser(user), session: { kind: session.kind, idleExpiresAt: session.idleExpiresAt.toISOString(), absoluteExpiresAt: session.absoluteExpiresAt.toISOString() } } })
  })
  if (management) router.use('/admin', management)

  return router
}
