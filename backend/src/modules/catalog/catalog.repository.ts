import type { PrismaClient } from '../../generated/prisma/client.js'
import { SessionStatus } from '../../generated/prisma/enums.js'
import { assertUtcSession } from '../../db/timezone-guard.js'
import { PRODUCT_SELECT, SESSION_SELECT, toPublicProduct, toPublicSession } from './catalog.serializers.js'
import type { ProductType, PublicProduct, PublicSession } from './catalog.types.js'

export type SessionQuery = { from: Date; limit: number; productSlug?: string; type?: ProductType }

/** Read-only, public view of the catalog. Only active products and PUBLISHED sessions are visible. */
export interface CatalogRepository {
  listProducts(filter: { type?: ProductType }): Promise<PublicProduct[]>
  findProduct(slug: string): Promise<PublicProduct | null>
  listUpcomingSessions(query: SessionQuery): Promise<PublicSession[]>
  findSession(id: string): Promise<PublicSession | null>
}

export function createCatalogRepository(prisma: PrismaClient): CatalogRepository {
  // Prisma 7.10's pg adapter only handles timestamptz correctly in a UTC session (see
  // src/db/timezone-guard.ts), so confirm that once before the first query. A failed check is
  // not cached, so the next request re-checks (e.g. after the database is fixed).
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  const publicSession = { status: SessionStatus.PUBLISHED, product: { isActive: true } } as const

  return {
    async listProducts({ type }) {
      await ready()
      const rows = await prisma.product.findMany({
        where: { isActive: true, ...(type ? { type } : {}) },
        select: PRODUCT_SELECT,
        orderBy: [{ type: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      })
      return rows.map(toPublicProduct)
    },

    async findProduct(slug) {
      await ready()
      const row = await prisma.product.findFirst({ where: { slug, isActive: true }, select: PRODUCT_SELECT })
      return row ? toPublicProduct(row) : null
    },

    async listUpcomingSessions({ from, limit, productSlug, type }) {
      await ready()
      const rows = await prisma.session.findMany({
        where: {
          ...publicSession,
          startsAt: { gte: from },
          product: { isActive: true, ...(productSlug ? { slug: productSlug } : {}), ...(type ? { type } : {}) },
        },
        select: SESSION_SELECT,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })
      return rows.map(toPublicSession)
    },

    async findSession(id) {
      await ready()
      const row = await prisma.session.findFirst({ where: { id, ...publicSession }, select: SESSION_SELECT })
      return row ? toPublicSession(row) : null
    },
  }
}
