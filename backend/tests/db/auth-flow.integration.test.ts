import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadAuthConfig, type AuthConfig } from '../../src/config/auth.js'
import { loadEnv } from '../../src/config/env.js'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { runAdminCommand } from '../../src/modules/auth/admin-cli.js'
import { createAuthRepository, type AuthRepository } from '../../src/modules/auth/auth.repository.js'
import { createDevProvider, DEV_ISSUERS } from '../../src/modules/auth/dev-provider.js'
import { createAuthModule } from '../../src/modules/auth/index.js'
import { hashSessionToken } from '../../src/modules/auth/session.js'
import { memoryLogger, type LoggedLine } from '../helpers.js'
import { csrfFor, devAuthConfig, findCookie, PUBLIC_ORIGIN, signIn, withSession } from '../auth/helpers.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

let database: TestDatabase
let prisma: PrismaClient
const env = loadEnv({ NODE_ENV: 'test' })
const config = devAuthConfig()
const logLines: LoggedLine[] = []

function buildApp(options: { authConfig?: AuthConfig; repository?: AuthRepository | null; lines?: LoggedLine[]; providers?: Parameters<typeof createAuthModule>[0]['providers'] } = {}) {
  const authConfig = options.authConfig ?? config
  const logger = memoryLogger(options.lines ?? logLines)
  const auth = createAuthModule({
    config: authConfig, logger,
    repository: options.repository === undefined ? createAuthRepository(prisma) : options.repository,
    ...(options.providers !== undefined ? { providers: options.providers } : {}),
  })
  return createApp({ env, version: 'test', logger, auth })
}

let app: ReturnType<typeof buildApp>
const admin = async (argv: string[]) => {
  const out: string[] = []
  await runAdminCommand(argv, { repository: createAuthRepository(prisma), authConfig: config, actorLabel: 'operator-cli:test', print: (line) => out.push(line) })
  return out.join('\n')
}
const userBySubject = (subject: string) => prisma.user.findFirst({ where: { identitySubject: subject } })
const signInPath = (location: string) => { const url = new URL(location); return { origin: url.origin, path: url.pathname, error: url.searchParams.get('error'), pool: url.searchParams.get('pool') } }

beforeAll(async () => {
  database = await startTestDatabase()
  await prismaCli(['migrate', 'deploy'], database.url) // applies init_catalog + auth_foundation
  prisma = createPrismaClient(database.url, { maxConnections: 1 })
  await prisma.$executeRawUnsafe(`SET TIME ZONE 'Etc/GMT-5'`)
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await database?.stop()
})

describe('UTC guard on authentication writes', () => {
  it('refuses to sign anyone in when the database session is not UTC', async () => {
    const result = await signIn(buildApp(), config, { subject: 'dev-customer-1' })
    expect(signInPath(result.location)).toMatchObject({ path: '/sign-in', error: 'service_unavailable' })
    expect(result.session).toBeUndefined()
    expect(await prisma.user.count()).toBe(0)
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
  })
})

