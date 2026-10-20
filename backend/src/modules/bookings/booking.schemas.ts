import { z } from 'zod'
import { HttpError } from '../../lib/http-error.js'
import { normalizePhone } from './phone.js'

// Every body is .strict(): price, currency, status, userId, reference … can never be supplied by a
// client. The price is always snapshotted from the product on the server.

/** Same rule as the bookings_idempotency_key_format CHECK. Clients send a fresh random key per attempt. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'

// Letters, marks, spaces and common name punctuation; no control characters or markup.
const CONTACT_NAME = z.string().trim().min(1, 'must not be blank').max(100, 'must be at most 100 characters')
  .regex(/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u, 'may contain only letters, spaces and . \' -')

export const bookingCreate = z.object({
  productId: z.uuid({ message: 'must be a UUID' }),
  /** Webinar or offline-workshop session. Exactly one of sessionId / cohortId. */
  sessionId: z.uuid({ message: 'must be a UUID' }).optional(),
  /** Online-training cohort (both linked Friday sessions). */
  cohortId: z.uuid({ message: 'must be a UUID' }).optional(),
  contactName: CONTACT_NAME,
  phone: z.object({
    country: z.string().trim().regex(/^[A-Z]{2}$/, 'must be an ISO 3166 country code such as IN'),
    number: z.string().max(32, 'is too long'),
  }).strict(),
}).strict().refine((value) => (value.sessionId === undefined) !== (value.cohortId === undefined), { message: 'provide exactly one of sessionId or cohortId', path: ['target'] })

/** Customers may say why; admins must (see adminCancelBody). */
export const customerCancelBody = z.object({ reason: z.string().trim().max(500).transform((value) => (value === '' ? null : value)).nullable().optional() }).strict()
export const adminCancelBody = z.object({ reason: z.string().trim().min(3, 'must explain the cancellation (at least 3 characters)').max(500) }).strict()

const page = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }
const STATUS = z.enum(['PENDING_PAYMENT', 'CANCELLED'])
const INSTANT = z.iso.datetime({ offset: true, message: 'must be an ISO 8601 date-time with Z or an offset' }).transform((value) => new Date(value))

export const customerListQuery = z.object({ status: STATUS.optional(), ...page }).strict()
export const adminListQuery = z.object({
  status: STATUS.optional(),
  productId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  cohortId: z.uuid().optional(),
  /** Booking reference (exact, e.g. DF-7K2M9QXA) or part of the customer's email. */
  q: z.string().trim().min(2).max(100).optional(),
  createdFrom: INSTANT.optional(),
  createdTo: INSTANT.optional(),
  ...page,
}).strict()

export type BookingCreateBody = z.infer<typeof bookingCreate>

/** Validates the phone server-side; a 400 names the rule and never echoes the number. */
export function phoneOrThrow(phone: BookingCreateBody['phone']) {
  const result = normalizePhone(phone.country, phone.number)
  if (!result.ok) throw new HttpError(400, result.code, result.message)
  return result.phone
}

export function idempotencyKeyOrThrow(value: string | undefined): string {
  if (value === undefined || value === '') throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', `Send an ${IDEMPOTENCY_HEADER} header (16–64 letters, digits, "-" or "_") with each booking request`)
  if (!IDEMPOTENCY_KEY.test(value)) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', `${IDEMPOTENCY_HEADER} must be 16–64 letters, digits, "-" or "_"`)
  return value
}
