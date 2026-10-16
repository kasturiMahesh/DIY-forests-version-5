import { Router, type Request, type Response } from 'express'
import { HttpError } from '../../lib/http-error.js'
import { getAuth } from '../auth/auth.middleware.js'
import type { Actor, AdminRepository, Paged } from './admin.repository.js'
import {
  cancelBody, cohortCreate, cohortListQuery, cohortUpdate, idParams, parse, productCreate, productListQuery, productUpdate, sessionCreate, sessionListQuery, sessionUpdate,
} from './admin.schemas.js'

/**
 * Stage 4B management API, mounted at /api/v1/admin AFTER the Stage 4A guards (session, ADMIN role +
 * admin pool + active account + configured admin issuer, then CSRF/Origin for writes). Nothing here
 * re-implements authentication; every handler can rely on res.locals.auth being an admin.
 */
export function adminManagementRouter(repository: AdminRepository | null, now: () => Date = () => new Date()): Router {
  const router = Router()

  const repo = () => {
    if (!repository) throw unavailable()
    return repository
  }
  const actor = (res: Response): Actor => ({ userId: getAuth(res)!.user.id, requestId: res.locals.requestId })
  const id = (req: Request) => parse(idParams, req.params, 'path').id

  /** Domain errors (400/404/409) pass through; anything else is a client-safe 503 with the cause logged. */
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw unavailable(error)
    }
  }
  const list = <T>(res: Response, result: Paged<T>, page: { page: number; pageSize: number }) =>
    res.json({ data: result.items, meta: { page: page.page, pageSize: page.pageSize, total: result.total } })

  // ---- dashboard ----
  router.get('/dashboard', async (_req, res) => {
    res.json({ data: await run(() => repo().dashboard(now())) })
  })

  // ---- products ----
  router.get('/products', async (req, res) => {
    const { page, pageSize, active, ...filter } = parse(productListQuery, req.query, 'query')
    list(res, await run(() => repo().listProducts({ ...filter, active: active === undefined ? undefined : active === 'true' }, { page, pageSize })), { page, pageSize })
  })
  router.post('/products', async (req, res) => {
    const input = parse(productCreate, req.body, 'body')
    res.status(201).json({ data: await run(() => repo().createProduct(input, actor(res))) })
  })
  router.get('/products/:id', async (req, res) => {
    res.json({ data: await run(() => repo().getProduct(id(req))) })
  })
  router.patch('/products/:id', async (req, res) => {
    const productId = id(req)
    const patch = parse(productUpdate, req.body, 'body')
    res.json({ data: await run(() => repo().updateProduct(productId, patch, actor(res))) })
  })
  router.post('/products/:id/activate', async (req, res) => {
    const productId = id(req)
    res.json({ data: await run(() => repo().setProductActive(productId, true, actor(res))) })
  })
  router.post('/products/:id/deactivate', async (req, res) => {
    const productId = id(req)
    res.json({ data: await run(() => repo().setProductActive(productId, false, actor(res))) })
  })

  // ---- webinar and workshop sessions ----
  router.get('/sessions', async (req, res) => {
    const { page, pageSize, ...filter } = parse(sessionListQuery, req.query, 'query')
    list(res, await run(() => repo().listSessions(filter, { page, pageSize })), { page, pageSize })
  })
  router.post('/sessions', async (req, res) => {
    const input = parse(sessionCreate, req.body, 'body')
    res.status(201).json({ data: await run(() => repo().createSession(input, actor(res), now())) })
  })
  router.get('/sessions/:id', async (req, res) => {
    res.json({ data: await run(() => repo().getSession(id(req))) })
  })
  router.patch('/sessions/:id', async (req, res) => {
    const sessionId = id(req)
    const patch = parse(sessionUpdate, req.body, 'body')
    res.json({ data: await run(() => repo().updateSession(sessionId, patch, actor(res), now())) })
  })
  router.post('/sessions/:id/publish', async (req, res) => {
    const sessionId = id(req)
    res.json({ data: await run(() => repo().publishSession(sessionId, actor(res), now())) })
  })
  router.post('/sessions/:id/cancel', async (req, res) => {
    const sessionId = id(req)
    const { reason } = parse(cancelBody, req.body ?? {}, 'body')
    res.json({ data: await run(() => repo().cancelSession(sessionId, reason ?? null, actor(res))) })
  })

  // ---- online-training cohorts (two linked Friday sessions) ----
  router.get('/cohorts', async (req, res) => {
    const { page, pageSize, ...filter } = parse(cohortListQuery, req.query, 'query')
    list(res, await run(() => repo().listCohorts(filter, { page, pageSize })), { page, pageSize })
  })
  router.post('/cohorts', async (req, res) => {
    const input = parse(cohortCreate, req.body, 'body')
    res.status(201).json({ data: await run(() => repo().createCohort(input, actor(res), now())) })
  })
  router.get('/cohorts/:id', async (req, res) => {
    res.json({ data: await run(() => repo().getCohort(id(req))) })
  })
  router.patch('/cohorts/:id', async (req, res) => {
    const cohortId = id(req)
    const patch = parse(cohortUpdate, req.body, 'body')
    res.json({ data: await run(() => repo().updateCohort(cohortId, patch, actor(res), now())) })
  })
  router.post('/cohorts/:id/publish', async (req, res) => {
    const cohortId = id(req)
    res.json({ data: await run(() => repo().publishCohort(cohortId, actor(res), now())) })
  })
  router.post('/cohorts/:id/cancel', async (req, res) => {
    const cohortId = id(req)
    const { reason } = parse(cancelBody, req.body ?? {}, 'body')
    res.json({ data: await run(() => repo().cancelCohort(cohortId, reason ?? null, actor(res))) })
  })

  return router
}

const unavailable = (cause?: unknown) =>
  new HttpError(503, 'ADMIN_UNAVAILABLE', 'The admin service is temporarily unavailable. Please try again shortly.', cause === undefined ? undefined : { cause })