describe('Stage 4A authentication', () => {
  beforeAll(() => {
    app = buildApp()
  })

  describe('migration', () => {
    it('created the auth tables with their integrity constraints', async () => {
      const constraints = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conrelid IN ('users'::regclass, 'auth_sessions'::regclass, 'audit_events'::regclass) AND contype = 'c'`
      expect(constraints.map((row) => row.conname).sort()).toEqual([
        'audit_events_action_format', 'auth_sessions_expiry_order', 'auth_sessions_revocation_complete', 'auth_sessions_token_hash_hex',
        'users_disabled_at_matches_status', 'users_display_name_not_blank', 'users_email_lowercase_format', 'users_identity_not_blank', 'users_role_matches_identity_pool',
      ])
      const status = await prismaCli(['migrate', 'status'], database.url)
      expect(status.stdout).toMatch(/5 migrations found/) // + 4B schedule_management, retire_obsolete_products, 4C booking_foundation
      expect(status.stdout).toMatch(/Database schema is up to date/)
    }, 120_000)
  })

  describe('customer sign-in', () => {
    it('registers a new customer with the CUSTOMER role and issues a secure session cookie', async () => {
      const result = await signIn(app, config, { subject: 'dev-customer-1', returnTo: '/account' })
      expect(result.location).toBe(`${PUBLIC_ORIGIN}/account`)
      expect(result.session).toMatch(/^[A-Za-z0-9_-]{43}$/)

      const cookie = findCookie(result.responses[3]!, 'diyf_sid')!
      expect(cookie.attributes).toMatch(/HttpOnly/)
      expect(cookie.attributes).toMatch(/SameSite=Lax/i)
      expect(cookie.attributes).toMatch(/Path=\//)
      expect(cookie.attributes).toMatch(/Max-Age=604800/) // 7-day absolute lifetime
      expect(cookie.attributes).not.toMatch(/Secure/) // plain http in local development
      expect(findCookie(result.responses[3]!, 'diyf_login')?.value).toBe('') // login state is single-use

      const user = await userBySubject('dev-customer-1')
      expect(user).toMatchObject({ identityPool: 'CUSTOMER', role: 'CUSTOMER', status: 'ACTIVE', email: 'test.customer.one@example.test', identityIssuer: DEV_ISSUERS.CUSTOMER })
      const session = await prisma.authSession.findFirstOrThrow({ where: { userId: user!.id } })
      expect(session.tokenHash).toBe(hashSessionToken(result.session!)) // only the hash is stored
      expect(JSON.stringify(session)).not.toContain(result.session!)
      expect(await prisma.auditEvent.count({ where: { action: 'CUSTOMER_REGISTERED', targetId: user!.id } })).toBe(1)
    })

    it('GET /auth/me returns the signed-in user and a CSRF token, never cached', async () => {
      const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
      const me = await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, session!))
      expect(me.status).toBe(200)
      expect(me.headers['cache-control']).toBe('no-store')
      expect(me.body.data.user).toEqual({ id: expect.any(String), email: 'test.customer.one@example.test', emailVerified: true, displayName: 'Test Customer One (DEV)', role: 'CUSTOMER', pool: 'CUSTOMER' })
      expect(me.body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(JSON.stringify(me.body)).not.toContain(session!)
    })

    it('reuses the same account on later sign-ins (no duplicates) and rotates the session', async () => {
      const first = await signIn(app, config, { subject: 'dev-customer-1' })
      const second = await signIn(app, config, { subject: 'dev-customer-1', existingSession: first.session! })
      expect(second.session).not.toBe(first.session)
      expect(await prisma.user.count({ where: { identitySubject: 'dev-customer-1' } })).toBe(1)
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, first.session!))).status).toBe(401)
      expect((await prisma.authSession.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(first.session!) } })).revokedReason).toBe('ROTATED')
    })

    it('sends sign-up to the provider’s registration screen', async () => {
      const start = await request(app).get('/api/v1/auth/register')
      expect(new URL(start.headers.location as string).searchParams.get('screen')).toBe('signup')
    })

    it('refuses identities whose email is not verified', async () => {
      const result = await signIn(app, config, { subject: 'dev-customer-unverified' })
      expect(signInPath(result.location)).toMatchObject({ path: '/sign-in', error: 'email_unverified' })
      expect(result.session).toBeUndefined()
      expect(await userBySubject('dev-customer-unverified')).toBeNull()
    })

    it.each([
      ['//evil.example/phish', '/account'],
      ['https://evil.example/', '/account'],
      ['/\\evil.example', '/account'],
      ['javascript:alert(1)', '/account'],
      ['/api/v1/auth/logout', '/account'],
      ['/account?tab=profile#top', '/account?tab=profile#top'],
    ])('sanitises returnTo %s → %s (no open redirect)', async (returnTo, expected) => {
      const result = await signIn(app, config, { subject: 'dev-customer-1', returnTo })
      expect(result.location).toBe(`${PUBLIC_ORIGIN}${expected}`)
    })
  })

  describe('callback validation', () => {
    it('rejects a callback without the login-state cookie (expired or forged start)', async () => {
      const res = await request(app).get('/api/v1/auth/callback?code=x&state=y')
      expect(signInPath(res.headers.location as string)).toMatchObject({ path: '/sign-in', error: 'login_expired' })
      expect(findCookie(res, 'diyf_sid')).toBeUndefined()
    })

    it('rejects a tampered login-state cookie', async () => {
      const result = await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => ({ ...s, loginCookie: `${s.loginCookie.slice(0, -2)}xx` }) })
      expect(signInPath(result.location).error).toBe('login_expired')
      expect(result.session).toBeUndefined()
    })

    it('rejects a state mismatch', async () => {
      const result = await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => ({ ...s, callbackPath: s.callbackPath.replace(/state=[^&]+/, 'state=forged') }) })
      expect(signInPath(result.location).error).toBe('invalid_state')
    })

    it('rejects a forged code and a replayed code', async () => {
      const forged = await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => ({ ...s, callbackPath: s.callbackPath.replace(/code=[^&]+/, 'code=eyJmb3JnZWQiOnRydWV9.AAAA') }) })
      expect(signInPath(forged.location).error).toBe('invalid_response')

      let captured = ''
      await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => { captured = s.callbackPath; return s } })
      // Replay the same (already used) code with a fresh, valid login cookie for a new attempt.
      const replay = await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => ({ ...s, callbackPath: captured.replace(/state=[^&]+/, s.callbackPath.match(/state=[^&]+/)![0]) }) })
      expect(signInPath(replay.location).error).toBe('invalid_response')
    })

    it('maps a provider "access_denied" (user cancelled) to a friendly error', async () => {
      const result = await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => ({ ...s, callbackPath: `/api/v1/auth/callback?error=access_denied&state=${new URL(s.callbackPath, PUBLIC_ORIGIN).searchParams.get('state')}` }) })
      expect(signInPath(result.location).error).toBe('cancelled')
    })

    it('rejects unexpected callback parameters', async () => {
      const result = await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => ({ ...s, callbackPath: `${s.callbackPath}&role=ADMIN` }) })
      expect(signInPath(result.location).error).toBe('invalid_response')
    })

    it('does not accept a customer-pool login on the admin callback', async () => {
      let customerAttempt = { callbackPath: '', loginCookie: '' }
      await signIn(app, config, { subject: 'dev-customer-1', tamper: (s) => { customerAttempt = s; return s } })
      const res = await request(app).get(customerAttempt.callbackPath.replace('/api/v1/auth/callback', '/api/v1/admin/auth/callback')).set('Cookie', `diyf_login=${encodeURIComponent(customerAttempt.loginCookie)}`)
      expect(signInPath(res.headers.location as string)).toMatchObject({ error: 'login_expired', pool: 'admin' })
    })
  })

  describe('sessions', () => {
    it('401s without a cookie, with garbage, and with an unknown token; clears unusable cookies', async () => {
      expect((await request(app).get('/api/v1/auth/me')).body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' })
      const garbage = await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, 'not-a-token'))
      expect(garbage.status).toBe(401)
      expect(findCookie(garbage, 'diyf_sid')?.value).toBe('')
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, 'A'.repeat(43)))).status).toBe(401)
    })

    it.each([
      ['idle', { idleExpiresAt: new Date(Date.now() - 1000) }],
      ['absolute', { absoluteExpiresAt: new Date(Date.now() - 1000), idleExpiresAt: new Date(Date.now() - 2000), createdAt: new Date(Date.now() - 10 * 86_400_000) }],
    ])('rejects a session past its %s expiry with "session expired"', async (_label, data) => {
      const { session } = await signIn(app, config, { subject: 'dev-customer-2' })
      await prisma.authSession.update({ where: { tokenHash: hashSessionToken(session!) }, data })
      const res = await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, session!))
      expect(res.status).toBe(401)
      expect(res.body.error.message).toBe('Your session has expired. Please sign in again.')
    })

    it('slides the idle expiry forward on use (never beyond the absolute limit)', async () => {
      const { session } = await signIn(app, config, { subject: 'dev-customer-2' })
      const hash = hashSessionToken(session!)
      await prisma.authSession.update({ where: { tokenHash: hash }, data: { lastSeenAt: new Date(Date.now() - 5 * 60_000), idleExpiresAt: new Date(Date.now() + 60_000) } })
      await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, session!))
      const after = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash: hash } })
      expect(after.idleExpiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 3_600_000) // 12 h idle policy
      expect(after.idleExpiresAt.getTime()).toBeLessThanOrEqual(after.absoluteExpiresAt.getTime())
    })
  })

  describe('logout and CSRF', () => {
    it('requires a CSRF token and an allowed Origin', async () => {
      const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
      const csrf = await csrfFor(app, config, session!)
      const cookie = withSession(config, session!)
      const attempts = [
        request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('Origin', PUBLIC_ORIGIN),
        request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', 'wrong'),
        request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', csrf),
        request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf), // no Origin, no Referer
      ]
      for (const attempt of attempts) {
        const res = await attempt
        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe('CSRF_FAILED')
      }
      // A CSRF token from another session does not work either.
      const other = await signIn(app, config, { subject: 'dev-customer-2' })
      const otherCsrf = await csrfFor(app, config, other.session!)
      expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', otherCsrf)).status).toBe(403)
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200) // still signed in
    })

    it('logs out: revokes the session, clears the cookie, and the old cookie stops working', async () => {
      const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
      const csrf = await csrfFor(app, config, session!)
      const res = await request(app).post('/api/v1/auth/logout').set('Cookie', withSession(config, session!)).set('Referer', `${PUBLIC_ORIGIN}/account`).set('X-CSRF-Token', csrf)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ data: { logoutUrl: null } }) // the dev provider has no provider-side session
      expect(findCookie(res, 'diyf_sid')?.value).toBe('')
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, session!))).status).toBe(401)
      expect((await prisma.authSession.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(session!) } })).revokedReason).toBe('LOGOUT')
    })

    it('requires a session to log out', async () => {
      expect((await request(app).post('/api/v1/auth/logout').set('Origin', PUBLIC_ORIGIN)).status).toBe(401)
    })
  })

  describe('own profile', () => {
    it('reads and updates only the signed-in user’s profile', async () => {
      const one = await signIn(app, config, { subject: 'dev-customer-1' })
      const two = await signIn(app, config, { subject: 'dev-customer-2' })
      const oneUser = await userBySubject('dev-customer-1')
      const csrf = await csrfFor(app, config, two.session!)

      // Customer two cannot address customer one: ids in the query are ignored, no id-based routes exist.
      const profile = await request(app).get(`/api/v1/me/profile?userId=${oneUser!.id}`).set('Cookie', withSession(config, two.session!))
      expect(profile.body.data.email).toBe('test.customer.two@example.test')
      expect((await request(app).get(`/api/v1/users/${oneUser!.id}`).set('Cookie', withSession(config, two.session!))).status).toBe(404)

      const updated = await request(app).patch('/api/v1/me/profile').set('Cookie', withSession(config, two.session!)).set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', csrf).send({ displayName: '  Ana  ' })
      expect(updated.status).toBe(200)
      expect(updated.body.data).toMatchObject({ displayName: 'Ana', email: 'test.customer.two@example.test', role: 'CUSTOMER' })
      expect((await userBySubject('dev-customer-1'))!.displayName).toBe('Test Customer One (DEV)')
      expect(await prisma.auditEvent.count({ where: { action: 'PROFILE_UPDATED' } })).toBe(1)
      expect((await request(app).get('/api/v1/me/profile').set('Cookie', withSession(config, one.session!))).body.data.displayName).toBe('Test Customer One (DEV)')
    })

    it.each([
      ['a role change', { displayName: 'x', role: 'ADMIN' }, /unknown field\(s\): role/],
      ['an email change', { email: 'new@example.test' }, /unknown field\(s\): email/],
      ['a pool change', { displayName: 'x', pool: 'ADMIN' }, /pool/],
      ['a blank name', { displayName: '   ' }, /must not be blank/],
      ['an over-long name', { displayName: 'x'.repeat(81) }, /at most 80/],
    ])('rejects %s (400) and changes nothing', async (_label, body, message) => {
      const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
      const csrf = await csrfFor(app, config, session!)
      const res = await request(app).patch('/api/v1/me/profile').set('Cookie', withSession(config, session!)).set('Origin', PUBLIC_ORIGIN).set('X-CSRF-Token', csrf).send(body)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(message) })
      expect(await userBySubject('dev-customer-1')).toMatchObject({ role: 'CUSTOMER', identityPool: 'CUSTOMER', email: 'test.customer.one@example.test' })
    })

    it('requires sign-in and CSRF', async () => {
      expect((await request(app).get('/api/v1/me/profile')).status).toBe(401)
      const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
      expect((await request(app).patch('/api/v1/me/profile').set('Cookie', withSession(config, session!)).set('Origin', PUBLIC_ORIGIN).send({ displayName: 'x' })).status).toBe(403)
    })
  })

  describe('admin access', () => {
    it('refuses an admin-pool identity that has not been provisioned, creates nothing, and audits it', async () => {
      const result = await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })
      expect(signInPath(result.location)).toMatchObject({ path: '/sign-in', error: 'not_authorized', pool: 'admin' })
      expect(result.session).toBeUndefined()
      expect(await userBySubject('dev-admin-1')).toBeNull()
      const denied = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'ADMIN_SIGN_IN_DENIED' } })
      expect(JSON.stringify(denied)).not.toMatch(/dev-admin-1|example\.test/) // identity stored as an opaque hash
    })

    it('denies admin endpoints to anonymous (401) and customer (403) sessions', async () => {
      expect((await request(app).get('/api/v1/admin/me')).status).toBe(401)
      const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
      const res = await request(app).get('/api/v1/admin/me').set('Cookie', withSession(config, session!)).set('X-Role', 'ADMIN')
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    })

    it('admits a provisioned admin through the admin pool, with the shorter admin session', async () => {
      expect(await admin(['grant', '--dev-identity', 'dev-admin-1'])).toMatch(/^Provisioned admin: .* pool=ADMIN {2}role=ADMIN {2}status=ACTIVE/)
      const result = await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })
      expect(result.location).toBe(`${PUBLIC_ORIGIN}/admin`)
      expect(findCookie(result.responses[3]!, 'diyf_sid')!.attributes).toMatch(/Max-Age=43200/) // 12 h absolute
      const res = await request(app).get('/api/v1/admin/me').set('Cookie', withSession(config, result.session!))
      expect(res.status).toBe(200)
      expect(res.body.data.user).toMatchObject({ role: 'ADMIN', pool: 'ADMIN', email: 'test.admin@example.test' })
      expect(await prisma.auditEvent.count({ where: { action: { in: ['ADMIN_GRANTED', 'ADMIN_SIGNED_IN'] } } })).toBe(2)
    })

    it('never makes a customer-pool account an admin (database CHECK + CLI refusal)', async () => {
      const customer = await userBySubject('dev-customer-1')
      await expect(prisma.user.update({ where: { id: customer!.id }, data: { role: 'ADMIN' } })).rejects.toThrow(/users_role_matches_identity_pool/)
      await expect(createAuthRepository(prisma).grantAdmin({ issuer: DEV_ISSUERS.CUSTOMER, subject: 'dev-customer-1', email: 'x@example.test', displayName: null, actorLabel: 'test' })).rejects.toThrow(/customer pool/)
      expect(await userBySubject('dev-customer-1')).toMatchObject({ role: 'CUSTOMER', identityPool: 'CUSTOMER' })
    })

    it('keeps accounts with the same email in the two pools separate (no automatic linking)', async () => {
      // dev-admin-unprovisioned uses Test Customer One's email but is never provisioned.
      const result = await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-unprovisioned' })
      expect(signInPath(result.location).error).toBe('not_authorized')
      expect(await prisma.user.count({ where: { email: 'test.customer.one@example.test' } })).toBe(1)
      await admin(['grant', '--dev-identity', 'dev-admin-unprovisioned'])
      const users = await prisma.user.findMany({ where: { email: 'test.customer.one@example.test' }, orderBy: { identityPool: 'asc' } })
      expect(users.map((u) => [u.identityPool, u.role])).toEqual([['CUSTOMER', 'CUSTOMER'], ['ADMIN', 'ADMIN']])
      // The customer's session still cannot reach admin endpoints.
      const customer = await signIn(app, config, { subject: 'dev-customer-1' })
      expect((await request(app).get('/api/v1/admin/me').set('Cookie', withSession(config, customer.session!))).status).toBe(403)
      await admin(['disable', '--user-id', users[1]!.id])
    })

    it('rejects an admin session whose issuer no longer matches the configured admin pool', async () => {
      const result = await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })
      const otherPool = { ...createDevProvider('ADMIN', config.sessionSecret, PUBLIC_ORIGIN), issuer: 'urn:replaced-admin-pool' }
      const swapped = buildApp({ providers: { CUSTOMER: createDevProvider('CUSTOMER', config.sessionSecret, PUBLIC_ORIGIN), ADMIN: otherPool } })
      expect((await request(swapped).get('/api/v1/admin/me').set('Cookie', withSession(config, result.session!))).status).toBe(401)
    })
  })

  describe('account disablement (operator CLI)', () => {
    it('disables an account: all its sessions stop working and new sign-ins are refused; enable restores access', async () => {
      const a = await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })
      const b = await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })
      const adminUser = await userBySubject('dev-admin-1')
      expect(await admin(['disable', '--user-id', adminUser!.id])).toMatch(/Disabled: .*status=DISABLED .*\(revoked \d+ session\(s\)\)/)
      for (const token of [a.session!, b.session!]) expect((await request(app).get('/api/v1/admin/me').set('Cookie', withSession(config, token))).status).toBe(401)
      expect(signInPath((await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })).location).error).toBe('account_disabled')
      expect(await prisma.auditEvent.count({ where: { action: 'ACCOUNT_DISABLED', targetId: adminUser!.id } })).toBe(1)

      await admin(['enable', '--user-id', adminUser!.id])
      expect((await signIn(app, config, { pool: 'ADMIN', subject: 'dev-admin-1' })).session).toBeTruthy()
    })

    it('revokes every session of a customer on request', async () => {
      const one = await signIn(app, config, { subject: 'dev-customer-2' })
      const customer = await userBySubject('dev-customer-2')
      expect(await admin(['revoke-sessions', '--user-id', customer!.id])).toMatch(/Revoked \d+ session\(s\)/)
      expect((await request(app).get('/api/v1/auth/me').set('Cookie', withSession(config, one.session!))).status).toBe(401)
    })

    it('rejects malformed operator commands', async () => {
      await expect(admin(['disable'])).rejects.toThrow(/--user-id/)
      await expect(admin(['grant', '--subject', 'x'])).rejects.toThrow(/AUTH_MODE=cognito|--email/)
      await expect(admin(['promote', '--user-id', 'x'])).rejects.toThrow(/Operator commands/)
      expect(await admin(['find', '--email', 'TEST.CUSTOMER.ONE@example.test'])).toMatch(/pool=CUSTOMER/)
    })
  })

  describe('failure handling', () => {
    it('reports sign-in unavailable when auth is disabled', async () => {
      const disabled = buildApp({ authConfig: loadAuthConfig({}, { nodeEnv: 'test', corsOrigins: [PUBLIC_ORIGIN] }) })
      const start = await request(disabled).get('/api/v1/auth/login')
      expect(start.status).toBe(303)
      expect(start.headers.location).toBe('/sign-in?error=auth_unavailable')
      expect((await request(disabled).get('/api/v1/auth/me')).body.error.code).toBe('AUTH_UNAVAILABLE')
      expect((await request(disabled).get('/api/v1/admin/me')).status).toBe(503)
    })

    it('returns a client-safe 503 when the session store fails, and logs the cause server-side only', async () => {
      const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
      const lines: LoggedLine[] = []
      const broken = createAuthRepository(prisma)
      broken.findSession = () => Promise.reject(new Error('connect ECONNREFUSED postgresql://app:hunter2@db/diy'))
      const res = await request(buildApp({ repository: broken, lines })).get('/api/v1/auth/me').set('Cookie', withSession(config, session!))
      expect(res.status).toBe(503)
      expect(res.body.error).toMatchObject({ code: 'AUTH_UNAVAILABLE', message: expect.stringMatching(/temporarily unavailable/) })
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|ECONNREFUSED|postgresql/)
      expect(JSON.stringify(lines)).toMatch(/ECONNREFUSED/)
    })

    it('redirects to the sign-in error page when the database fails during the callback', async () => {
      const broken = createAuthRepository(prisma)
      broken.signInCustomer = () => Promise.reject(new Error('db down'))
      const result = await signIn(buildApp({ repository: broken }), config, { subject: 'dev-customer-1' })
      expect(signInPath(result.location).error).toBe('service_unavailable')
    })

    it('rate-limits sign-in attempts with 429 and Retry-After', async () => {
      const limited = buildApp({ authConfig: { ...config, rateLimit: { windowMinutes: 1, max: 2 } } })
      expect((await request(limited).get('/api/v1/auth/login')).status).toBe(303)
      expect((await request(limited).get('/api/v1/auth/login')).status).toBe(303)
      const blocked = await request(limited).get('/api/v1/auth/login')
      expect(blocked.status).toBe(429)
      expect(blocked.body.error.code).toBe('RATE_LIMITED')
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    })
  })

  describe('log hygiene', () => {
    beforeEach(() => {
      logLines.length = 0
    })

    it('never writes session tokens, CSRF tokens, codes or login state to logs', async () => {
      const lines: LoggedLine[] = []
      const logged = buildApp({ lines })
      const secrets: string[] = []
      const result = await signIn(logged, config, { subject: 'dev-customer-1', tamper: (s) => { secrets.push(s.loginCookie, new URL(s.callbackPath, PUBLIC_ORIGIN).searchParams.get('code')!); return s } })
      secrets.push(result.session!, await csrfFor(logged, config, result.session!))
      // Provoke error logging too.
      await signIn(logged, config, { subject: 'dev-customer-1', tamper: (s) => ({ ...s, callbackPath: s.callbackPath.replace(/code=[^&]+/, 'code=zz.zz') }) })
      const text = JSON.stringify(lines)
      expect(lines.length).toBeGreaterThan(0)
      for (const secret of secrets) expect(text).not.toContain(secret)
    })
  })

  it('leaves the public catalog working for signed-in and anonymous visitors', async () => {
    const { session } = await signIn(app, config, { subject: 'dev-customer-1' })
    expect((await request(app).get('/api/v1/health').set('Cookie', withSession(config, session!))).status).toBe(200)
    expect((await request(app).get('/api/v1/products')).status).toBe(503) // no catalog repository in this app: unchanged behaviour
  })
})
