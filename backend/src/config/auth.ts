import { z } from 'zod'
import { ConfigError } from './env.js'

export type IdentityPoolName = 'CUSTOMER' | 'ADMIN'

/**
 * - disabled: no identity provider configured. Sign-in routes report "unavailable"; the rest of
 *   the API (catalog, health) works normally. The default, so nothing changes until configured.
 * - dev:      local fake identity provider with labelled test identities. Only in
 *             NODE_ENV=development with AUTH_DEV_LOGIN=true; refused everywhere else.
 * - cognito:  two OIDC clients (customer pool, admin pool), e.g. Amazon Cognito managed login.
 */
export type AuthMode = 'disabled' | 'dev' | 'cognito'

export type SessionPolicy = { idleMinutes: number; absoluteHours: number }

export type OidcClientConfig = {
  /** OIDC issuer; discovery is at `${issuer}/.well-known/openid-configuration`. */
  issuer: string
  clientId: string
  clientSecret: string
  /** Origin of the managed-login domain (Cognito `/logout` and `/signup` live there). */
  loginOrigin: string
}

export type AuthConfig = {
  mode: AuthMode
  /** Public origin of the website, e.g. https://www.example.com. Callback and post-logout URLs are built from it. */
  publicOrigin: string
  /** Origins allowed to make cookie-authenticated state-changing requests (Origin check). */
  allowedOrigins: string[]
  /** Server-side key for signing the short-lived login-state cookie and deriving CSRF tokens. */
  sessionSecret: Buffer
  cookies: { session: string; loginState: string; secure: boolean }
  policies: Record<IdentityPoolName, SessionPolicy>
  rateLimit: { windowMinutes: number; max: number }
  /** Only in cognito mode. */
  oidc: Record<IdentityPoolName, OidcClientConfig> | null
}

const bool = z.enum(['true', 'false']).optional()
const positiveInt = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback)

const AuthEnvSchema = z.object({
  AUTH_MODE: z.enum(['disabled', 'dev', 'cognito']).default('disabled'),
  AUTH_DEV_LOGIN: bool,
  AUTH_PUBLIC_ORIGIN: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  SESSION_CUSTOMER_IDLE_MINUTES: positiveInt(12 * 60, 30 * 24 * 60),
  SESSION_CUSTOMER_ABSOLUTE_HOURS: positiveInt(7 * 24, 90 * 24),
  SESSION_ADMIN_IDLE_MINUTES: positiveInt(60, 24 * 60),
  SESSION_ADMIN_ABSOLUTE_HOURS: positiveInt(12, 7 * 24),
  AUTH_RATE_LIMIT_WINDOW_MINUTES: positiveInt(15, 24 * 60),
  AUTH_RATE_LIMIT_MAX: positiveInt(20, 10_000),
  COGNITO_CUSTOMER_ISSUER: z.string().optional(),
  COGNITO_CUSTOMER_CLIENT_ID: z.string().optional(),
  COGNITO_CUSTOMER_CLIENT_SECRET: z.string().optional(),
  COGNITO_CUSTOMER_DOMAIN: z.string().optional(),
  COGNITO_ADMIN_ISSUER: z.string().optional(),
  COGNITO_ADMIN_CLIENT_ID: z.string().optional(),
  COGNITO_ADMIN_CLIENT_SECRET: z.string().optional(),
  COGNITO_ADMIN_DOMAIN: z.string().optional(),
})

const fail = (message: string): never => {
  throw new ConfigError(`Invalid authentication configuration: ${message}`)
}

