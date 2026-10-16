import { z } from 'zod'
import { HttpError } from '../../lib/http-error.js'

// Every body schema is .strict(): unknown fields (e.g. "status", "isActive", "cohortId") are rejected,
// so state changes only happen through their dedicated, audited endpoints.

const SLUG = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lower-case words joined by hyphens, e.g. "weekend-workshop"')
const TEXT = (max: number) => z.string().trim().max(max).transform((value) => (value === '' ? null : value)).nullable()
const PRODUCT_TYPE = z.enum(['ONLINE_TRAINING', 'OFFLINE_WORKSHOP', 'WEBINAR'])
const INSTANT = z.iso.datetime({ offset: true, message: 'must be an ISO 8601 date-time with Z or an offset, e.g. 2026-11-06T18:30:00+05:30' }).transform((value) => new Date(value))
const CAPACITY = z.number().int('must be a whole number').min(1, 'must be at least 1').max(100_000).nullable()
const NOTE = TEXT(2000)
const VENUE = TEXT(200)

/** Exact money: a decimal string with up to 2 places (never a float), and an ISO 4217 code. No conversion. */
export const MONEY = z.object({
  amount: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be a non-negative amount like "149" or "1000.50" (at most 2 decimals)'),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO currency code such as INR or USD'),
}).strict()

export const productCreate = z.object({
  slug: SLUG,
  name: z.string().trim().min(1, 'must not be blank').max(160),
  type: PRODUCT_TYPE,
  summary: TEXT(500).optional(),
  description: TEXT(5000).optional(),
  audience: TEXT(500).optional(),
  durationLabel: TEXT(80).optional(),
  price: MONEY,
}).strict()

// The type cannot change after creation: sessions and cohorts are validated against it.
export const productUpdate = productCreate.omit({ type: true }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'provide at least one field to change')

export const sessionCreate = z.object({
  productId: z.uuid(),
  startsAt: INSTANT,
  endsAt: INSTANT.nullable().optional(),
  venue: VENUE.optional(),
  capacity: CAPACITY.optional(),
  internalNote: NOTE.optional(),
}).strict()

export const sessionUpdate = sessionCreate.omit({ productId: true }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'provide at least one field to change')

export const cohortCreate = z.object({
  productId: z.uuid(),
  firstSessionStartsAt: INSTANT,
  /** Optional cross-check from forms that show both dates; must equal first + 7 days. */
  secondSessionStartsAt: INSTANT.optional(),
  capacity: CAPACITY.optional(),
  internalNote: NOTE.optional(),
}).strict()

export const cohortUpdate = cohortCreate.omit({ productId: true }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'provide at least one field to change')

export const cancelBody = z.object({ reason: TEXT(500).optional() }).strict()

const page = { page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }
const STATUS = z.enum(['DRAFT', 'PUBLISHED', 'CANCELLED'])

export const productListQuery = z.object({ type: PRODUCT_TYPE.optional(), active: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional(), ...page }).strict()
export const sessionListQuery = z.object({
  type: z.enum(['OFFLINE_WORKSHOP', 'WEBINAR']).optional(), productId: z.uuid().optional(), status: STATUS.optional(),
  from: INSTANT.optional(), to: INSTANT.optional(), ...page,
}).strict()
export const cohortListQuery = z.object({ productId: z.uuid().optional(), status: STATUS.optional(), from: INSTANT.optional(), to: INSTANT.optional(), ...page }).strict()
export const idParams = z.object({ id: z.uuid({ message: 'must be a UUID' }) }).strict()

/** Parse or throw a 400 that names fields and rules, never echoing submitted values. */
export function parse<T>(schema: z.ZodType<T>, input: unknown, where: 'body' | 'query' | 'path'): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const detail = result.error.issues
    .map((issue) => (issue.code === 'unrecognized_keys' ? `unknown field(s): ${issue.keys.join(', ')}` : `${issue.path.join('.') || where}: ${issue.message}`))
    .join('; ')
  const code = where === 'body' ? 'INVALID_REQUEST' : where === 'query' ? 'INVALID_QUERY' : 'INVALID_PATH'
  throw new HttpError(400, code, `Invalid ${where}: ${detail}`)
}
