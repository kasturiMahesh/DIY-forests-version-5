import { Router, type Response } from 'express'
import { z } from 'zod'
import { HttpError } from '../../lib/http-error.js'
import { BOOKING_CUTOFF_MS } from '../bookings/booking-holds.js'
import type { CatalogRepository } from './catalog.repository.js'
import type { CohortListMeta, ItemResponse, ListResponse, PublicCohort, PublicProduct, PublicSession, SessionListMeta } from './catalog.types.js'

const SLUG = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a lower-case slug like "online-training"').max(80)
const PRODUCT_TYPE = z.enum(['ONLINE_TRAINING', 'OFFLINE_WORKSHOP', 'WEBINAR'])
/**
 * bookable=true: only dates that can still be booked, i.e. starting strictly more than 24 hours after
 * the server's current time (the booking API refuses bookings from start - 24 hours). Opt-in, so the
 * existing listing (including past sessions with an earlier `from`) is unchanged for other callers.
 */
const BOOKABLE = z.enum(['true', 'false'], { message: 'must be "true" or "false"' }).optional()
export const DEFAULT_SESSION_LIMIT = 50
export const MAX_SESSION_LIMIT = 100

// .strict(): unknown query parameters are rejected rather than silently ignored (catches typos).
const productListQuery = z.object({ type: PRODUCT_TYPE.optional() }).strict()
const sessionListQuery = z.object({
  type: PRODUCT_TYPE.optional(),
  product: SLUG.optional(),
  // An instant, so it must carry "Z" or an offset; a bare local time would depend on someone's zone.
  from: z.iso.datetime({ offset: true, message: 'must be an ISO 8601 instant with Z or an offset, e.g. 2026-11-01T00:00:00Z' }).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SESSION_LIMIT).default(DEFAULT_SESSION_LIMIT),
  bookable: BOOKABLE,
}).strict()
const cohortListQuery = z.object({
  product: SLUG.optional(),
  from: z.iso.datetime({ offset: true, message: 'must be an ISO 8601 instant with Z or an offset, e.g. 2026-11-01T00:00:00Z' }).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SESSION_LIMIT).default(DEFAULT_SESSION_LIMIT),
  bookable: BOOKABLE,
}).strict()
/** The earliest start a bookable date may have (exclusive): now + the booking cutoff. */
const bookableAfter = (bookable: 'true' | 'false' | undefined, now: Date) => (bookable === 'true' ? { bookableAfter: new Date(now.getTime() + BOOKING_CUTOFF_MS) } : {})
const slugParams = z.object({ slug: SLUG })
const idParams = z.object({ id: z.uuid({ message: 'must be a UUID' }) })

function parse<T>(schema: z.ZodType<T>, input: unknown, where: 'query' | 'path'): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  // Messages name the parameter and the rule, never echo the submitted value.
  const detail = result.error.issues
    .map((issue) => (issue.code === 'unrecognized_keys' ? `unknown ${where} parameter(s): ${issue.keys.join(', ')}` : `${String(issue.path[0] ?? where)}: ${issue.message}`))
    .join('; ')
  throw new HttpError(400, where === 'query' ? 'INVALID_QUERY' : 'INVALID_PATH', `Invalid ${where === 'query' ? 'query parameters' : 'path'}: ${detail}`)
}

const unavailable = (cause?: unknown) =>
  new HttpError(503, 'CATALOG_UNAVAILABLE', 'The catalog is temporarily unavailable. Please try again shortly.', { cause })

/** Run a repository call; any failure (connection, timeout, guard) becomes a client-safe 503. */
async function load<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw unavailable(error)
  }
}

/**
 * Short public cache: admins publish, reschedule and cancel in Stage 4B, and visitors should see that
 * within seconds. 15 s still absorbs bursts of identical requests (and a future CDN can use it).
 */
export const CATALOG_MAX_AGE_SECONDS = 15
const cache = (res: Response) => res.set('Cache-Control', `public, max-age=${CATALOG_MAX_AGE_SECONDS}`)

/**
 * Read-only public catalog. `repository` is null when no database is configured; every
 * endpoint then answers 503 instead of failing at startup, so the rest of the API still runs.
 */
export function catalogRouter(repository: CatalogRepository | null, now: () => Date = () => new Date()): Router {
  const router = Router()
  const repo = () => {
    if (!repository) throw unavailable()
    return repository
  }

  router.get('/products', async (req, res) => {
    const { type } = parse(productListQuery, req.query, 'query')
    const data = await load(() => repo().listProducts(type ? { type } : {}))
    const body: ListResponse<PublicProduct> = { data }
    cache(res).json(body)
  })

  router.get('/products/:slug', async (req, res) => {
    const { slug } = parse(slugParams, req.params, 'path')
    const product = await load(() => repo().findProduct(slug))
    if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found')
    const body: ItemResponse<PublicProduct> = { data: product }
    cache(res).json(body)
  })

  router.get('/sessions', async (req, res) => {
    const { from, limit, product, type, bookable } = parse(sessionListQuery, req.query, 'query')
    // Default window starts at the real current instant on the server, never a visitor's wall clock.
    const at = now()
    const fromInstant = from ? new Date(from) : at
    const data = await load(() =>
      repo().listUpcomingSessions({ from: fromInstant, limit, ...(product ? { productSlug: product } : {}), ...(type ? { type } : {}), ...bookableAfter(bookable, at) }),
    )
    const body: ListResponse<PublicSession, SessionListMeta> = { data, meta: { from: fromInstant.toISOString(), limit, count: data.length } }
    cache(res).json(body)
  })

  router.get('/sessions/:id', async (req, res) => {
    const { id } = parse(idParams, req.params, 'path')
    const session = await load(() => repo().findSession(id))
    if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found')
    const body: ItemResponse<PublicSession> = { data: session }
    cache(res).json(body)
  })

  // Online training: two linked Friday sessions offered (and, in Stage 4C, booked) as one cohort.
  router.get('/cohorts', async (req, res) => {
    const { from, limit, product, bookable } = parse(cohortListQuery, req.query, 'query')
    const at = now()
    const fromInstant = from ? new Date(from) : at
    const data = await load(() => repo().listUpcomingCohorts({ from: fromInstant, limit, ...(product ? { productSlug: product } : {}), ...bookableAfter(bookable, at) }))
    const body: ListResponse<PublicCohort, CohortListMeta> = { data, meta: { from: fromInstant.toISOString(), limit, count: data.length } }
    cache(res).json(body)
  })

  router.get('/cohorts/:id', async (req, res) => {
    const { id } = parse(idParams, req.params, 'path')
    const cohort = await load(() => repo().findCohort(id))
    if (!cohort) throw new HttpError(404, 'COHORT_NOT_FOUND', 'Training dates not found')
    const body: ItemResponse<PublicCohort> = { data: cohort }
    cache(res).json(body)
  })

  return router
}
