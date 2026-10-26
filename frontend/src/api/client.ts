import type { AdminMeResponse, AuthUser, BookingRequest, BookingStatus, CancellationRequest, CustomerBooking, MeResponse, Money, PageMeta, PaymentAttempt, PaymentConfig, ProductType, PublicCohort, PublicProduct, PublicProductRef, PublicSession, SessionListMeta, SessionQuery } from './types'

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
/** Absent (older API), null (no limit) or a non-negative whole number. */
const isSeats = (value: unknown) => value === undefined || value === null || (Number.isInteger(value) && (value as number) >= 0)

const isMoney: Guard<Money> = (value): value is Money =>
  isObject(value) && isString(value.amount) && /^\d+\.\d{2}$/.test(value.amount) && isString(value.currency) && /^[A-Z]{3}$/.test(value.currency)

const isProductRef: Guard<PublicProductRef> = (value): value is PublicProductRef =>
  isObject(value) && isString(value.id) && isString(value.slug) && isString(value.name) && PRODUCT_TYPES.includes(value.type as ProductType) && isMoney(value.price)

export const isPublicProduct: Guard<PublicProduct> = (value): value is PublicProduct =>
  isObject(value) && isProductRef(value) &&
  ['summary', 'description', 'audience', 'durationLabel'].every((key) => isNullableString((value as Record<string, unknown>)[key]))

export const isPublicSession: Guard<PublicSession> = (value): value is PublicSession =>
  isObject(value) && isString(value.id) && isInstant(value.startsAt) && (value.endsAt === null || isInstant(value.endsAt)) && isString(value.timezone) &&
  (value.capacity === null || (Number.isInteger(value.capacity) && (value.capacity as number) > 0)) && isSeats(value.seatsAvailable) && isProductRef(value.product) &&
  (value.venue === undefined || isNullableString(value.venue))

export const isPublicCohort: Guard<PublicCohort> = (value): value is PublicCohort =>
  isObject(value) && isString(value.id) && isString(value.timezone) && (value.capacity === null || Number.isInteger(value.capacity)) && isSeats(value.seatsAvailable) && isProductRef(value.product) &&
  Array.isArray(value.sessions) && value.sessions.length === 2 &&
  value.sessions.every((session, index) => isObject(session) && session.sequence === index + 1 && isInstant(session.startsAt) && isInstant(session.endsAt))

const isSessionMeta: Guard<SessionListMeta> = (value): value is SessionListMeta =>
  isObject(value) && isInstant(value.from) && Number.isInteger(value.limit) && Number.isInteger(value.count)

const isRole = (value: unknown) => value === 'CUSTOMER' || value === 'ADMIN'
export const isAuthUser: Guard<AuthUser> = (value): value is AuthUser =>
  isObject(value) && isString(value.id) && isString(value.email) && typeof value.emailVerified === 'boolean' && isNullableString(value.displayName) && isRole(value.role) && isRole(value.pool)
const isSessionInfo = (value: unknown) => isObject(value) && isRole(value.kind) && isInstant(value.idleExpiresAt) && isInstant(value.absoluteExpiresAt)
const isMeResponse: Guard<MeResponse> = (value): value is MeResponse =>
  isObject(value) && isAuthUser(value.user) && isSessionInfo(value.session) && isString(value.csrfToken) && value.csrfToken.length > 0
const isAdminMeResponse: Guard<AdminMeResponse> = (value): value is AdminMeResponse => isObject(value) && isAuthUser(value.user) && isSessionInfo(value.session)
const isLogoutResponse: Guard<{ logoutUrl: string | null }> = (value): value is { logoutUrl: string | null } =>
  isObject(value) && (value.logoutUrl === null || (isString(value.logoutUrl) && value.logoutUrl.startsWith('https://'))) // only a provider page over https

const BOOKING_STATUSES: readonly BookingStatus[] = ['PENDING_PAYMENT', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'CANCELLED']
const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED']
const REFUND_OUTCOMES = ['NO_REFUND_SIMULATED_PAYMENT', 'NO_REFUND_COMPLIMENTARY', 'NOT_PROCESSED_BY_WEBSITE']
export const isCancellationRequest = (value: unknown): value is CancellationRequest =>
  isObject(value) && isString(value.id) && REQUEST_STATUSES.includes(value.status as string) && isInstant(value.requestedAt) &&
  [0, 50, 100].includes(value.refundPercent as number) && (value.refundOutcome === null || REFUND_OUTCOMES.includes(value.refundOutcome as string))
