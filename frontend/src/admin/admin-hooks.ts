import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/auth-context'

/** A user-facing message for a failed admin request: the server's own validation text for 400/404/409. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http' && error.details.status && [400, 404, 409].includes(error.details.status)) return error.message
  if (error instanceof ApiError && error.details.status === 403) return 'You no longer have access to this. Please sign in again.'
  return 'Something went wrong. Please try again.'
}

export type Load<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; message: string }

/** Loads data for a panel; a 401 ends the session in the UI (the page then asks to sign in again). */
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const { sessionExpired } = useAuth()
  const [state, setState] = useState<Load<T>>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState({ state: 'loading' })
    loader(controller.signal).then(
      (data) => setState({ state: 'ready', data }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.details.status === 401) return sessionExpired()
        setState({ state: 'error', message: errorText(error) })
      },
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt])
  return [state, useCallback(() => setAttempt((count) => count + 1), [])]
}

/** Runs one mutation at a time (no duplicate submissions) and reports success or a readable error. */
export function useAction() {
  const { sessionExpired } = useAuth()
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const busy = useRef(false)
  const run = useCallback(async (work: () => Promise<unknown>, success: string): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    setPending(true)
    setNotice(null)
    try {
      await work()
      setNotice({ kind: 'ok', text: success })
      return true
    } catch (error) {
      if (error instanceof ApiError && error.details.status === 401) sessionExpired()
      else setNotice({ kind: 'error', text: errorText(error) })
      return false
    } finally {
      busy.current = false
      setPending(false)
    }
  }, [sessionExpired])
  return { pending, notice, setNotice, run }
}
