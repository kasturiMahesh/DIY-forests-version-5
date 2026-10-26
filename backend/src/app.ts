import cors from 'cors'
import express, { type Express, type Router } from 'express'
import helmet from 'helmet'
import { loadAuthConfig } from './config/auth.js'
import type { Env } from './config/env.js'
import { createLogger, type Logger } from './lib/logger.js'
import { errorHandler } from './middleware/error-handler.js'
import { notFound } from './middleware/not-found.js'
import { REQUEST_ID_HEADER, requestId } from './middleware/request-id.js'
import { createAuthModule } from './modules/auth/index.js'
import type { CatalogRepository } from './modules/catalog/catalog.repository.js'
import { catalogRouter } from './modules/catalog/catalog.routes.js'
import { paymentConfigRouter } from './modules/payments/payment.routes.js'
import { healthRouter } from './routes/health.js'
import { readinessRouter, type ReadinessOptions } from './routes/ready.js'

export type AppOptions = {
  env: Env
  version: string
  logger?: Logger
  /** Read-only catalog data source. Omitted/null when no database is configured: catalog endpoints then return 503. */
  catalog?: CatalogRepository | null
  /** Authentication routes (createAuthModule). Defaults to auth disabled: sign-in reports unavailable. */
  auth?: Router
  /** GET /ready dependencies. Defaults to no database: readiness then reports 503 not_configured. */
  readiness?: ReadinessOptions
  /** Stage 2: whether the development payment simulator is on (env.paymentSimulator). Defaults to the env value. */
  paymentSimulator?: boolean
}

export function createApp({ env, version, logger = createLogger(env.nodeEnv), catalog = null, auth, readiness = { checkDatabase: null }, paymentSimulator = env.paymentSimulator }: AppOptions): Express {
  const app = express()
  app.disable('x-powered-by')
  // Only trust X-Forwarded-* from the configured number of proxies (client IP for rate limiting).
  app.set('trust proxy', env.trustProxy)

  app.use(requestId)
  app.use(helmet())
  // credentials: cookie-authenticated requests are allowed only from the explicit origin allow-list.
  app.use(cors({ origin: env.corsOrigins, credentials: true, exposedHeaders: [REQUEST_ID_HEADER] }))
  app.use(express.json({ limit: '100kb' }))

  const v1 = express.Router()
  v1.use(healthRouter(version))
  v1.use(readinessRouter(readiness))
  v1.use(catalogRouter(catalog))
  v1.use(paymentConfigRouter(paymentSimulator))
  v1.use(auth ?? createAuthModule({ config: loadAuthConfig({}, env), repository: null, logger }))
  app.use('/api/v1', v1)

  app.use(notFound)
  app.use(errorHandler(logger))
  return app
}
