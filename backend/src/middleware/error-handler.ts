import type { ErrorRequestHandler } from 'express'
import { HttpError, type ErrorBody } from '../lib/http-error.js'
import type { Logger } from '../lib/logger.js'

// Errors raised by express.json() carry a `type` and an HTTP status.
type BodyParserError = Error & { type?: string; status?: number }

function toHttpError(err: unknown): HttpError | null {
  if (err instanceof HttpError) return err
  const parserError = err as BodyParserError
  if (parserError?.type === 'entity.parse.failed') return new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON')
  if (parserError?.type === 'entity.too.large') return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
  if (parserError?.type === 'encoding.unsupported' || parserError?.type === 'charset.unsupported') {
    return new HttpError(415, 'UNSUPPORTED_ENCODING', 'Request body encoding is not supported')
  }
  return null
}

/** Central error handler: consistent JSON errors, no stack traces or internal messages sent to clients. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err)
      return
    }
    const requestId: string = res.locals.requestId ?? 'unknown'
    const known = toHttpError(err)
    const status = known?.status ?? 500
    const code = known?.code ?? 'INTERNAL_ERROR'
    const message = known?.message ?? 'An unexpected error occurred'

    if (status >= 500) {
      logger.error('Unhandled error', {
        requestId,
        method: req.method,
        path: req.path,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      })
    }

    const body: ErrorBody = { error: { code, message, requestId } }
    res.status(status).json(body)
  }
}
