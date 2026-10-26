import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, api as defaultApi, type ApiClient } from '../api/client'
import type { MeResponse } from '../api/types'
import { AuthContext, type AuthState, type AuthStatus } from './auth-context'

type Snapshot = { status: AuthStatus; me: MeResponse | null; expired: boolean }

/** Loads the signed-in state once from GET /auth/me; protected pages call `sessionExpired` on a 401. */
export function AuthProvider({ children, client = defaultApi, navigate = (url: string) => window.location.assign(url) }: {
  children: ReactNode
  client?: ApiClient
  /** Full-page navigation (overridable in tests). */
  navigate?: (url: string) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<Snapshot>({ status: 'loading', me: null, expired: false })

  useEffect(() => {
    const controller = new AbortController()
    client.getMe(controller.signal).then(
      (me) => setSnapshot({ status: 'signed-in', me, expired: false }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.details.status === 401) {
          setSnapshot((current) => ({ status: 'signed-out', me: null, expired: current.expired || error.details.code === 'UNAUTHENTICATED' && /expired/i.test(error.message) }))
        } else if (error instanceof ApiError && error.details.status === 503) {
          setSnapshot({ status: 'unavailable', me: null, expired: false })
        } else {
          setSnapshot({ status: 'error', me: null, expired: false })
        }
      },
    )
    return () => controller.abort()
  }, [client, attempt])

  const refresh = useCallback(() => {
    setSnapshot((current) => ({ ...current, status: 'loading' }))
    setAttempt((count) => count + 1)
  }, [])

  const sessionExpired = useCallback(() => setSnapshot({ status: 'signed-out', me: null, expired: true }), [])

  const signOut = useCallback(async () => {
    const csrf = snapshot.me?.csrfToken
    if (!csrf) return
    try {
      const { logoutUrl } = await client.logout(csrf)
      setSnapshot({ status: 'signed-out', me: null, expired: false })
      // Also end the identity provider's own session, then land on the home page.
      navigate(logoutUrl ?? '/')
    } catch (error) {
      if (error instanceof ApiError && error.details.status === 401) {
        setSnapshot({ status: 'signed-out', me: null, expired: false }) // already signed out on the server
        navigate('/')
        return
      }
      throw error // the caller shows "could not sign out"; the session is still active
    }
  }, [client, navigate, snapshot.me])

  const value = useMemo<AuthState>(() => ({ ...snapshot, refresh, sessionExpired, signOut }), [snapshot, refresh, sessionExpired, signOut])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
