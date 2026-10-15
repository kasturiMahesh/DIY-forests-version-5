import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import type { Env } from './config/env.js'
import { createLogger, type Logger } from './lib/logger.js'
import { errorHandler } from './middleware/error-handler.js'
import { notFound } from './middleware/not-found.js'
import { REQUEST_ID_HEADER, requestId } from './middleware/request-id.js'
import { healthRouter } from './routes/health.js'

export type AppOptions = {
  env: Env
  version: string
  logger?: Logger
}

export function createApp({ env, version, logger = createLogger(env.nodeEnv) }: AppOptions): Express {
  const app = express()
  app.disable('x-powered-by')

  app.use(requestId)
  app.use(helmet())
  app.use(cors({ origin: env.corsOrigins, exposedHeaders: [REQUEST_ID_HEADER] }))
  app.use(express.json({ limit: '100kb' }))

  const v1 = express.Router()
  v1.use(healthRouter(version))
  app.use('/api/v1', v1)

  app.use(notFound)
  app.use(errorHandler(logger))
  return app
}
