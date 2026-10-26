// Public API shapes for the read-only catalog. These are the documented contract
// (see backend/README.md, "Catalog API"); the frontend mirrors them in frontend/src/api/types.ts.

export type ProductType = 'ONLINE_TRAINING' | 'OFFLINE_WORKSHOP' | 'WEBINAR'

/** Exact decimal amount as a string with two decimals (e.g. "100000.00"), never a float. */
export type Money = { amount: string; currency: string }

export type PublicProduct = {
  id: string
  slug: string
  name: string
  type: ProductType
  summary: string | null
  description: string | null
  audience: string | null
  durationLabel: string | null
  price: Money
}

export type PublicProductRef = Pick<PublicProduct, 'id' | 'slug' | 'name' | 'type' | 'price'>

export type PublicSession = {
  id: string
  /** ISO 8601 UTC instant, e.g. "2026-11-06T13:00:00.000Z". */
  startsAt: string
  endsAt: string | null
  /** Organizer's IANA zone (for showing organizer-local time); clients display in the visitor's zone. */
  timezone: string
  capacity: number | null
  /** capacity minus seats held by active (pending-payment) bookings; null = no limit. Checked again when booking. */
  seatsAvailable: number | null
  /** Where an in-person session (offline workshop) takes place; null for online sessions. */
  venue: string | null
  product: PublicProductRef
}

/** A published online-training offering: two 4-hour sessions on consecutive Fridays, booked as one. */
export type PublicCohort = {
  id: string
  timezone: string
  capacity: number | null
  /** capacity minus seats held by active (pending-payment) bookings; null = no limit. Checked again when booking. */
  seatsAvailable: number | null
  product: PublicProductRef
  sessions: { sequence: 1 | 2; startsAt: string; endsAt: string }[]
}

export type ListResponse<T, M = undefined> = M extends undefined ? { data: T[] } : { data: T[]; meta: M }
export type ItemResponse<T> = { data: T }

export type SessionListMeta = { from: string; limit: number; count: number }
export type CohortListMeta = SessionListMeta
