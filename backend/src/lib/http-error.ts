/** An error that is safe to show to API clients. Anything else is reported as a generic 500. */
export class HttpError extends Error {
  override name = 'HttpError'

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type ErrorBody = {
  error: { code: string; message: string; requestId: string }
}
