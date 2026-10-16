import type { Product, Session } from '../../generated/prisma/client.js'
import type { PublicProduct, PublicProductRef, PublicSession } from './catalog.types.js'

// Explicit field picking: anything not listed here (isActive, status, internalNote, createdAt, ...)
// can never reach a client, even if the schema grows.

type ProductRow = Pick<Product, 'id' | 'slug' | 'name' | 'type' | 'summary' | 'description' | 'audience' | 'durationLabel' | 'priceAmount' | 'currency'>
type ProductRefRow = Pick<Product, 'id' | 'slug' | 'name' | 'type' | 'priceAmount' | 'currency'>
type SessionRow = Pick<Session, 'id' | 'startsAt' | 'endsAt' | 'timezone' | 'capacity'> & { product: ProductRefRow }

const money = (row: Pick<Product, 'priceAmount' | 'currency'>) => ({ amount: row.priceAmount.toFixed(2), currency: row.currency })

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
    product: toPublicProductRef(row.product),
  }
}

export const PRODUCT_SELECT = {
  id: true, slug: true, name: true, type: true, summary: true, description: true, audience: true, durationLabel: true, priceAmount: true, currency: true,
} as const

export const PRODUCT_REF_SELECT = { id: true, slug: true, name: true, type: true, priceAmount: true, currency: true } as const

export const SESSION_SELECT = {
  id: true, startsAt: true, endsAt: true, timezone: true, capacity: true, product: { select: PRODUCT_REF_SELECT },
} as const
