import { Router, type Request, type Response } from 'express'
import { sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { idParams, parse } from '../admin/admin.schemas.js'
import { getAuth } from '../auth/auth.middleware.js'
import type { BookingRepository, Paged } from './booking.repository.js'
import { adminCancelBody, adminListQuery, bookingCreate, cancellationRequestBody, customerCancelBody, customerListQuery, decisionBody, IDEMPOTENCY_HEADER, idempotencyKeyOrThrow, manualConfirmBody, phoneOrThrow } from './booking.schemas.js'
import type { CancellationRequestRepository } from './cancellation-requests.js'
import type { ManualConfirmationRepository } from './manual-confirmation.js'

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
export function customerBookingsRouter(repository: BookingRepository | null, now: () => Date = () => new Date(), extensions?: Router | Router[]): Router {
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
  // Stage 2 payment attempts and Revision 3 cancellation requests: behind the same customer-account check.
  for (const extension of [extensions ?? []].flat()) router.use(extension)

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
export function adminBookingsRouter(repository: BookingRepository | null, now: () => Date = () => new Date(), extensions?: Router | Router[]): Router {
  const router = Router()
  const repo = () => {
    if (!repository) throw unavailable()
    return repository
  }

  for (const extension of [extensions ?? []].flat()) router.use(extension)

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

/**
 * Revision 3 customer cancellation requests, mounted inside customerBookingsRouter (customer session,
 * CSRF + Origin, customer account). Only CONFIRMED bookings; direct cancellation stays for the others.
 */
export function customerCancellationRequestsRouter(repository: CancellationRequestRepository | null, now: () => Date = () => new Date()): Router {
  const router = Router()
  router.post('/bookings/:id/cancellation-request', async (req, res) => {
    const bookingId = id(req)
    const { reason } = parse(cancellationRequestBody, req.body ?? {}, 'body')
    if (!repository) throw unavailable()
    const result = await run(() => repository.request(getAuth(res)!.user.id, bookingId, reason ?? null, { clock: now, requestId: res.locals.requestId }))
    if (result.replayed) res.set('Idempotent-Replayed', 'true')
    res.status(result.replayed ? 200 : 201).json({ data: { request: result.request, booking: result.booking } })
  })
  return router
}

/**
 * Revision 3 admin decisions, mounted inside adminBookingsRouter (admin guards, CSRF + Origin): manual
 * confirmation of AWAITING_CONFIRMATION bookings and decisions on cancellation requests. The repositories
 * re-check everything inside one transaction, and the database enforces it again.
 */
export function adminBookingDecisionsRouter(manual: ManualConfirmationRepository | null, cancellations: CancellationRequestRepository | null, now: () => Date = () => new Date()): Router {
  const router = Router()
  const actor = (res: Response) => getAuth(res)!.user.id
  const context = (res: Response) => ({ clock: now, requestId: res.locals.requestId as string | undefined })

  router.post('/bookings/:id/confirm', async (req, res) => {
    const bookingId = id(req)
    const { reason, note } = parse(manualConfirmBody, req.body ?? {}, 'body')
    if (!manual) throw unavailable()
    const result = await run(() => manual.confirm(actor(res), bookingId, { reason, note: note ?? null }, context(res)))
    if (result.replayed) res.set('Idempotent-Replayed', 'true')
    res.json({ data: result.booking })
  })

  for (const decision of ['approve', 'reject'] as const) {
    router.post(`/bookings/:id/cancellation-request/${decision}`, async (req, res) => {
      const bookingId = id(req)
      const { reason } = parse(decisionBody, req.body ?? {}, 'body')
      if (!cancellations) throw unavailable()
      const result = await run(() => cancellations[decision](actor(res), bookingId, reason, context(res)))
      res.json({ data: result })
    })
  }
  return router
}
