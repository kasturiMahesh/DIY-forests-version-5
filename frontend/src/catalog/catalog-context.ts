import { createContext, useContext } from 'react'
import type { Money, PublicCohort, PublicProduct, PublicSession } from '../api/types'

export type CatalogStatus = 'loading' | 'ready' | 'error'

export type CatalogState = {
  status: CatalogStatus
  /** Active products from the API (empty until ready). */
  products: PublicProduct[]
  /** The soonest PUBLISHED upcoming webinar, or null if none is scheduled. Only meaningful when ready. */
  nextWebinar: PublicSession | null
  /** Published upcoming offline-workshop batches (real dates and venues from the admin). */
  workshopBatches: PublicSession[]
  /** Published upcoming online-training cohorts (two linked Fridays each). */
  trainingCohorts: PublicCohort[]
  retry: () => void
}

export const CatalogContext = createContext<CatalogState>({ status: 'loading', products: [], nextWebinar: null, workshopBatches: [], trainingCohorts: [], retry: () => {} })

export function useCatalog(): CatalogState {
  return useContext(CatalogContext)
}

/** Price from the API when loaded; otherwise the caller's static fallback (today's site values). */
export function priceFor(catalog: CatalogState, slug: string, fallback: Money): Money {
  return catalog.products.find((product) => product.slug === slug)?.price ?? fallback
}
