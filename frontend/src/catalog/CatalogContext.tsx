import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api as defaultApi, type ApiClient } from '../api/client'
import { CatalogContext, type CatalogState } from './catalog-context'

/** Loads the public catalog once for the whole app; `retry` reloads after an error. */
export function CatalogProvider({ children, client = defaultApi }: { children: ReactNode; client?: ApiClient }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<Omit<CatalogState, 'retry'>>({ status: 'loading', products: [], nextWebinar: null })

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      client.listProducts({ signal: controller.signal }),
      client.listSessions({ type: 'WEBINAR', limit: 1 }, controller.signal),
    ]).then(
      ([products, { sessions }]) => setState({ status: 'ready', products, nextWebinar: sessions[0] ?? null }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        console.warn('Catalog could not be loaded; showing fallback content.', error)
        setState({ status: 'error', products: [], nextWebinar: null })
      },
    )
    return () => controller.abort()
  }, [client, attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading', products: [], nextWebinar: null })
    setAttempt((count) => count + 1)
  }, [])

  const value = useMemo(() => ({ ...state, retry }), [state, retry])
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
}
