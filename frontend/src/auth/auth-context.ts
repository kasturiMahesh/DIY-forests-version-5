import { createContext, useContext } from 'react'
import type { MeResponse } from '../api/types'

/**
 * - loading:     asking the server who is signed in.
 * - signed-out:  no valid session (`expired` tells whether one just ran out).
 * - signed-in:   `me` holds the account, the session kind and the CSRF token.
 * - unavailable: sign-in is not configured or temporarily down (503).
 * - error:       the server could not be reached or answered unexpectedly.
 */
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in' | 'unavailable' | 'error'

export type AuthState = {
  status: AuthStatus
  me: MeResponse | null
  expired: boolean
  refresh: () => void
  /** Call when any protected request answers 401: the session ended on the server. */
  sessionExpired: () => void
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState>({
  status: 'loading', me: null, expired: false, refresh: () => {}, sessionExpired: () => {}, signOut: async () => {},
})

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

/** Admin rights are decided by the server; this only mirrors what /auth/me reported for display. */
export const isAdminSession = (state: AuthState) => state.status === 'signed-in' && state.me?.session.kind === 'ADMIN' && state.me.user.role === 'ADMIN'
