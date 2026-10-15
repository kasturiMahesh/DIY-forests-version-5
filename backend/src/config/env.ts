import { z } from 'zod'

const DEV_ORIGINS = 'http://localhost:5173,http://localhost:4173'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().optional(),
})

export type Env = {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  corsOrigins: string[]
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
  const { NODE_ENV, PORT, CORS_ORIGINS } = result.data

  if (NODE_ENV === 'production' && !CORS_ORIGINS?.trim()) {
    throw new ConfigError('Invalid environment configuration: CORS_ORIGINS is required in production')
  }
  const corsOrigins = (CORS_ORIGINS ?? DEV_ORIGINS).split(',').map((origin) => origin.trim()).filter(Boolean)
  const badOrigin = corsOrigins.find((origin) => !/^https?:\/\/[^/\s]+$/.test(origin))
  if (badOrigin) {
    throw new ConfigError(`Invalid environment configuration: CORS_ORIGINS entry "${badOrigin}" must be an origin like https://example.com`)
  }

  return { nodeEnv: NODE_ENV, port: PORT, corsOrigins }
}
