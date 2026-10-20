import { Router } from 'express'
import type { AuthConfig, IdentityPoolName } from '../../config/auth.js'
import type { Logger } from '../../lib/logger.js'
import { accountRouter, adminRouter } from './account.routes.js'
import type { AuthRepository } from './auth.repository.js'
import { authRouter } from './auth.routes.js'
import { createDevProvider, type DevProvider } from './dev-provider.js'
import type { IdentityProviders } from './identity-provider.js'
import { createOidcProvider } from './oidc-provider.js'

export type AuthModuleOptions = {
  config: AuthConfig
  repository: AuthRepository | null
  logger: Logger
  /** Tests may inject providers; otherwise they are built from `config.mode`. */
  providers?: IdentityProviders | null
  now?: () => Date
  /** Stage 4B admin management routes, mounted under /admin behind the admin guards. */
  adminManagement?: Router
  /** Stage 4C admin booking routes, mounted under /admin behind the admin guards. */
  adminBookings?: Router
  /** Stage 4C customer booking routes, mounted under /me behind the account guards. */
  customerBookings?: Router
}

/** Providers for the configured mode: none (disabled), the guarded dev provider, or OIDC (Cognito). */
export function buildProviders(config: AuthConfig): { providers: IdentityProviders | null; devProviders: Record<IdentityPoolName, DevProvider> | null } {
  if (config.mode === 'dev') {
    const devProviders = { CUSTOMER: createDevProvider('CUSTOMER', config.sessionSecret, config.publicOrigin), ADMIN: createDevProvider('ADMIN', config.sessionSecret, config.publicOrigin) }
    return { providers: devProviders, devProviders }
  }
  if (config.mode === 'cognito' && config.oidc) {
    return { providers: { CUSTOMER: createOidcProvider('CUSTOMER', config.oidc.CUSTOMER), ADMIN: createOidcProvider('ADMIN', config.oidc.ADMIN) }, devProviders: null }
  }
  return { providers: null, devProviders: null }
}

/**
 * All authentication routes under /api/v1: sign-in flows, /auth/me, logout, /me/* (own account)
 * and /admin/* (admin only). Without a database or identity provider every route still answers,
 * with a clear 401/503 or a redirect to the sign-in error page.
 */
export function createAuthModule(options: AuthModuleOptions): Router {
  const built = buildProviders(options.config)
  const providers = options.providers !== undefined ? options.providers : built.providers
  const devProviders = options.providers !== undefined ? null : built.devProviders
  const repository = providers ? options.repository : null
  const deps = { config: options.config, repository, providers, ...(options.now ? { now: options.now } : {}) }

  const router = Router()
  router.use(authRouter({ ...deps, logger: options.logger, devProviders }))
  router.use(accountRouter(deps, options.customerBookings))
  router.use(adminRouter(deps, [options.adminManagement, options.adminBookings]))
  return router
}
