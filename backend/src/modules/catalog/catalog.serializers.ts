import type { Product, Session, TrainingCohort } from '../../generated/prisma/client.js'
import type { PublicCohort, PublicProduct, PublicProductRef, PublicSession } from './catalog.types.js'

// Explicit field picking: anything not listed here (isActive, status, internalNote, createdAt, ...)
// can never reach a client, even if the schema grows.

type ProductRow = Pick<Product, 'id' | 'slug' | 'name' | 'type' | 'summary' | 'description' | 'audience' | 'durationLabel' | 'priceAmount' | 'currency'>
type ProductRefRow = Pick<Product, 'id' | 'slug' | 'name' | 'type' | 'priceAmount' | 'currency'>
type SessionRow = Pick<Session, 'id' | 'startsAt' | 'endsAt' | 'timezone' | 'capacity' | 'seatsHeld' | 'venue'> & { product: ProductRefRow }
type CohortRow = Pick<TrainingCohort, 'id' | 'timezone' | 'capacity' | 'seatsHeld'> & { product: ProductRefRow; sessions: Pick<Session, 'cohortSequence' | 'startsAt' | 'endsAt'>[] }

const money = (row: Pick<Product, 'priceAmount' | 'currency'>) => ({ amount: row.priceAmount.toFixed(2), currency: row.currency })
/** Seats not held by active bookings; null when no capacity is set (no limit). Never negative. */
const seatsAvailable = (row: { capacity: number | null; seatsHeld: number }) => (row.capacity === null ? null : Math.max(0, row.capacity - row.seatsHeld))

export function toPublicProduct(row: ProductRow): PublicProduct {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    summary: row.summary,
    description: row.description,
    audience: row.audience,
    durationLabel: row.durationLabel,
    price: money(row),
  }
}

export function toPublicProductRef(row: ProductRefRow): PublicProductRef {
  return { id: row.id, slug: row.slug, name: row.name, type: row.type, price: money(row) }
}

export function toPublicSession(row: SessionRow): PublicSession {
  return {
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    timezone: row.timezone,
    capacity: row.capacity,
    seatsAvailable: seatsAvailable(row),
    venue: row.venue,
    product: toPublicProductRef(row.product),
  }
}

export function toPublicCohort(row: CohortRow): PublicCohort {
  return {
    id: row.id,
    timezone: row.timezone,
    capacity: row.capacity,
    seatsAvailable: seatsAvailable(row),
    product: toPublicProductRef(row.product),
    sessions: row.sessions.map((session) => ({ sequence: session.cohortSequence as 1 | 2, startsAt: session.startsAt.toISOString(), endsAt: session.endsAt!.toISOString() })),
  }
}

export const PRODUCT_SELECT = {
  id: true, slug: true, name: true, type: true, summary: true, description: true, audience: true, durationLabel: true, priceAmount: true, currency: true,
} as const

export const PRODUCT_REF_SELECT = { id: true, slug: true, name: true, type: true, priceAmount: true, currency: true } as const

export const SESSION_SELECT = {
  id: true, startsAt: true, endsAt: true, timezone: true, capacity: true, seatsHeld: true, venue: true, product: { select: PRODUCT_REF_SELECT },
} as const

export const COHORT_SELECT = {
  id: true, timezone: true, capacity: true, seatsHeld: true, product: { select: PRODUCT_REF_SELECT },
  sessions: { select: { cohortSequence: true, startsAt: true, endsAt: true }, orderBy: { cohortSequence: 'asc' as const } },
} as const