const ATTEMPT_STATUSES = ['CREATED', 'SUCCEEDED', 'FAILED', 'CANCELLED']
export const isPaymentAttempt: Guard<PaymentAttempt> = (value): value is PaymentAttempt =>
  isObject(value) && isString(value.id) && ATTEMPT_STATUSES.includes(value.status as string) && value.provider === 'DEV_SIMULATOR' && typeof value.simulated === 'boolean' &&
  isMoney(value.amount) && isInstant(value.createdAt) && (value.completedAt === null || isInstant(value.completedAt))
const isBookingPayment = (value: unknown) =>
  value === undefined || (isObject(value) && (value.dueAt === null || isInstant(value.dueAt)) && Array.isArray(value.attempts) && value.attempts.every(isPaymentAttempt))
/** A confirmation is only ever shown with the server's own simulated-payment notice. */
const isConfirmation = (value: unknown) => value === undefined || value === null || (isObject(value) && isInstant(value.at) && typeof value.simulated === 'boolean')
const isPaymentConfig: Guard<PaymentConfig> = (value): value is PaymentConfig =>
  isObject(value) && isObject(value.simulator) && typeof value.simulator.enabled === 'boolean' && typeof value.realPayments === 'boolean'
const isTarget = (value: unknown) =>
  isObject(value) && isString(value.id) && isString(value.timezone) && (
    (value.kind === 'session' && isInstant(value.startsAt) && (value.endsAt === null || isInstant(value.endsAt))) ||
    (value.kind === 'cohort' && Array.isArray(value.sessions) && value.sessions.every((session) => isObject(session) && isInstant(session.startsAt))))
/** Shape check for a booking: it is only ever shown when the server really returned one. */
export const isCustomerBooking: Guard<CustomerBooking> = (value): value is CustomerBooking =>
  isObject(value) && isString(value.id) && isString(value.reference) && /^DF-[0-9A-Z]{8}$/.test(value.reference) &&
  BOOKING_STATUSES.includes(value.status as BookingStatus) && isMoney(value.price) && isObject(value.product) && isString(value.product.name) &&
  isTarget(value.target) && typeof value.canCancel === 'boolean' && isInstant(value.createdAt) &&
  (value.cancellation === null || (isObject(value.cancellation) && isInstant(value.cancellation.at))) &&
  isBookingPayment(value.payment) && isConfirmation(value.confirmation) && (value.status !== 'CONFIRMED' || isObject(value.confirmation)) &&
  (value.confirmationDueAt === undefined || value.confirmationDueAt === null || isInstant(value.confirmationDueAt)) &&
  (value.cancellationRequest === undefined || value.cancellationRequest === null || isCancellationRequest(value.cancellationRequest)) &&
  isObject(value.contact) && isString(value.contact.name)
const isPageMeta = (value: unknown): value is PageMeta => isObject(value) && Number.isInteger(value.page) && Number.isInteger(value.pageSize) && Number.isInteger(value.total)

/**
 * A fresh idempotency key for one booking attempt (reused for that attempt's retries): 32 random hex
 * characters. getRandomValues (unlike randomUUID) also works outside secure contexts, e.g. a LAN preview.
 */
export const newIdempotencyKey = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

// ---- transport ----

