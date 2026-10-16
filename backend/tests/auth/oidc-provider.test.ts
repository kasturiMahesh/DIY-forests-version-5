// The real OIDC client (openid-client), exercised against a local fake OpenID Provider that signs
// ID tokens with throwaway keys. No Cognito, network access or real credentials are involved.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { IdentityProviderError, type IdentityProvider } from '../../src/modules/auth/identity-provider.js'
import { createOidcProvider } from '../../src/modules/auth/oidc-provider.js'

const CLIENT_ID = 'test-client'
const CLIENT_SECRET = randomBytes(24).toString('base64url')
const REDIRECT_URI = 'http://localhost:5173/api/v1/auth/callback'

type IssuedCode = { challenge: string; nonce: string; redirectUri: string }
type TokenPlan = (claims: Record<string, unknown>) => Record<string, unknown>

let server: Server
let issuer = ''
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let signingKey: PrivateKey
let otherKey: PrivateKey
let jwk: JWK
let discoveryUp = true
let useOtherKey = false
let tokenPlan: TokenPlan = (claims) => claims
const codes = new Map<string, IssuedCode>()

async function idToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000)
  const final = tokenPlan({ iss: issuer, aud: CLIENT_ID, sub: 'user-123', email: 'Person@Example.TEST', email_verified: true, name: 'Pat Person', iat: now, exp: now + 300, ...claims })
  return new SignJWT(final).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(useOtherKey ? otherKey : signingKey)
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  signingKey = pair.privateKey
  otherKey = (await generateKeyPair('RS256')).privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }

  server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer)
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/.well-known/openid-configuration') {
      if (!discoveryUp) return json(503, { error: 'down' })
      return json(200, {
        issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] })
    if (url.pathname === '/oauth2/token' && req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const form = new URLSearchParams(raw)
      // RFC 6749 §2.3.1: client id and secret are form-urlencoded, joined with ":", then Base64.
      const [id = '', secret = ''] = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8').split(':').map((part) => decodeURIComponent(part.replace(/\+/g, ' ')))
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' })
      const issued = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '') // single use
      const verifier = form.get('code_verifier') ?? ''
      if (!issued || issued.redirectUri !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== issued.challenge) {
        return json(400, { error: 'invalid_grant' })
      }
      return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: await idToken({ nonce: issued.nonce }) })
    }
    json(404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  discoveryUp = true
  useOtherKey = false
  tokenPlan = (claims) => claims
})

const provider = (): IdentityProvider => createOidcProvider('CUSTOMER', { issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, loginOrigin: issuer }, { allowInsecureRequests: true })

/** Start a login, let the fake provider "authenticate" the user, and return the callback inputs. */
async function authorize(client: IdentityProvider) {
  const start = await client.beginLogin({ redirectUri: REDIRECT_URI, screen: 'signin' })
  const url = new URL(start.url)
  const code = randomBytes(16).toString('hex')
  codes.set(code, { challenge: url.searchParams.get('code_challenge')!, nonce: url.searchParams.get('nonce')!, redirectUri: url.searchParams.get('redirect_uri')! })
  const callbackUrl = new URL(`${REDIRECT_URI}?code=${code}&state=${url.searchParams.get('state')}`)
  return { start, url, callbackUrl, complete: (overrides: Partial<{ state: string; nonce: string; codeVerifier: string; callbackUrl: URL }> = {}) =>
    client.completeLogin({ callbackUrl, redirectUri: REDIRECT_URI, state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier, ...overrides }) }
}

/** Every message in the error's cause chain, so a test proves *why* validation failed. */
function causeText(error: unknown): string {
  const parts: string[] = []
  for (let current = error; current instanceof Error; current = current.cause) parts.push(current.message)
  return parts.join(' <- ')
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityProviderError)
    return error as IdentityProviderError
  }
  throw new Error('expected an IdentityProviderError')
}

describe('OIDC provider (authorization code + PKCE)', () => {
  it('builds a standards-compliant authorization request', async () => {
    const { url, start } = await authorize(provider())
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/oauth2/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, scope: 'openid email profile', code_challenge_method: 'S256', state: start.state, nonce: start.nonce,
    })
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(start.codeVerifier).digest('base64url'))
  })

  it('verifies the ID token and returns the identity (email lower-cased)', async () => {
    const { complete } = await authorize(provider())
    expect(await complete()).toEqual({ issuer, subject: 'user-123', email: 'person@example.test', emailVerified: true, name: 'Pat Person' })
  })

  it('accepts Cognito-style string email_verified', async () => {
    tokenPlan = (claims) => ({ ...claims, email_verified: 'true' })
    const { complete } = await authorize(provider())
    expect((await complete()).emailVerified).toBe(true)
  })

  it.each<[string, () => void, RegExp]>([
    ['a token signed by an unknown key', () => { useOtherKey = true }, /JWT signature verification failed/],
    ['the wrong issuer', () => { tokenPlan = (c) => ({ ...c, iss: 'https://evil.example' }) }, /"iss" \(issuer\)/],
    ['the wrong audience', () => { tokenPlan = (c) => ({ ...c, aud: 'someone-else' }) }, /"aud" \(audience\)/],
    ['an expired token', () => { tokenPlan = (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }) }, /"exp" \(expiration time\)/],
    ['a mismatched nonce', () => { tokenPlan = (c) => ({ ...c, nonce: 'replayed-nonce' }) }, /"nonce" claim/],
    ['a token without an email', () => { tokenPlan = (c) => { const { email: _email, ...rest } = c; return rest } }, /missing sub or email/],
  ])('rejects %s (for that specific reason)', async (_label, arrange, reason) => {
    arrange()
    const { complete } = await authorize(provider())
    const error = await rejection(complete())
    expect(error.reason).toBe('invalid_response')
    expect(causeText(error)).toMatch(reason)
  })

  it('rejects a wrong PKCE verifier (the provider refuses the code)', async () => {
    const { complete } = await authorize(provider())
    const error = await rejection(complete({ codeVerifier: randomBytes(32).toString('base64url') }))
    expect(error.reason).toBe('invalid_response')
    expect(causeText(error)).toMatch(/invalid_grant|response body/)
  })

  it('rejects a state that does not match the login attempt', async () => {
    const { complete } = await authorize(provider())
    expect((await rejection(complete({ state: 'some-other-state' }))).reason).toBe('invalid_response')
  })

  it('rejects a replayed authorization code', async () => {
    const client = provider()
    const { complete } = await authorize(client)
    await complete()
    expect((await rejection(complete())).reason).toBe('invalid_response')
  })

  it('reports an unreachable provider as unavailable, then recovers', async () => {
    discoveryUp = false
    const client = provider()
    expect((await rejection(client.beginLogin({ redirectUri: REDIRECT_URI, screen: 'signin' }))).reason).toBe('unavailable')
    discoveryUp = true
    await expect(client.beginLogin({ redirectUri: REDIRECT_URI, screen: 'signin' })).resolves.toMatchObject({ url: expect.stringContaining('/oauth2/authorize') })
  })

  it('uses the managed-login /signup screen and builds the /logout URL', async () => {
    const client = provider()
    const signup = await client.beginLogin({ redirectUri: REDIRECT_URI, screen: 'signup' })
    expect(new URL(signup.url).pathname).toBe('/signup')
    expect(client.logoutUrl('https://www.example.test/')).toBe(`${issuer}/logout?client_id=${CLIENT_ID}&logout_uri=https%3A%2F%2Fwww.example.test%2F`)
  })
})
