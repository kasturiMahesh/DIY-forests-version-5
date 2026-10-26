import { z } from 'zod'

const DEV_ORIGINS = 'http://localhost:5173,http://localhost:4173'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().optional(),
  // Number of reverse-proxy hops in front of the API (e.g. 1 behind a load balancer). Determines the
  // client IP used for rate limiting; 0 = trust no X-Forwarded-For header.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  // Stage 2 development payment simulator: fake payments, never real money. Off unless exactly "true",
  // and only allowed together with NODE_ENV=development (see loadEnv).
  PAYMENT_SIMULATOR: z.enum(['true', 'false'], { message: 'must be "true" or "false"' }).optional(),
  // Revision 3: how new bookings are confirmed. "manual" (the default everywhere): staff confirm each
  // booking request. "payment": the Stage 2 simulator flow, allowed only in development with the simulator.
  BOOKING_CONFIRMATION_MODE: z.enum(['manual', 'payment'], { message: 'must be "manual" or "payment"' }).default('manual'),
})

export type Env = {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  corsOrigins: string[]
  trustProxy: number
  /** True only when NODE_ENV=development and PAYMENT_SIMULATOR=true. */
  paymentSimulator: boolean
  /** "manual" unless BOOKING_CONFIRMATION_MODE=payment (development + PAYMENT_SIMULATOR=true only). Never enables the simulator. */
  bookingConfirmationMode: 'manual' | 'payment'
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** Parse and validate configuration. Fails fast on anything invalid. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source)
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`)
  }
  const { NODE_ENV, PORT, CORS_ORIGINS, TRUST_PROXY, PAYMENT_SIMULATOR, BOOKING_CONFIRMATION_MODE } = result.data

  if (NODE_ENV === 'production' && !CORS_ORIGINS?.trim()) {
    throw new ConfigError('Invalid environment configuration: CORS_ORIGINS is required in production')
  }
  const corsOrigins = (CORS_ORIGINS ?? DEV_ORIGINS).split(',').map((origin) => origin.trim()).filter(Boolean)
  const badOrigin = corsOrigins.find((origin) => !/^https?:\/\/[^/\s]+$/.test(origin))
  if (badOrigin) {
    throw new ConfigError(`Invalid environment configuration: CORS_ORIGINS entry "${badOrigin}" must be an origin like https://example.com`)
  }

  // Refuse to start rather than silently ignore it: a simulator outside development could mark bookings
  // confirmed without any money being received.
  if (PAYMENT_SIMULATOR === 'true' && NODE_ENV !== 'development') {
    throw new ConfigError(`Invalid environment configuration: PAYMENT_SIMULATOR=true is allowed only with NODE_ENV=development (NODE_ENV is "${NODE_ENV}"). The simulator takes no real payment.`)
  }

  // Payment mode only produces bookings that can be paid through the development simulator, so it is
  // refused everywhere else. This only validates: it never turns the simulator on.
  if (BOOKING_CONFIRMATION_MODE === 'payment' && !(NODE_ENV === 'development' && PAYMENT_SIMULATOR === 'true')) {
    throw new ConfigError('Invalid environment configuration: BOOKING_CONFIRMATION_MODE=payment requires NODE_ENV=development and PAYMENT_SIMULATOR=true. Use "manual" (the default).')
  }

  return { nodeEnv: NODE_ENV, port: PORT, corsOrigins, trustProxy: TRUST_PROXY, paymentSimulator: PAYMENT_SIMULATOR === 'true', bookingConfirmationMode: BOOKING_CONFIRMATION_MODE }
}
