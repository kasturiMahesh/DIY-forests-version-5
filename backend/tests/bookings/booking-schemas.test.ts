import { describe, expect, it } from 'vitest'
import { dbFailure, isCheckViolation, isUniqueViolation, sanitizedDbError } from '../../src/lib/db-errors.js'
import { HttpError } from '../../src/lib/http-error.js'
import { newReference } from '../../src/modules/bookings/booking.repository.js'
import { adminCancelBody, bookingCreate, customerCancelBody, idempotencyKeyOrThrow, phoneOrThrow } from '../../src/modules/bookings/booking.schemas.js'

// Unit tests: request validation and error mapping, no database.

const valid = { productId: '0199a000-0000-7000-8000-000000000001', sessionId: '0199a000-0000-7000-8000-000000000002', contactName: 'Asha Rao', phone: { country: 'IN', number: '9876543210' } }

describe('bookingCreate', () => {
  it('accepts a session booking and a cohort booking', () => {
    expect(bookingCreate.safeParse(valid).success).toBe(true)
    const { sessionId: _unused, ...rest } = valid
    expect(bookingCreate.safeParse({ ...rest, cohortId: valid.sessionId }).success).toBe(true)
  })

  it.each([
    ['both targets', { ...valid, cohortId: valid.sessionId }],
    ['no target', { productId: valid.productId, contactName: 'A', phone: valid.phone }],
    ['a client-supplied price', { ...valid, price: { amount: '1.00', currency: 'INR' } }],
    ['a client-supplied status', { ...valid, status: 'PAID' }],
    ['a client-supplied user', { ...valid, userId: valid.productId }],
    ['a non-UUID product', { ...valid, productId: 'online-training' }],
    ['a blank name', { ...valid, contactName: '   ' }],
    ['markup in the name', { ...valid, contactName: '<script>' }],
    ['digits in the name', { ...valid, contactName: 'Agent 007' }],
    ['a 101-character name', { ...valid, contactName: 'a'.repeat(101) }],
    ['a lower-case country', { ...valid, phone: { country: 'in', number: '9876543210' } }],
    ['extra phone fields', { ...valid, phone: { ...valid.phone, e164: '+1' } }],
  ])('rejects %s', (_label, body) => {
    expect(bookingCreate.safeParse(body).success).toBe(false)
  })

  it('accepts names in any script, with common punctuation', () => {
    for (const contactName of ['Anne-Marie O’Neil', 'J. R. Smith', 'शुभेंदु शर्मा', 'Zoë d\'Arc']) {
      expect(bookingCreate.safeParse({ ...valid, contactName }).success, contactName).toBe(true)
    }
  })

  it('phoneOrThrow → 400 with a stable code', () => {
    expect(phoneOrThrow({ country: 'IN', number: '98765 43210' }).e164).toBe('+919876543210')
    expect(() => phoneOrThrow({ country: 'IN', number: '123' })).toThrow(expect.objectContaining({ status: 400, code: 'PHONE_INVALID' }))
    expect(() => phoneOrThrow({ country: 'ZZ', number: '123456789' })).toThrow(expect.objectContaining({ status: 400, code: 'PHONE_COUNTRY_UNSUPPORTED' }))
  })
})

describe('idempotency key', () => {
  it('requires a 16–64 character URL-safe key', () => {
    expect(idempotencyKeyOrThrow('a'.repeat(16))).toBe('a'.repeat(16))
    expect(idempotencyKeyOrThrow('0b1c2d3e-4f5a-6b7c_8d9e')).toBe('0b1c2d3e-4f5a-6b7c_8d9e')
    expect(() => idempotencyKeyOrThrow(undefined)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }))
    expect(() => idempotencyKeyOrThrow('short')).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_INVALID' }))
    expect(() => idempotencyKeyOrThrow('a'.repeat(65))).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_INVALID' }))
    expect(() => idempotencyKeyOrThrow('has spaces in it ok?')).toThrow(HttpError)
  })
})

describe('cancellation bodies', () => {
  it('admins must give a reason; customers may', () => {
    expect(adminCancelBody.safeParse({}).success).toBe(false)
    expect(adminCancelBody.safeParse({ reason: '  ' }).success).toBe(false)
    expect(adminCancelBody.safeParse({ reason: 'Venue flooded' }).success).toBe(true)
    expect(adminCancelBody.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false)
    expect(customerCancelBody.parse({})).toEqual({})
    expect(customerCancelBody.parse({ reason: ' ' })).toEqual({ reason: null })
    expect(customerCancelBody.safeParse({ reason: 'ok', status: 'PAID' }).success).toBe(false)
  })
})

describe('booking references', () => {
  it('match the bookings_reference_format CHECK and avoid ambiguous characters', () => {
    for (let i = 0; i < 200; i++) expect(newReference()).toMatch(/^DF-[2-9A-HJKMNP-Z]{8}$/)
  })
})

describe('database error helpers', () => {
  const adapterError = (prismaCode: string, cause: Record<string, unknown>) =>
    Object.assign(new Error(`Invalid \`prisma.booking.create()\` invocation: phone: "+919876543210"`), { code: prismaCode, meta: { driverAdapterError: { cause } } })
  const unique = adapterError('P2002', { originalCode: '23505', constraint: { index: 'bookings_user_id_idempotency_key_key' } })
  const check = adapterError('P2039', { code: '23514', message: 'new row for relation "sessions" violates check constraint "sessions_seats_held_within_capacity"', detail: 'Failing row contains (+919876543210)' })

  it('reads the SQLSTATE and constraint from Prisma 7 adapter errors', () => {
    expect(dbFailure(unique)).toEqual({ prismaCode: 'P2002', sqlState: '23505', constraint: 'bookings_user_id_idempotency_key_key' })
    expect(dbFailure(check)).toEqual({ prismaCode: 'P2039', sqlState: '23514', constraint: 'sessions_seats_held_within_capacity' })
    expect(isUniqueViolation(unique, 'bookings_user_id_idempotency_key_key')).toBe(true)
    expect(isUniqueViolation(unique, 'bookings_reference_key')).toBe(false)
    expect(isCheckViolation(check, 'sessions_seats_held_within_capacity')).toBe(true)
    expect(isCheckViolation(unique)).toBe(false)
    expect(isCheckViolation(new Error('boom'))).toBe(false)
  })

  it('sanitized errors keep codes and constraint names but never row data or the Prisma message', () => {
    for (const error of [unique, check]) {
      const safe = sanitizedDbError(error)
      expect(safe.message).not.toContain('+91')
      expect(safe.message).not.toContain('invocation')
      expect(safe.stack ?? '').not.toContain('+91')
    }
    expect(sanitizedDbError(check).message).toBe('Database error P2039 / SQLSTATE 23514 (sessions_seats_held_within_capacity)')
    expect(sanitizedDbError(new Error('connect ECONNREFUSED\nsecond line')).message).toBe('connect ECONNREFUSED')
  })
})
