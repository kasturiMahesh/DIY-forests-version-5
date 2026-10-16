// Mirrors the backend's documented catalog API (backend/src/modules/catalog/catalog.types.ts).

export type ProductType = 'ONLINE_TRAINING' | 'OFFLINE_WORKSHOP' | 'WEBINAR'

/** Exact decimal amount as a string with two decimals (e.g. "100000.00"). Never parse into a float for money maths. */
export type Money = { amount: string; currency: string }

export type PublicProduct = {
  id: string
  slug: string
  name: string
  type: ProductType
  summary: string | null
  description: string | null
  audience: string | null
  durationLabel: string | null
  price: Money
}

export type PublicProductRef = Pick<PublicProduct, 'id' | 'slug' | 'name' | 'type' | 'price'>

export type PublicSession = {
  id: string
  /** ISO 8601 UTC instant. Display it in the visitor's own time zone. */
  startsAt: string
  endsAt: string | null
  /** Organizer's IANA zone (Asia/Kolkata). */
  timezone: string
  capacity: number | null
  /** Venue of an in-person session (offline workshop); null/absent for online sessions. */
  venue?: string | null
  product: PublicProductRef
}

/** A published online training: two 4-hour sessions on consecutive Fridays, offered as one. */
export type PublicCohort = {
  id: string
  timezone: string
  capacity: number | null
  product: PublicProductRef
  sessions: { sequence: 1 | 2; startsAt: string; endsAt: string }[]
}

export type SessionListMeta = { from: string; limit: number; count: number }

export type SessionQuery = { type?: ProductType; product?: string; from?: string; limit?: number }

// ---- authentication (Stage 4A) ----

export type Role = 'CUSTOMER' | 'ADMIN'

/** The signed-in account. Roles come from the server; the client never decides them. */
export type AuthUser = { id: string; email: string; emailVerified: boolean; displayName: string | null; role: Role; pool: Role }

export type SessionInfo = { kind: Role; idleExpiresAt: string; absoluteExpiresAt: string }

export type MeResponse = { user: AuthUser; session: SessionInfo; csrfToken: string }

export type AdminMeResponse = { user: AuthUser; session: SessionInfo }

// ---- admin management (Stage 4B) ----

export type ScheduleStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED'
export type AdminProductRef = { id: string; slug: string; name: string; type: ProductType; isActive: boolean }
export type AdminProduct = {
  id: string; slug: string; name: string; type: ProductType; summary: string | null; description: string | null; audience: string | null
  durationLabel: string | null; price: Money; isActive: boolean; createdAt: string; updatedAt: string
  scheduleCounts?: Record<ScheduleStatus, number>
}
export type AdminSession = {
  id: string; startsAt: string; endsAt: string | null; timezone: string; capacity: number | null; status: ScheduleStatus
  venue: string | null; internalNote: string | null; cohortId: string | null; cohortSequence: number | null; product: AdminProductRef
  createdAt: string; updatedAt: string
}
export type AdminCohort = {
  id: string; status: ScheduleStatus; timezone: string; capacity: number | null; internalNote: string | null; product: AdminProductRef
  sessions: { id: string; sequence: number; startsAt: string; endsAt: string | null; status: ScheduleStatus }[]
  createdAt: string; updatedAt: string
}
export type PageMeta = { page: number; pageSize: number; total: number }
export type Paged<T> = { items: T[]; meta: PageMeta }
export type DashboardSummary = {
  products: { active: number; inactive: number }
  upcoming: Record<ProductType, { published: number; draft: number; next: { id: string; startsAt: string; productName: string; kind: 'session' | 'cohort' }[] }>
  cancelledUpcoming: number
  capacityTracking: string
}
