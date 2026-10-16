import type { Money, ProductType, PublicProduct, PublicProductRef, PublicSession, SessionListMeta, SessionQuery } from './types'

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid-response'

/** Every failure from the client is an ApiError, so callers can show one recoverable error state. */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly kind: ApiErrorKind
  readonly details: { status?: number; code?: string; requestId?: string }

  constructor(kind: ApiErrorKind, message: string, details: { status?: number; code?: string; requestId?: string } = {}) {
    super(message)
    this.kind = kind
    this.details = details
  }
}

// ---- response validation (the API is a trust boundary: never assume the shape) ----

type Guard<T> = (value: unknown) => value is T
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isInstant = (value: unknown): value is string => isString(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value))
const PRODUCT_TYPES: readonly ProductType[] = ['ONLINE_TRAINING', 'OFFLINE_WORKSHOP', 'WEBINAR']

const isMoney: Guard<Money> = (value): value is Money =>
  isObject(value) && isString(value.amount) && /^\d+\.\d{2}$/.test(value.amount) && isString(value.currency) && /^[A-Z]{3}$/.test(value.currency)

const isProductRef: Guard<PublicProductRef> = (value): value is PublicProductRef =>
  isObject(value) && isString(value.id) && isString(value.slug) && isString(value.name) && PRODUCT_TYPES.includes(value.type as ProductType) && isMoney(value.price)

export const isPublicProduct: Guard<PublicProduct> = (value): value is PublicProduct =>
  isObject(value) && isProductRef(value) &&
  ['summary', 'description', 'audience', 'durationLabel'].every((key) => isNullableString((value as Record<string, unknown>)[key]))

export const isPublicSession: Guard<PublicSession> = (value): value is PublicSession =>
  isObject(value) && isString(value.id) && isInstant(value.startsAt) && (value.endsAt === null || isInstant(value.endsAt)) && isString(value.timezone) &&
  (value.capacity === null || (Number.isInteger(value.capacity) && (value.capacity as number) > 0)) && isProductRef(value.product)

const isSessionMeta: Guard<SessionListMeta> = (value): value is SessionListMeta =>
  isObject(value) && isInstant(value.from) && Number.isInteger(value.limit) && Number.isInteger(value.count)

// ---- transport ----

export type ApiClientOptions = {
  /** API origin, e.g. "https://api.example.com". Empty = same origin (Vite proxy in development). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createApiClient({ baseUrl = '', fetch: fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 10_000 }: ApiClientOptions = {}) {
  const root = `${baseUrl.replace(/\/+$/, '')}/api/v1`

  async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(`${root}${path}`, {
        headers: { Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (error) {
      if (signal?.aborted) throw error // the caller cancelled; not an API failure
      if (timeout.aborted) throw new ApiError('timeout', 'The server took too long to respond.')
      throw new ApiError('network', 'Could not reach the server.')
    }

    const requestId = response.headers.get('X-Request-Id') ?? undefined
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }

    if (!response.ok) {
      const error = isObject(body) && isObject(body.error) ? body.error : null
      throw new ApiError('http', isString(error?.message) ? error.message : `Request failed (${response.status}).`, {
        status: response.status,
        ...(isString(error?.code) ? { code: error.code } : {}),
        ...(requestId ? { requestId } : {}),
      })
    }
    if (body === null) throw new ApiError('invalid-response', 'The server sent an unreadable response.', { status: response.status })
    return body
  }

  function expectData<T>(body: unknown, guard: Guard<T>): T {
    if (isObject(body) && guard(body.data)) return body.data
    throw new ApiError('invalid-response', 'The server sent an unexpected response.')
  }

  function expectList<T>(body: unknown, guard: Guard<T>): T[] {
    if (isObject(body) && Array.isArray(body.data) && body.data.every(guard)) return body.data
    throw new ApiError('invalid-response', 'The server sent an unexpected response.')
  }

  return {
    async listProducts(options: { type?: ProductType; signal?: AbortSignal } = {}): Promise<PublicProduct[]> {
      const query = options.type ? `?type=${options.type}` : ''
      return expectList(await getJson(`/products${query}`, options.signal), isPublicProduct)
    },

    async getProduct(slug: string, signal?: AbortSignal): Promise<PublicProduct> {
      return expectData(await getJson(`/products/${encodeURIComponent(slug)}`, signal), isPublicProduct)
    },

    async listSessions(query: SessionQuery = {}, signal?: AbortSignal): Promise<{ sessions: PublicSession[]; meta: SessionListMeta }> {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
      const body = await getJson(`/sessions${params.size ? `?${params}` : ''}`, signal)
      const sessions = expectList(body, isPublicSession)
      if (!isObject(body) || !isSessionMeta(body.meta)) throw new ApiError('invalid-response', 'The server sent an unexpected response.')
      return { sessions, meta: body.meta }
    },

    async getSession(id: string, signal?: AbortSignal): Promise<PublicSession> {
      return expectData(await getJson(`/sessions/${encodeURIComponent(id)}`, signal), isPublicSession)
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

/** Default client. VITE_API_BASE_URL is public build-time configuration; never put secrets in VITE_* variables. */
export const api = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? '' })
