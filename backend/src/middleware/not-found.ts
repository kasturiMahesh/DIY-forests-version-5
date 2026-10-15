import type { RequestHandler } from 'express'
import type { ErrorBody } from '../lib/http-error.js'

export const notFound: RequestHandler = (req, res) => {
  const body: ErrorBody = {
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: res.locals.requestId },
  }
  res.status(404).json(body)
}
