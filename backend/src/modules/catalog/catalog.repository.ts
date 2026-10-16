import type { PrismaClient } from '../../generated/prisma/client.js'
import { SessionStatus } from '../../generated/prisma/enums.js'
import { assertUtcSession } from '../../db/timezone-guard.js'
import { COHORT_SELECT, PRODUCT_SELECT, SESSION_SELECT, toPublicCohort, toPublicProduct, toPublicSession } from './catalog.serializers.js'
import type { ProductType, PublicCohort, PublicProduct, PublicSession } from './catalog.types.js'

export type SessionQuery = { from: Date; limit: number; productSlug?: string; type?: ProductType }
export type CohortQuery = { from: Date; limit: number; productSlug?: string }

/** Read-only, public view of the catalog. Only active products and PUBLISHED sessions are visible. */
export interface CatalogRepository {
  listProducts(filter: { type?: ProductType }): Promise<PublicProduct[]>
  findProduct(slug: string): Promise<PublicProduct | null>
  listUpcomingSessions(query: SessionQuery): Promise<PublicSession[]>
  findSession(id: string): Promise<PublicSession | null>
  /** Published upcoming online-training cohorts (both sessions published), first session soonest first. */
  listUpcomingCohorts(query: CohortQuery): Promise<PublicCohort[]>
  findCohort(id: string): Promise<PublicCohort | null>
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

  // Standalone sessions only: the two sessions of an online-training cohort are offered (and later
  // booked) as one unit through the cohort endpoints, never as two separate dates.
  const publicSession = { status: SessionStatus.PUBLISHED, cohortId: null, product: { isActive: true, archivedAt: null } } as const
  const publicCohort = {
    status: SessionStatus.PUBLISHED,
    product: { isActive: true, archivedAt: null },
    // Fail closed: a cohort is visible only while neither of its sessions is unpublished.
    sessions: { none: { status: { not: SessionStatus.PUBLISHED } } },
  } as const

  return {
    async listProducts({ type }) {
      await ready()
      const rows = await prisma.product.findMany({
        where: { isActive: true, archivedAt: null, ...(type ? { type } : {}) },
        select: PRODUCT_SELECT,
        orderBy: [{ type: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      })
      return rows.map(toPublicProduct)
    },

    async findProduct(slug) {
      await ready()
      const row = await prisma.product.findFirst({ where: { slug, isActive: true, archivedAt: null }, select: PRODUCT_SELECT })
      return row ? toPublicProduct(row) : null
    },

    async listUpcomingSessions({ from, limit, productSlug, type }) {
      await ready()
      const rows = await prisma.session.findMany({
        where: {
          ...publicSession,
          startsAt: { gte: from },
          product: { isActive: true, archivedAt: null, ...(productSlug ? { slug: productSlug } : {}), ...(type ? { type } : {}) },
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

    async listUpcomingCohorts({ from, limit, productSlug }) {
      await ready()
      const firsts = await prisma.session.findMany({
        where: { cohortSequence: 1, startsAt: { gte: from }, cohort: { ...publicCohort, ...(productSlug ? { product: { isActive: true, archivedAt: null, slug: productSlug } } : {}) } },
        select: { cohortId: true },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })
      const ids = firsts.map((row) => row.cohortId!)
      if (ids.length === 0) return []
      const rows = await prisma.trainingCohort.findMany({ where: { id: { in: ids } }, select: COHORT_SELECT })
      const byId = new Map(rows.filter((row) => row.sessions.length === 2).map((row) => [row.id, row]))
      return ids.flatMap((id) => (byId.has(id) ? [toPublicCohort(byId.get(id)!)] : []))
    },

    async findCohort(id) {
      await ready()
      const row = await prisma.trainingCohort.findFirst({ where: { id, ...publicCohort }, select: COHORT_SELECT })
      return row && row.sessions.length === 2 ? toPublicCohort(row) : null
    },
  }
}
