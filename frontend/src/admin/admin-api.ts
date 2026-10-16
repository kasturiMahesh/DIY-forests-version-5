import { ApiError, type ApiClient } from '../api/client'
import type { AdminCohort, AdminProduct, AdminSession, DashboardSummary, Money, Paged, ProductType, ScheduleStatus } from '../api/types'

// Typed client for the Stage 4B admin API. Every call goes through the shared transport (cookies,
// timeouts, error envelopes). Writes send the session's CSRF token. Responses are shape-checked.

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasId = (value: unknown): value is Record<string, unknown> & { id: string } => isObject(value) && typeof value.id === 'string'
const isProduct = (value: unknown): value is AdminProduct => hasId(value) && typeof value.slug === 'string' && typeof value.isActive === 'boolean' && isObject(value.price) && typeof value.price.amount === 'string'
const isSession = (value: unknown): value is AdminSession => hasId(value) && typeof value.startsAt === 'string' && typeof value.status === 'string' && isObject(value.product)
const isCohort = (value: unknown): value is AdminCohort => hasId(value) && typeof value.status === 'string' && Array.isArray(value.sessions) && isObject(value.product)
const isDashboard = (value: unknown): value is DashboardSummary => isObject(value) && isObject(value.products) && isObject(value.upcoming)

const unexpected = () => new ApiError('invalid-response', 'The server sent an unexpected response.')
function item<T>(body: unknown, guard: (value: unknown) => value is T): T {
  if (isObject(body) && guard(body.data)) return body.data
  throw unexpected()
}
function page<T>(body: unknown, guard: (value: unknown) => value is T): Paged<T> {
  if (isObject(body) && Array.isArray(body.data) && body.data.every(guard) && isObject(body.meta) && typeof body.meta.total === 'number') {
    return { items: body.data, meta: body.meta as Paged<T>['meta'] }
  }
  throw unexpected()
}
const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value))
  return search.size ? `?${search}` : ''
}

export type ProductForm = { slug: string; name: string; type: ProductType; summary: string | null; description: string | null; audience: string | null; durationLabel: string | null; price: Money }
export type ProductChanges = Partial<Omit<ProductForm, 'type'>>
export type SessionForm = { productId: string; startsAt: string; endsAt?: string | null; venue?: string | null; capacity?: number | null; internalNote?: string | null }
export type SessionChanges = Partial<Omit<SessionForm, 'productId'>>
export type CohortForm = { productId: string; firstSessionStartsAt: string; secondSessionStartsAt?: string; capacity?: number | null; internalNote?: string | null }
export type CohortChanges = Partial<Omit<CohortForm, 'productId'>>
export type ListParams = { page?: number; pageSize?: number }

export function createAdminApi(client: ApiClient, csrfToken: string) {
  const get = (path: string, signal?: AbortSignal) => client.send(`/admin${path}`, { signal })
  const post = (path: string, body: unknown = {}) => client.send(`/admin${path}`, { method: 'POST', body, csrfToken })
  const patch = (path: string, body: unknown) => client.send(`/admin${path}`, { method: 'PATCH', body, csrfToken })
  const id = (value: string) => encodeURIComponent(value)

  return {
    dashboard: async (signal?: AbortSignal) => item(await get('/dashboard', signal), isDashboard),

    listProducts: async (params: ListParams & { type?: ProductType; active?: boolean; q?: string } = {}, signal?: AbortSignal) =>
      page(await get(`/products${query(params)}`, signal), isProduct),
    getProduct: async (productId: string, signal?: AbortSignal) => item(await get(`/products/${id(productId)}`, signal), isProduct),
    createProduct: async (form: ProductForm) => item(await post('/products', form), isProduct),
    updateProduct: async (productId: string, changes: ProductChanges) => item(await patch(`/products/${id(productId)}`, changes), isProduct),
    setProductActive: async (productId: string, active: boolean) => item(await post(`/products/${id(productId)}/${active ? 'activate' : 'deactivate'}`), isProduct),

    listSessions: async (params: ListParams & { type?: 'WEBINAR' | 'OFFLINE_WORKSHOP'; status?: ScheduleStatus; productId?: string } = {}, signal?: AbortSignal) =>
      page(await get(`/sessions${query(params)}`, signal), isSession),
    createSession: async (form: SessionForm) => item(await post('/sessions', form), isSession),
    updateSession: async (sessionId: string, changes: SessionChanges) => item(await patch(`/sessions/${id(sessionId)}`, changes), isSession),
    publishSession: async (sessionId: string) => item(await post(`/sessions/${id(sessionId)}/publish`), isSession),
    cancelSession: async (sessionId: string, reason: string | null) => item(await post(`/sessions/${id(sessionId)}/cancel`, { reason }), isSession),

    listCohorts: async (params: ListParams & { status?: ScheduleStatus; productId?: string } = {}, signal?: AbortSignal) =>
      page(await get(`/cohorts${query(params)}`, signal), isCohort),
    createCohort: async (form: CohortForm) => item(await post('/cohorts', form), isCohort),
    updateCohort: async (cohortId: string, changes: CohortChanges) => item(await patch(`/cohorts/${id(cohortId)}`, changes), isCohort),
    publishCohort: async (cohortId: string) => item(await post(`/cohorts/${id(cohortId)}/publish`), isCohort),
    cancelCohort: async (cohortId: string, reason: string | null) => item(await post(`/cohorts/${id(cohortId)}/cancel`, { reason }), isCohort),
  }
}

export type AdminApi = ReturnType<typeof createAdminApi>
