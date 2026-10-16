import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api as defaultApi, type ApiClient } from '../api/client'
import { CatalogContext, type CatalogState } from './catalog-context'

const EMPTY = { products: [], nextWebinar: null, workshopBatches: [], trainingCohorts: [] }
const EMPTY_LOADING_STATE = { status: 'loading' as const, ...EMPTY }

/** Loads the public catalog once for the whole app; `retry` reloads after an error. */
export function CatalogProvider({ children, client = defaultApi }: { children: ReactNode; client?: ApiClient }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<Omit<CatalogState, 'retry'>>(EMPTY_LOADING_STATE)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      client.listProducts({ signal: controller.signal }),
      client.listSessions({ type: 'WEBINAR', limit: 1 }, controller.signal),
      client.listSessions({ type: 'OFFLINE_WORKSHOP', limit: 6 }, controller.signal),
      client.listCohorts({ product: 'online-training', limit: 6 }, controller.signal),
    ]).then(
      ([products, webinars, workshops, cohorts]) => setState({ status: 'ready', products, nextWebinar: webinars.sessions[0] ?? null, workshopBatches: workshops.sessions, trainingCohorts: cohorts }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        console.warn('Catalog could not be loaded; showing fallback content.', error)
        setState({ status: 'error', ...EMPTY })
      },
    )
    return () => controller.abort()
  }, [client, attempt])

  const retry = useCallback(() => {
    setState(EMPTY_LOADING_STATE)
    setAttempt((count) => count + 1)
  }, [])

  const value = useMemo(() => ({ ...state, retry }), [state, retry])
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
}
