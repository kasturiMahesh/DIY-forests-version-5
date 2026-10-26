import * as oidc from 'openid-client'
import type { IdentityPoolName, OidcClientConfig } from '../../config/auth.js'
import { IdentityProviderError, type IdentityProvider, type VerifiedIdentity } from './identity-provider.js'

export type OidcProviderOptions = {
  /** Tests only: allow http:// issuers (a local fake OpenID Provider). Never set from configuration. */
  allowInsecureRequests?: boolean
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * Standard OIDC authorization-code flow with PKCE (openid-client), used for Amazon Cognito user
 * pools. openid-client validates state, nonce, PKCE, the ID token signature (issuer JWKS), `iss`,
 * `aud`, `exp` and `iat`. Discovery is lazy and retried after a failure.
 */
export function createOidcProvider(pool: IdentityPoolName, settings: OidcClientConfig, options: OidcProviderOptions = {}): IdentityProvider {
  let configuration: Promise<oidc.Configuration> | null = null
  const discover = () => {
    configuration ??= oidc
      .discovery(new URL(settings.issuer), settings.clientId, undefined, oidc.ClientSecretBasic(settings.clientSecret), {
        // By default openid-client trusts ID tokens from the token endpoint on the strength of TLS
        // alone (allowed by OIDC Core 3.1.3.7). We also verify the JWS signature against the
        // issuer's JWKS (fetched and cached), so a forged or mis-routed token is still rejected.
        execute: [oidc.enableNonRepudiationChecks, ...(options.allowInsecureRequests ? [oidc.allowInsecureRequests] : [])],
        timeout: 10,
      })
      .catch((error: unknown) => {
        configuration = null // retry discovery on the next attempt
        throw new IdentityProviderError('unavailable', 'Identity provider discovery failed', { cause: error })
      })
    return configuration
  }

  return {
    pool,
    issuer: settings.issuer,

    async beginLogin({ redirectUri, screen }) {
      const config = await discover()
      const state = oidc.randomState()
      const nonce = oidc.randomNonce()
      const codeVerifier = oidc.randomPKCECodeVerifier()
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      })
      // Cognito managed login serves sign-up at /signup on the same domain with the same parameters.
      if (screen === 'signup' && url.origin === settings.loginOrigin && url.pathname === '/oauth2/authorize') url.pathname = '/signup'
      return { url: url.href, state, nonce, codeVerifier }
    },

    async completeLogin({ callbackUrl, state, nonce, codeVerifier }): Promise<VerifiedIdentity> {
      const config = await discover()
      let claims: oidc.IDToken | undefined
      try {
        const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, { pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true })
        claims = tokens.claims()
      } catch (error) {
        // Network-level failures vs. anything the provider (or a forger) sent that failed validation.
        const unreachable = error instanceof TypeError || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
        throw new IdentityProviderError(unreachable ? 'unavailable' : 'invalid_response', 'Authorization code exchange failed', { cause: error })
      }
      const subject = asString(claims?.sub)
      const email = asString(claims?.email)?.toLowerCase() ?? null
      if (!claims || !subject || !email) throw new IdentityProviderError('invalid_response', 'ID token is missing sub or email')
      return {
        issuer: settings.issuer,
        subject,
        email,
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        name: asString(claims.name) ?? asString(claims.given_name),
      }
    },

    logoutUrl(returnTo) {
      const url = new URL('/logout', settings.loginOrigin)
      url.searchParams.set('client_id', settings.clientId)
      url.searchParams.set('logout_uri', returnTo)
      return url.href
    },
  }
}
