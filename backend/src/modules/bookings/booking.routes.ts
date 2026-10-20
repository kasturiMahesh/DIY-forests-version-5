import { Router, type Request, type Response } from 'express'
import { sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { idParams, parse } from '../admin/admin.schemas.js'
import { getAuth } from '../auth/auth.middleware.js'
import type { BookingRepository, Paged } from './booking.repository.js'
import { adminCancelBody, adminListQuery, bookingCreate, customerCancelBody, customerListQuery, IDEMPOTENCY_HEADER, idempotencyKeyOrThrow, phoneOrThrow } from './booking.schemas.js'

const unavailable = (cause?: unknown) =>
  new HttpError(503, 'BOOKINGS_UNAVAILABLE', 'Bookings are temporarily unavailable. Please try again shortly.', cause === undefined ? undefined : { cause: sanitizedDbError(cause) })

/** Domain errors (400/404/409) pass through; anything else is a client-safe 503 with a log-safe cause. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw unavailable(error)
  }
}

const list = <T>(res: Response, result: Paged<T>, page: { page: number; pageSize: number }) =>
  res.json({ data: result.items, meta: { page: page.page, pageSize: page.pageSize, total: result.total } })
const id = (req: Request) => parse(idParams, req.params, 'path').id

/**
 * The signed-in customer's own bookings, mounted at /api/v1/me AFTER the account guards (session,
 * then CSRF + Origin for writes). The user id always comes from the session, never from the request,
 * so a customer can only ever see or cancel their own bookings.
 */
export function customerBookingsRouter(repository: BookingRepository | null, now: () => Date = () => new Date()): Router {
  const router = Router()
  const repo = () => {
    if (!repository) throw unavailable()
    return repository
  }
  const userId = (res: Response) => getAuth(res)!.user.id

  // Bookings belong to customer accounts. Staff (admin-pool) sessions also reach /me, but must not book
  // or appear to own bookings; they manage them through /admin/bookings instead.
  router.use('/bookings', (_req, res, next) => {
    const { user, session } = getAuth(res)!
    if (session.kind !== 'CUSTOMER' || user.identityPool !== 'CUSTOMER' || user.role !== 'CUSTOMER') {
      return next(new HttpError(403, 'CUSTOMER_ACCOUNT_REQUIRED', 'Bookings are made with a customer account. Staff accounts manage bookings in the admin area.'))
    }
    next()
  })

  router.post('/bookings', async (req, res) => {
    const idempotencyKey = idempotencyKeyOrThrow(req.get(IDEMPOTENCY_HEADER))
    const body = parse(bookingCreate, req.body, 'body')
    const phone = phoneOrThrow(body.phone)
    const target = body.sessionId ? { kind: 'session' as const, id: body.sessionId } : { kind: 'cohort' as const, id: body.cohortId! }
    const { booking, replayed } = await run(() => repo().create(userId(res), { productId: body.productId, target, contactName: body.contactName, phone, idempotencyKey }, { now: now(), requestId: res.locals.requestId }))
    // 201 for a new booking; 200 (and the replay header) when a retry returns the booking already made.
    if (replayed) res.set('Idempotent-Replayed', 'true')
    res.status(replayed ? 200 : 201).json({ data: booking })
  })

  router.get('/bookings', async (req, res) => {
    const { page, pageSize, status } = parse(customerListQuery, req.query, 'query')
    list(res, await run(() => repo().listForCustomer(userId(res), { status }, { page, pageSize }, now())), { page, pageSize })
  })

  router.get('/bookings/:id', async (req, res) => {
    const bookingId = id(req)
    res.json({ data: await run(() => repo().getForCustomer(userId(res), bookingId, now())) })
  })

  router.post('/bookings/:id/cancel', async (req, res) => {
    const bookingId = id(req)
    const { reason } = parse(customerCancelBody, req.body ?? {}, 'body')
    res.json({ data: await run(() => repo().cancelByCustomer(userId(res), bookingId, reason ?? null, { now: now(), requestId: res.locals.requestId })) })
  })

  return router
}

/** Admin bookings, mounted at /api/v1/admin AFTER the admin guards (ADMIN session + role + pool + issuer, CSRF). */
export function adminBookingsRouter(repository: BookingRepository | null, now: () => Date = () => new Date()): Router {
  const router = Router()
  const repo = () => {
    if (!repository) throw unavailable()
    return repository
  }

  router.get('/bookings', async (req, res) => {
    const { page, pageSize, ...filter } = parse(adminListQuery, req.query, 'query')
    list(res, await run(() => repo().listForAdmin(filter, { page, pageSize })), { page, pageSize })
  })

  router.get('/bookings/:id', async (req, res) => {
    const bookingId = id(req)
    res.json({ data: await run(() => repo().getForAdmin(bookingId)) })
  })

  router.post('/bookings/:id/cancel', async (req, res) => {
    const bookingId = id(req)
    const { reason } = parse(adminCancelBody, req.body ?? {}, 'body')
    const actor = { userId: getAuth(res)!.user.id, requestId: res.locals.requestId as string | undefined }
    res.json({ data: await run(() => repo().cancelByAdmin(bookingId, reason, actor, now())) })
  })

  return router
}
