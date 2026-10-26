import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { IdentityPoolName } from '../../config/auth.js'
import { IdentityProviderError, type IdentityProvider } from './identity-provider.js'
import { safeEqual } from './session.js'

/**
 * LOCAL DEVELOPMENT AND TESTS ONLY. A fake identity provider with clearly labelled test identities.
 * It goes through the same flow as the real one (state, nonce and PKCE are all checked), and it
 * never decides roles: admins still need a provisioned ADMIN row in PostgreSQL.
 * src/config/auth.ts refuses AUTH_MODE=dev outside NODE_ENV=development without AUTH_DEV_LOGIN=true.
 */
export const DEV_ISSUERS: Record<IdentityPoolName, string> = {
  CUSTOMER: 'urn:diy-forests:dev-only:customer-pool',
  ADMIN: 'urn:diy-forests:dev-only:admin-pool',
}

export type DevIdentity = { subject: string; email: string; emailVerified: boolean; name: string; note: string }

export const DEV_IDENTITIES: Record<IdentityPoolName, readonly DevIdentity[]> = {
  CUSTOMER: [
    { subject: 'dev-customer-1', email: 'test.customer.one@example.test', emailVerified: true, name: 'Test Customer One (DEV)', note: 'Verified test customer' },
    { subject: 'dev-customer-2', email: 'test.customer.two@example.test', emailVerified: true, name: 'Test Customer Two (DEV)', note: 'Second customer, for cross-account checks' },
    { subject: 'dev-customer-unverified', email: 'test.unverified@example.test', emailVerified: false, name: 'Unverified Customer (DEV)', note: 'Email not verified: sign-in is refused' },
  ],
  ADMIN: [
    { subject: 'dev-admin-1', email: 'test.admin@example.test', emailVerified: true, name: 'Test Admin (DEV)', note: 'Must be provisioned first: npm run admin -- grant --dev-identity dev-admin-1' },
    { subject: 'dev-admin-unprovisioned', email: 'test.customer.one@example.test', emailVerified: true, name: 'Unprovisioned Staff (DEV)', note: 'Same email as Test Customer One; never provisioned, so refused' },
  ],
}

export const DEV_AUTHORIZE_PATH = '/api/v1/auth/dev/authorize'
const CODE_TTL_MS = 60_000

type CodePayload = { pool: IdentityPoolName; subject: string; nonce: string; challenge: string; redirectUri: string; expiresAt: number; id: string }

const s256 = (verifier: string) => createHash('sha256').update(verifier, 'ascii').digest('base64url')
const random = () => randomBytes(32).toString('base64url')

export type DevProvider = IdentityProvider & {
  /** Issues the one-time code for a chosen test identity (used by the dev sign-in page). */
  issueCode(input: { subject: string; nonce: string; challenge: string; redirectUri: string }): string
}

export function createDevProvider(pool: IdentityPoolName, secret: Buffer, publicOrigin: string): DevProvider {
  const usedCodes = new Set<string>() // single use; memory is fine for a local dev tool
  const sign = (payload: string) => createHmac('sha256', secret).update(`dev-code:${pool}:${payload}`).digest('base64url')

  return {
    pool,
    issuer: DEV_ISSUERS[pool],

    async beginLogin({ redirectUri, screen }) {
      const state = random()
      const nonce = random()
      const codeVerifier = random()
      const url = new URL(DEV_AUTHORIZE_PATH, publicOrigin)
      for (const [key, value] of Object.entries({ pool, redirect_uri: redirectUri, state, nonce, code_challenge: s256(codeVerifier), code_challenge_method: 'S256', screen })) {
        url.searchParams.set(key, value)
      }
      return { url: url.href, state, nonce, codeVerifier }
    },

    issueCode({ subject, nonce, challenge, redirectUri }) {
      if (!DEV_IDENTITIES[pool].some((identity) => identity.subject === subject)) throw new Error('Unknown dev identity')
      const payload: CodePayload = { pool, subject, nonce, challenge, redirectUri, expiresAt: Date.now() + CODE_TTL_MS, id: random() }
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
      return `${encoded}.${sign(encoded)}`
    },

    async completeLogin({ callbackUrl, redirectUri, state, nonce, codeVerifier }) {
      const invalid = (why: string) => new IdentityProviderError('invalid_response', `Dev login rejected: ${why}`)
      if (callbackUrl.searchParams.get('state') !== state) throw invalid('state mismatch')
      const code = callbackUrl.searchParams.get('code') ?? ''
      const [encoded, signature] = code.split('.')
      if (!encoded || !signature || !safeEqual(signature, sign(encoded))) throw invalid('bad code signature')
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CodePayload
      if (payload.expiresAt <= Date.now()) throw invalid('code expired')
      if (usedCodes.has(payload.id)) throw invalid('code already used')
      if (payload.pool !== pool || payload.redirectUri !== redirectUri) throw invalid('code issued for another client')
      if (!safeEqual(payload.nonce, nonce)) throw invalid('nonce mismatch')
      if (!safeEqual(payload.challenge, s256(codeVerifier))) throw invalid('PKCE verifier mismatch')
      usedCodes.add(payload.id)
      const identity = DEV_IDENTITIES[pool].find((candidate) => candidate.subject === payload.subject)
      if (!identity) throw invalid('unknown identity')
      return { issuer: DEV_ISSUERS[pool], subject: identity.subject, email: identity.email, emailVerified: identity.emailVerified, name: identity.name }
    },

    logoutUrl: () => null,
  }
}
