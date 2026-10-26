import { Router, type RequestHandler, type Response } from 'express'
import { z } from 'zod'
import { sanitizedDbError } from '../../lib/db-errors.js'
import { HttpError } from '../../lib/http-error.js'
import { parse } from '../admin/admin.schemas.js'
import { getAuth } from '../auth/auth.middleware.js'
import { IDEMPOTENCY_HEADER, idempotencyKeyOrThrow } from '../bookings/booking.schemas.js'
import type { PaymentRepository } from './payment.repository.js'

// Stage 2 DEVELOPMENT payment simulator. These routes are mounted under /api/v1/me/bookings AFTER the
// account guards (customer session, CSRF token and Origin for writes) and the customer-account check,
// so staff/admin sessions never reach them and a customer only ever addresses their own bookings.
//
// Three layers keep the simulator out of production:
//   1. loadEnv refuses to start with PAYMENT_SIMULATOR=true unless NODE_ENV=development;
//   2. the write routes below are not registered at all unless the simulator is enabled;
//   3. simulatorRuntimeGuard re-checks NODE_ENV on every request (defence in depth).

const params = z.object({ id: z.uuid({ message: 'must be a UUID' }) })
const attemptParams = z.object({ id: z.uuid({ message: 'must be a UUID' }), attemptId: z.uuid({ message: 'must be a UUID' }) })
// The browser only says which fake outcome to simulate; nothing about money or cards is ever accepted.
const simulateBody = z.object({ outcome: z.enum(['SUCCEEDED', 'FAILED'], { message: 'must be SUCCEEDED or FAILED' }) }).strict()
const emptyBody = z.object({}).strict()

const unavailable = (cause?: unknown) =>
  new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are temporarily unavailable. Please try again shortly.', cause === undefined ? undefined : { cause: sanitizedDbError(cause) })

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw unavailable(error)
  }
}

/** NODE_ENV values in which the simulator may ever answer (test = this repository's automated tests). */
const SIMULATOR_RUNTIMES = new Set(['development', 'test'])

/** Defence in depth: even if the routes were somehow registered, they answer 404 outside development. */
export const simulatorRuntimeGuard = (nodeEnv: () => string | undefined = () => process.env.NODE_ENV): RequestHandler => (_req, _res, next) => {
  if (!SIMULATOR_RUNTIMES.has(nodeEnv() ?? '')) return next(new HttpError(404, 'NOT_FOUND', 'Not found'))
  next()
}

export type PaymentRoutesOptions = {
  /** env.paymentSimulator: true only for NODE_ENV=development with PAYMENT_SIMULATOR=true. */
  simulator: boolean
  now?: () => Date
  nodeEnv?: () => string | undefined
}

const send = (res: Response, result: { attempt: unknown; booking: unknown; replayed: boolean }, created = false) => {
  if (result.replayed) res.set('Idempotent-Replayed', 'true')
  res.status(created && !result.replayed ? 201 : 200).json({ data: { attempt: result.attempt, booking: result.booking } })
}

export function customerPaymentsRouter(repository: PaymentRepository | null, { simulator, now = () => new Date(), nodeEnv }: PaymentRoutesOptions): Router {
  const router = Router()
  const repo = () => {
    if (!repository) throw unavailable()
    return repository
  }
  const userId = (res: Response) => getAuth(res)!.user.id
  const context = (res: Response) => ({ now: now(), requestId: res.locals.requestId as string | undefined })

  // Read-only history of the customer's own attempts (available whether or not the simulator is on).
  router.get('/bookings/:id/payment-attempts', async (req, res) => {
    const { id } = parse(params, req.params, 'path')
    res.json({ data: await run(() => repo().listForCustomer(userId(res), id)) })
  })

  if (!simulator) return router

  const guard = simulatorRuntimeGuard(nodeEnv)

  router.post('/bookings/:id/payment-attempts', guard, async (req, res) => {
    const { id } = parse(params, req.params, 'path')
    const key = idempotencyKeyOrThrow(req.get(IDEMPOTENCY_HEADER))
    parse(emptyBody, req.body ?? {}, 'body')
    send(res, await run(() => repo().start(userId(res), id, key, context(res))), true)
  })

  router.post('/bookings/:id/payment-attempts/:attemptId/simulate', guard, async (req, res) => {
    const { id, attemptId } = parse(attemptParams, req.params, 'path')
    const { outcome } = parse(simulateBody, req.body ?? {}, 'body')
    send(res, await run(() => repo().simulate(userId(res), id, attemptId, outcome, context(res))))
  })

  router.post('/bookings/:id/payment-attempts/:attemptId/cancel', guard, async (req, res) => {
    const { id, attemptId } = parse(attemptParams, req.params, 'path')
    parse(emptyBody, req.body ?? {}, 'body')
    send(res, await run(() => repo().cancel(userId(res), id, attemptId, context(res))))
  })

  return router
}

/**
 * Public, unauthenticated: tells the website whether the development simulator is on, so it shows
 * simulator controls only when the server says so. Real payments are never enabled in this stage.
 */
export function paymentConfigRouter(simulator: boolean): Router {
  const router = Router()
  router.get('/payments/config', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ data: { simulator: simulator ? { enabled: true, environment: 'development', notice: 'Simulated payments only. No money is taken or received.' } : { enabled: false }, realPayments: false } })
  })
  return router
}
