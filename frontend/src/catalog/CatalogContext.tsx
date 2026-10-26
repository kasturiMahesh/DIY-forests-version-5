import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api as defaultApi, type ApiClient } from '../api/client'
import { CatalogContext, type CatalogState } from './catalog-context'

const EMPTY = { products: [], nextWebinar: null, workshopBatches: [], trainingCohorts: [] }
const EMPTY_LOADING_STATE = { status: 'loading' as const, ...EMPTY }

/**
 * Loads the public catalog. `bookable: true` asks the server only for dates that can still be booked
 * (bookings close 24 hours before the start), so the banner shows the next bookable webinar and no
 * unbookable date is offered. No bookable webinar gives `nextWebinar: null` (the banner's empty state).
 */
export async function loadCatalog(client: ApiClient, signal: AbortSignal): Promise<Omit<CatalogState, 'retry'>> {
  const [products, webinars, workshops, cohorts] = await Promise.all([
    client.listProducts({ signal }),
    client.listSessions({ type: 'WEBINAR', limit: 1, bookable: true }, signal),
    client.listSessions({ type: 'OFFLINE_WORKSHOP', limit: 6, bookable: true }, signal),
    client.listCohorts({ product: 'online-training', limit: 6, bookable: true }, signal),
  ])
  return { status: 'ready', products, nextWebinar: webinars.sessions[0] ?? null, workshopBatches: workshops.sessions, trainingCohorts: cohorts }
}

/** Loads the public catalog once for the whole app; `retry` reloads after an error. */
export function CatalogProvider({ children, client = defaultApi }: { children: ReactNode; client?: ApiClient }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<Omit<CatalogState, 'retry'>>(EMPTY_LOADING_STATE)

  useEffect(() => {
    const controller = new AbortController()
    loadCatalog(client, controller.signal).then(
      (loaded) => setState(loaded),
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
