import { randomBytes } from 'node:crypto'
import type { Express } from 'express'
import request from 'supertest'
import { expect } from 'vitest'
import { loadAuthConfig, type AuthConfig } from '../../src/config/auth.js'

export const PUBLIC_ORIGIN = 'http://localhost:5173'

/** A real dev-mode configuration, exactly as `loadAuthConfig` builds it for local development. */
export function devAuthConfig(overrides: Record<string, string> = {}): AuthConfig {
  return loadAuthConfig(
    { AUTH_MODE: 'dev', AUTH_DEV_LOGIN: 'true', AUTH_PUBLIC_ORIGIN: PUBLIC_ORIGIN, SESSION_SECRET: randomBytes(48).toString('base64'), AUTH_RATE_LIMIT_MAX: '10000', ...overrides },
    { nodeEnv: 'development', corsOrigins: [PUBLIC_ORIGIN, 'http://localhost:4173'] },
  )
}

export type SetCookie = { name: string; value: string; attributes: string }

export function setCookies(res: request.Response): SetCookie[] {
  const header = res.headers['set-cookie'] as unknown as string[] | string | undefined
  const list = Array.isArray(header) ? header : header ? [header] : []
  return list.map((line) => {
    const [pair = '', ...rest] = line.split(';')
    const index = pair.indexOf('=')
    return { name: pair.slice(0, index).trim(), value: decodeURIComponent(pair.slice(index + 1).trim()), attributes: rest.join(';').trim() }
  })
}

export const findCookie = (res: request.Response, name: string) => setCookies(res).find((cookie) => cookie.name === name)

/** Path + query of an absolute Location on the public origin (the Vite proxy forwards /api to the API). */
export function localPath(location: string | undefined): string {
  expect(location).toBeTruthy()
  const url = new URL(location!)
  expect(url.origin).toBe(PUBLIC_ORIGIN)
  return `${url.pathname}${url.search}`
}

export type SignInResult = {
  /** Final redirect target (the page the browser lands on). */
  location: string
  /** Session cookie value, if a session was issued. */
  session: string | undefined
  responses: request.Response[]
}

/**
 * Drives the real HTTP flow: start → dev authorize page → choose identity → callback.
 * `existingSession` simulates a browser that already holds a session cookie (rotation).
 */
export async function signIn(
  app: Express,
  config: AuthConfig,
  { pool = 'CUSTOMER', subject, returnTo, screen = 'signin', existingSession, tamper }: {
    pool?: 'CUSTOMER' | 'ADMIN'
    subject: string
    returnTo?: string
    screen?: 'signin' | 'signup'
    existingSession?: string
    tamper?: (step: { callbackPath: string; loginCookie: string }) => { callbackPath: string; loginCookie: string }
  },
): Promise<SignInResult> {
  const startPath = pool === 'ADMIN' ? '/api/v1/admin/auth/login' : screen === 'signup' ? '/api/v1/auth/register' : '/api/v1/auth/login'
  const start = await request(app).get(`${startPath}${returnTo !== undefined ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`)
  expect(start.status).toBe(303)
  const loginCookie = findCookie(start, config.cookies.loginState)?.value
  expect(loginCookie).toBeTruthy()

  const page = await request(app).get(localPath(start.headers.location))
  expect(page.status).toBe(200)
  const approve = new URL(localPath(start.headers.location), PUBLIC_ORIGIN)
  approve.pathname += '/approve'
  approve.searchParams.set('subject', subject)
  const chosen = await request(app).get(`${approve.pathname}${approve.search}`)
  expect(chosen.status).toBe(303)

  let step = { callbackPath: localPath(chosen.headers.location), loginCookie: loginCookie! }
  if (tamper) step = tamper(step)
  const cookies = [`${config.cookies.loginState}=${encodeURIComponent(step.loginCookie)}`]
  if (existingSession) cookies.push(`${config.cookies.session}=${existingSession}`)
  const callback = await request(app).get(step.callbackPath).set('Cookie', cookies.join('; '))
  expect(callback.status).toBe(303)
  return { location: callback.headers.location as string, session: findCookie(callback, config.cookies.session)?.value || undefined, responses: [start, page, chosen, callback] }
}

export const withSession = (config: AuthConfig, token: string) => `${config.cookies.session}=${token}`

/** Fetch /auth/me and return the CSRF token for state-changing requests. */
export async function csrfFor(app: Express, config: AuthConfig, token: string): Promise<string> {
  const me = await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, token))
  expect(me.status).toBe(200)
  return me.body.data.csrfToken as string
}
