// Mirrors the backend's documented catalog API (backend/src/modules/catalog/catalog.types.ts).

export type ProductType = 'ONLINE_TRAINING' | 'OFFLINE_WORKSHOP' | 'WEBINAR'

/** Exact decimal amount as a string with two decimals (e.g. "100000.00"). Never parse into a float for money maths. */
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
  /** ISO 8601 UTC instant. Display it in the visitor's own time zone. */
  startsAt: string
  endsAt: string | null
  /** Organizer's IANA zone (Asia/Kolkata). */
  timezone: string
  capacity: number | null
  product: PublicProductRef
}

export type SessionListMeta = { from: string; limit: number; count: number }

export type SessionQuery = { type?: ProductType; product?: string; from?: string; limit?: number }