function origin(value: string | undefined, name: string, requireHttps: boolean): string {
  if (!value?.trim()) return fail(`${name} is required`)
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return fail(`${name} must be an origin like https://www.example.com`)
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail(`${name} must be an origin only (no path, query or credentials)`)
  if (requireHttps && url.protocol !== 'https:') fail(`${name} must use https`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(`${name} must use http or https`)
  return url.origin
}

function oidcClient(source: z.infer<typeof AuthEnvSchema>, pool: IdentityPoolName): OidcClientConfig {
  const key = (suffix: string) => source[`COGNITO_${pool}_${suffix}` as keyof typeof source] as string | undefined
  const issuer = key('ISSUER')?.trim()
  if (!issuer) fail(`COGNITO_${pool}_ISSUER is required in cognito mode`)
  let issuerUrl: URL
  try {
    issuerUrl = new URL(issuer!)
  } catch {
    return fail(`COGNITO_${pool}_ISSUER must be a URL`)
  }
  if (issuerUrl.protocol !== 'https:') fail(`COGNITO_${pool}_ISSUER must use https`)
  const clientId = key('CLIENT_ID')?.trim()
  const clientSecret = key('CLIENT_SECRET')?.trim()
  if (!clientId) fail(`COGNITO_${pool}_CLIENT_ID is required in cognito mode`)
  if (!clientSecret) fail(`COGNITO_${pool}_CLIENT_SECRET is required in cognito mode`)
  const domain = key('DOMAIN')?.trim()
  const loginOrigin = origin(domain && !/^https?:\/\//.test(domain) ? `https://${domain}` : domain, `COGNITO_${pool}_DOMAIN`, true)
  return { issuer: issuerUrl.href.replace(/\/$/, ''), clientId: clientId!, clientSecret: clientSecret!, loginOrigin }
}

/**
 * Validate authentication configuration. Error messages name the variable and the rule but never
 * include secret values. `nodeEnv` and `corsOrigins` come from the already-validated core Env.
 */
export function loadAuthConfig(
  source: NodeJS.ProcessEnv,
  { nodeEnv, corsOrigins }: { nodeEnv: 'development' | 'test' | 'production'; corsOrigins: string[] },
): AuthConfig {
  const parsed = AuthEnvSchema.safeParse(source)
  if (!parsed.success) {
    // Only the variable names and rules are reported; zod messages do not include input values.
    throw new ConfigError(`Invalid authentication configuration:\n${z.prettifyError(parsed.error)}`)
  }
  const env = parsed.data
  const production = nodeEnv === 'production'

  if (env.AUTH_MODE === 'dev') {
    if (production) fail('AUTH_MODE=dev is not allowed when NODE_ENV=production')
    if (nodeEnv !== 'development') fail('AUTH_MODE=dev requires NODE_ENV=development')
    if (env.AUTH_DEV_LOGIN !== 'true') fail('AUTH_MODE=dev also requires AUTH_DEV_LOGIN=true (an explicit opt-in)')
  } else if (env.AUTH_DEV_LOGIN === 'true' && production) {
    fail('AUTH_DEV_LOGIN must not be set in production')
  }

  const policies: Record<IdentityPoolName, SessionPolicy> = {
    CUSTOMER: { idleMinutes: env.SESSION_CUSTOMER_IDLE_MINUTES, absoluteHours: env.SESSION_CUSTOMER_ABSOLUTE_HOURS },
    ADMIN: { idleMinutes: env.SESSION_ADMIN_IDLE_MINUTES, absoluteHours: env.SESSION_ADMIN_ABSOLUTE_HOURS },
  }
  for (const [pool, policy] of Object.entries(policies)) {
    if (policy.idleMinutes > policy.absoluteHours * 60) fail(`SESSION_${pool}_IDLE_MINUTES must not exceed the absolute lifetime`)
  }

  if (env.AUTH_MODE === 'disabled') {
    return {
      mode: 'disabled', publicOrigin: '', allowedOrigins: corsOrigins, sessionSecret: Buffer.alloc(0),
      cookies: { session: 'diyf_sid', loginState: 'diyf_login', secure: production }, policies,
      rateLimit: { windowMinutes: env.AUTH_RATE_LIMIT_WINDOW_MINUTES, max: env.AUTH_RATE_LIMIT_MAX }, oidc: null,
    }
  }

  const publicOrigin = origin(env.AUTH_PUBLIC_ORIGIN, 'AUTH_PUBLIC_ORIGIN', production)
  const secret = env.SESSION_SECRET ?? ''
  if (secret.length < 32) fail('SESSION_SECRET must be at least 32 characters of random data (e.g. `openssl rand -base64 48`)')
  if (/change.?me|placeholder|example|secret/i.test(secret)) fail('SESSION_SECRET looks like a placeholder; generate a random value')

  const oidc = env.AUTH_MODE === 'cognito' ? { CUSTOMER: oidcClient(env, 'CUSTOMER'), ADMIN: oidcClient(env, 'ADMIN') } : null
  // The admin boundary relies on the two pools being different identity sources.
  if (oidc && oidc.CUSTOMER.issuer === oidc.ADMIN.issuer) fail('COGNITO_CUSTOMER_ISSUER and COGNITO_ADMIN_ISSUER must be different user pools')

  const secure = publicOrigin.startsWith('https:')
  if (production && !secure) fail('cookies must be Secure in production (AUTH_PUBLIC_ORIGIN must be https)')

  return {
    mode: env.AUTH_MODE,
    publicOrigin,
    allowedOrigins: [...new Set([publicOrigin, ...corsOrigins])],
    sessionSecret: Buffer.from(secret, 'utf8'),
    // The __Host- prefix makes browsers reject the cookie unless Secure, Path=/ and host-only.
    cookies: secure ? { session: '__Host-diyf_sid', loginState: '__Host-diyf_login', secure } : { session: 'diyf_sid', loginState: 'diyf_login', secure },
    policies,
    rateLimit: { windowMinutes: env.AUTH_RATE_LIMIT_WINDOW_MINUTES, max: env.AUTH_RATE_LIMIT_MAX },
    oidc,
  }
}
