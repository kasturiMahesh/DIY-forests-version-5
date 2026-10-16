import type { IdentityPoolName } from '../../config/auth.js'

/** An identity the provider has proven (signature, issuer, audience, expiry, nonce all checked). */
export type VerifiedIdentity = {
  issuer: string
  subject: string
  email: string
  emailVerified: boolean
  name: string | null
}

/** Secrets for one login attempt; kept server-side in the signed, HttpOnly login-state cookie. */
export type LoginStart = { url: string; state: string; nonce: string; codeVerifier: string }

export type LoginCompletion = {
  /** The callback URL as registered with the provider, plus the query string received. */
  callbackUrl: URL
  redirectUri: string
  state: string
  nonce: string
  codeVerifier: string
}

/**
 * One identity pool behind standard OIDC (authorization code + PKCE). Implementations: the OIDC
 * client used for Amazon Cognito (oidc-provider.ts) and the guarded local dev provider.
 */
export interface IdentityProvider {
  readonly pool: IdentityPoolName
  readonly issuer: string
  beginLogin(options: { redirectUri: string; screen: 'signin' | 'signup' }): Promise<LoginStart>
  completeLogin(options: LoginCompletion): Promise<VerifiedIdentity>
  /** Provider sign-out URL that returns to `returnTo`, or null when the provider has none. */
  logoutUrl(returnTo: string): string | null
}

/**
 * - unavailable:      the provider could not be reached (network, discovery, timeouts).
 * - invalid_response: the provider's answer failed validation (state, nonce, PKCE, signature, issuer,
 *                     audience, expiry, missing claims) or the code was rejected.
 */
export class IdentityProviderError extends Error {
  override name = 'IdentityProviderError'
  readonly reason: 'unavailable' | 'invalid_response'

  constructor(reason: 'unavailable' | 'invalid_response', message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.reason = reason
  }
}

export type IdentityProviders = Record<IdentityPoolName, IdentityProvider>
