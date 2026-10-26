import { existsSync, readFileSync } from 'node:fs'
import { createApp } from './app.js'
import { loadAuthConfig, type AuthConfig } from './config/auth.js'
import { describeDatabaseUrl, loadDatabaseConfig } from './config/database.js'
import { ConfigError, loadEnv } from './config/env.js'
import { createPrismaClient, type PrismaClient } from './db/client.js'
import { assertUtcSession } from './db/timezone-guard.js'
import { createLogger } from './lib/logger.js'
import { createShutdown } from './lib/shutdown.js'
import { createAuthRepository } from './modules/auth/auth.repository.js'
import { createAdminRepository } from './modules/admin/admin.repository.js'
import { adminManagementRouter } from './modules/admin/admin.routes.js'
import { createAuthModule } from './modules/auth/index.js'
import { createExpiryScheduler, type ExpiryScheduler } from './modules/bookings/booking-holds.js'
import { createBookingRepository } from './modules/bookings/booking.repository.js'
import { adminBookingDecisionsRouter, adminBookingsRouter, customerBookingsRouter, customerCancellationRequestsRouter } from './modules/bookings/booking.routes.js'
import { createCancellationRequestRepository } from './modules/bookings/cancellation-requests.js'
import { createManualConfirmationRepository } from './modules/bookings/manual-confirmation.js'
import { createCatalogRepository } from './modules/catalog/catalog.repository.js'
import { createPaymentRepository } from './modules/payments/payment.repository.js'
import { customerPaymentsRouter } from './modules/payments/payment.routes.js'

// Local development convenience: load backend/.env if present (Node's built-in loader, no dependency).
if (existsSync('.env')) process.loadEnvFile('.env')

// package.json sits one level above both src/ (tsx) and dist/ (compiled).
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

let env
let authConfig: AuthConfig
try {
  env = loadEnv()
  authConfig = loadAuthConfig(process.env, env)
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}

const logger = createLogger(env.nodeEnv)

// Outside production the database is optional at startup: without DATABASE_URL the API still serves
// /health and answers catalog requests with 503, so local frontend work never hard-depends on a database.
// In production it is required: refuse to start rather than run an API that cannot serve anything.
let prisma: PrismaClient | null = null
try {
  const { url } = loadDatabaseConfig()
  prisma = createPrismaClient(url)
  logger.info('Database configured', { database: describeDatabaseUrl(url) })
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  if (env.nodeEnv === 'production') {
    console.error(error.message)
    process.exit(1)
  }
  logger.warn('Database not configured; catalog endpoints will return 503', { reason: error.message })
}

if (authConfig.mode === 'dev') logger.warn('DEVELOPMENT SIGN-IN IS ENABLED (AUTH_MODE=dev): test identities only, never use in production')
if (authConfig.mode !== 'disabled' && !prisma) logger.warn('Authentication is configured but there is no database; sign-in will report unavailable')
logger.info('Authentication', { mode: authConfig.mode })

if (env.paymentSimulator) logger.warn('DEVELOPMENT PAYMENT SIMULATOR IS ENABLED (PAYMENT_SIMULATOR=true): fake payments only, no money is taken or received')

logger.info('Booking confirmation mode', { mode: env.bookingConfirmationMode })

const bookings = prisma ? createBookingRepository(prisma, { confirmationMode: env.bookingConfirmationMode }) : null
const payments = prisma && bookings ? createPaymentRepository(prisma, bookings) : null
const manualConfirmations = prisma && bookings ? createManualConfirmationRepository(prisma, bookings) : null
const cancellationRequests = prisma && bookings ? createCancellationRequestRepository(prisma, bookings) : null
// Stage 2: unpaid holds expire after 30 minutes. Swept every minute, before availability reads
// (throttled) and before each booking for the same dates; every sweep is idempotent and race-safe.
const expiry: ExpiryScheduler | null = bookings ? createExpiryScheduler({ run: (at) => bookings.expireOverdue(at), logger }) : null
const auth = createAuthModule({
  config: authConfig, repository: prisma ? createAuthRepository(prisma) : null, logger,
  adminManagement: adminManagementRouter(prisma ? createAdminRepository(prisma) : null),
  adminBookings: adminBookingsRouter(bookings, undefined, adminBookingDecisionsRouter(manualConfirmations, cancellationRequests)),
  customerBookings: customerBookingsRouter(bookings, undefined, [
    customerPaymentsRouter(payments, { simulator: env.paymentSimulator }),
    customerCancellationRequestsRouter(cancellationRequests),
  ]),
})
let lifecycle = { isShuttingDown: () => false }
const db = prisma
const app = createApp({
  env, version, logger, catalog: db ? createCatalogRepository(db, expiry ? { beforeAvailabilityRead: expiry.onRead } : {}) : null, auth,
  // Readiness: the database answers and its session is UTC (the same guard every repository uses).
  readiness: { checkDatabase: db ? () => assertUtcSession(db) : null, isShuttingDown: () => lifecycle.isShuttingDown() },
})
const server = app.listen(env.port, () => {
  logger.info('API listening', { port: env.port, nodeEnv: env.nodeEnv, version, paymentSimulator: env.paymentSimulator })
  expiry?.start()
})

// The expiry timer stops before the database pool closes (it is also unref'd, so it never holds the process).
const shutdown = createShutdown({ server, disconnect: () => { expiry?.stop(); return db ? db.$disconnect() : Promise.resolve() }, logger })
lifecycle = shutdown
process.on('SIGTERM', () => shutdown.shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown.shutdown('SIGINT'))