export type ApiClientOptions = {
  /** API origin, e.g. "https://api.example.com". Empty = same origin (Vite proxy in development). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createApiClient({ baseUrl = '', fetch: fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 10_000 }: ApiClientOptions = {}) {
  const root = `${baseUrl.replace(/\/+$/, '')}/api/v1`

  type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; csrfToken?: string; signal?: AbortSignal | undefined; headers?: Record<string, string> }

  async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
    return (await exchange(path, options)).body
  }

  async function exchange(path: string, { method = 'GET', body: payload, csrfToken, signal, headers: extraHeaders }: RequestOptions = {}): Promise<{ body: unknown; response: Response }> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        // The session is an HttpOnly cookie; the browser attaches it. JavaScript never sees it.
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...extraHeaders,
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
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
    return { body, response }
  }

  const getJson = (path: string, signal?: AbortSignal) => request(path, { signal })

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

    /** Published upcoming online-training cohorts (two linked Fridays each). */
    async listCohorts(query: { product?: string; limit?: number } = {}, signal?: AbortSignal): Promise<PublicCohort[]> {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
      return expectList(await getJson(`/cohorts${params.size ? `?${params}` : ''}`, signal), isPublicCohort)
    },

    /** Low-level validated JSON request (used by the admin API module). */
    send: request,

    // ---- authentication (Stage 4A) ----

    /** Current session. A 401 ApiError means "signed out"; 503 means sign-in is unavailable. */
    async getMe(signal?: AbortSignal): Promise<MeResponse> {
      return expectData(await request('/auth/me', { signal }), isMeResponse)
    },

    /** Ends the session; returns the identity provider's sign-out URL (or null). */
    async logout(csrfToken: string): Promise<{ logoutUrl: string | null }> {
      return expectData(await request('/auth/logout', { method: 'POST', csrfToken }), isLogoutResponse)
    },

    async getProfile(signal?: AbortSignal): Promise<AuthUser> {
      return expectData(await request('/me/profile', { signal }), isAuthUser)
    },

    async updateProfile(csrfToken: string, displayName: string | null): Promise<AuthUser> {
      return expectData(await request('/me/profile', { method: 'PATCH', csrfToken, body: { displayName } }), isAuthUser)
    },

    // ---- bookings (Stage 4C) ----

    /**
     * Requests a booking. The server validates everything, snapshots the price and holds a seat; the
     * result is PENDING_PAYMENT (no payment is taken). Reuse the same idempotency key to retry safely.
     */
    async createBooking(csrfToken: string, booking: BookingRequest, idempotencyKey: string): Promise<{ booking: CustomerBooking; replayed: boolean }> {
      const { body, response } = await exchange('/me/bookings', { method: 'POST', csrfToken, body: booking, headers: { 'Idempotency-Key': idempotencyKey } })
      if (response.status !== 200 && response.status !== 201) throw new ApiError('invalid-response', 'The server sent an unexpected response.', { status: response.status })
      return { booking: expectData(body, isCustomerBooking), replayed: response.status === 200 }
    },

    async listMyBookings(params: { page?: number; pageSize?: number; status?: BookingStatus } = {}, signal?: AbortSignal): Promise<{ items: CustomerBooking[]; meta: PageMeta }> {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value))
      const body = await request(`/me/bookings${search.size ? `?${search}` : ''}`, { signal })
      const items = expectList(body, isCustomerBooking)
      if (!isObject(body) || !isPageMeta(body.meta)) throw new ApiError('invalid-response', 'The server sent an unexpected response.')
      return { items, meta: body.meta }
    },

    /**
     * Asks DIY Forests to cancel a CONFIRMED booking. The booking stays active until our team decides; the
     * refund percentage returned is eligibility only, fixed now. An already pending request is returned again.
     */
    async requestCancellation(csrfToken: string, bookingId: string, reason: string | null): Promise<{ request: CancellationRequest; booking: CustomerBooking }> {
      const body = await request(`/me/bookings/${encodeURIComponent(bookingId)}/cancellation-request`, { method: 'POST', csrfToken, body: reason ? { reason } : {} })
      if (isObject(body) && isObject(body.data) && isCancellationRequest(body.data.request) && isCustomerBooking(body.data.booking)) return { request: body.data.request, booking: body.data.booking }
      throw new ApiError('invalid-response', 'The server sent an unexpected response.')
    },

    async cancelMyBooking(csrfToken: string, bookingId: string, reason: string | null): Promise<CustomerBooking> {
      return expectData(await request(`/me/bookings/${encodeURIComponent(bookingId)}/cancel`, { method: 'POST', csrfToken, body: reason ? { reason } : {} }), isCustomerBooking)
    },

    // ---- Stage 2: development payment simulator (fake payments only, never real money) ----

    /** Whether the server's development payment simulator is enabled. */
    async getPaymentConfig(signal?: AbortSignal): Promise<PaymentConfig> {
      return expectData(await request('/payments/config', { signal }), isPaymentConfig)
    },

    // The simulator's write calls live in bookings/simulator-api.ts (dev builds only).

    /** Server-side admin check. 403 = signed in but not an admin. */
    async getAdminMe(signal?: AbortSignal): Promise<AdminMeResponse> {
      return expectData(await request('/admin/me', { signal }), isAdminMeResponse)
    },

    /** Full-page navigations (not fetch): the backend redirects to the identity provider. */
    signInUrl(returnTo = '/account') {
      return `${root}/auth/login?returnTo=${encodeURIComponent(returnTo)}`
    },
    registerUrl(returnTo = '/account') {
      return `${root}/auth/register?returnTo=${encodeURIComponent(returnTo)}`
    },
    adminSignInUrl(returnTo = '/admin') {
      return `${root}/admin/auth/login?returnTo=${encodeURIComponent(returnTo)}`
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

/** Default client. VITE_API_BASE_URL is public build-time configuration; never put secrets in VITE_* variables. */
export const api = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? '' })
