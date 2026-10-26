import { ConfigError } from './env.js'

export type DatabaseConfig = {
  /** Runtime connection string (on Neon: the pooled "-pooler" endpoint). Treat as a secret. */
  url: string
}

const SETUP_HINT = 'Copy backend/.env.example to backend/.env and set DATABASE_URL (see backend/README.md, "Database setup").'

/**
 * Validate the runtime database configuration. Error messages never include the
 * connection string, because it contains the database password.
 */
export function loadDatabaseConfig(source: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const url = source.DATABASE_URL?.trim()
  if (!url) {
    throw new ConfigError(`Database is not configured: DATABASE_URL is missing. ${SETUP_HINT}`)
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ConfigError(`Database is not configured: DATABASE_URL is not a valid URL. ${SETUP_HINT}`)
  }
  // Do not echo the parsed protocol: for malformed input it can be part of the password.
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new ConfigError(`Database is not configured: DATABASE_URL must start with postgresql://. ${SETUP_HINT}`)
  }
  if (!parsed.hostname || parsed.pathname.length <= 1) {
    throw new ConfigError(`Database is not configured: DATABASE_URL must include a host and a database name. ${SETUP_HINT}`)
  }
  return { url }
}

/** Safe description of a connection string for logs: host and database only, never credentials or query options. */
export function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`
  } catch {
    return '(unparseable database URL)'
  }
}
