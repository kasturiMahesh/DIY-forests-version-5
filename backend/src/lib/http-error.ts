/** An error that is safe to show to API clients. Anything else is reported as a generic 500. */
export class HttpError extends Error {
  override name = 'HttpError'

  /** `cause` is logged server-side for 5xx responses and never sent to the client. */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export type ErrorBody = {
  error: { code: string; message: string; requestId: string }
}
