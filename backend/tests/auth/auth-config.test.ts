import { describe, expect, it } from 'vitest'
import { loadAuthConfig } from '../../src/config/auth.js'
import { ConfigError } from '../../src/config/env.js'

const SECRET = 'f1e2d3c4b5a69788796a5b4c3d2e1f00aabbccddeeff0011'
const CLIENT_SECRET = 'very-private-client-secret-value-42'
const cors = ['http://localhost:5173']
const dev = { AUTH_MODE: 'dev', AUTH_DEV_LOGIN: 'true', AUTH_PUBLIC_ORIGIN: 'http://localhost:5173', SESSION_SECRET: SECRET }
const cognito = {
  AUTH_MODE: 'cognito', AUTH_PUBLIC_ORIGIN: 'https://www.diyforests.example', SESSION_SECRET: SECRET,
  COGNITO_CUSTOMER_ISSUER: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_Customer', COGNITO_CUSTOMER_CLIENT_ID: 'cust-client', COGNITO_CUSTOMER_CLIENT_SECRET: CLIENT_SECRET, COGNITO_CUSTOMER_DOMAIN: 'login.diyforests.example',
  COGNITO_ADMIN_ISSUER: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_Admin', COGNITO_ADMIN_CLIENT_ID: 'admin-client', COGNITO_ADMIN_CLIENT_SECRET: CLIENT_SECRET, COGNITO_ADMIN_DOMAIN: 'https://staff-login.diyforests.example',
}

const load = (source: Record<string, string>, nodeEnv: 'development' | 'test' | 'production' = 'development') => loadAuthConfig(source, { nodeEnv, corsOrigins: cors })
const failure = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
  throw new Error('expected a ConfigError')
}

describe('loadAuthConfig', () => {
  it('defaults to disabled, so nothing changes until auth is configured', () => {
    expect(load({})).toMatchObject({ mode: 'disabled', oidc: null })
  })

  it('applies the default session policies (customer 12 h / 7 d, admin 1 h / 12 h)', () => {
    expect(load(dev).policies).toEqual({ CUSTOMER: { idleMinutes: 720, absoluteHours: 168 }, ADMIN: { idleMinutes: 60, absoluteHours: 12 } })
  })

  describe('development identity provider', () => {
    it('works only with NODE_ENV=development and AUTH_DEV_LOGIN=true', () => {
      expect(load(dev)).toMatchObject({ mode: 'dev', cookies: { session: 'diyf_sid', secure: false } })
      expect(failure(() => load({ ...dev, AUTH_DEV_LOGIN: 'false' }))).toMatch(/AUTH_DEV_LOGIN=true/)
      expect(failure(() => load({ ...dev, AUTH_DEV_LOGIN: undefined as unknown as string }))).toMatch(/AUTH_DEV_LOGIN=true/)
      expect(failure(() => load(dev, 'test'))).toMatch(/requires NODE_ENV=development/)
    })

    it('is impossible to enable in production', () => {
      expect(failure(() => load(dev, 'production'))).toMatch(/not allowed when NODE_ENV=production/)
      expect(failure(() => load({ ...cognito, AUTH_DEV_LOGIN: 'true' }, 'production'))).toMatch(/AUTH_DEV_LOGIN must not be set in production/)
    })
  })

  describe('cognito (OIDC)', () => {
    it('builds two pools with Secure __Host- cookies on https', () => {
      const config = load(cognito, 'production')
      expect(config.cookies).toEqual({ session: '__Host-diyf_sid', loginState: '__Host-diyf_login', secure: true })
      expect(config.oidc!.CUSTOMER).toEqual({ issuer: cognito.COGNITO_CUSTOMER_ISSUER, clientId: 'cust-client', clientSecret: CLIENT_SECRET, loginOrigin: 'https://login.diyforests.example' })
      expect(config.oidc!.ADMIN.loginOrigin).toBe('https://staff-login.diyforests.example')
      expect(config.allowedOrigins).toEqual(['https://www.diyforests.example', 'http://localhost:5173'])
    })

    it.each([
      ['missing admin client secret', { COGNITO_ADMIN_CLIENT_SECRET: '' }, /COGNITO_ADMIN_CLIENT_SECRET is required/],
      ['http issuer', { COGNITO_CUSTOMER_ISSUER: 'http://cognito.example/pool' }, /must use https/],
      ['the same pool for customers and admins', { COGNITO_ADMIN_ISSUER: cognito.COGNITO_CUSTOMER_ISSUER }, /must be different user pools/],
      ['an http public origin in production', { AUTH_PUBLIC_ORIGIN: 'http://www.diyforests.example' }, /must use https/],
      ['a public origin with a path', { AUTH_PUBLIC_ORIGIN: 'https://www.diyforests.example/app' }, /origin only/],
    ])('rejects %s without echoing secrets', (_label, change, message) => {
      const text = failure(() => load({ ...cognito, ...change }, 'production'))
      expect(text).toMatch(message)
      expect(text).not.toContain(CLIENT_SECRET)
      expect(text).not.toContain(SECRET)
    })
  })

  it.each([
    ['a short session secret', { SESSION_SECRET: 'short' }, /at least 32 characters/],
    ['a placeholder session secret', { SESSION_SECRET: 'change-me-change-me-change-me-change-me' }, /placeholder/],
    ['idle longer than absolute', { SESSION_ADMIN_IDLE_MINUTES: '900', SESSION_ADMIN_ABSOLUTE_HOURS: '12' }, /SESSION_ADMIN_IDLE_MINUTES must not exceed/],
    ['an unknown mode', { AUTH_MODE: 'magic' }, /AUTH_MODE/],
    ['a missing public origin', { AUTH_PUBLIC_ORIGIN: '' }, /AUTH_PUBLIC_ORIGIN is required/],
  ])('rejects %s', (_label, change, message) => {
    expect(failure(() => load({ ...dev, ...change }))).toMatch(message)
  })
})
