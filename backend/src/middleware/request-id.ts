import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'

export const REQUEST_ID_HEADER = 'X-Request-Id'

// Accept a caller-supplied ID (e.g. from a load balancer) only if it is short and plain.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER)
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID()
  res.locals.requestId = id
  res.set(REQUEST_ID_HEADER, id)
  next()
}
