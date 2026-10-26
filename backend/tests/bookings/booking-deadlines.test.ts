// Revision 3 deadlines: bookings close 24 hours before the start; a manual request is held until
// min(booking + 48 hours, start - 24 hours). Confirmation is allowed while now < deadline; expiry applies
// from deadline <= now.
import { describe, expect, it } from 'vitest'
import { bookingCutoff, confirmationDueAt, isOverdue } from '../../src/modules/bookings/booking-holds.js'

const HOUR = 3_600_000
const start = new Date('2026-11-20T04:30:00.000Z')

describe('bookingCutoff', () => {
  it('is exactly 24 hours before the start', () => {
    expect(bookingCutoff(start).getTime()).toBe(start.getTime() - 24 * HOUR)
  })
})

describe('confirmationDueAt', () => {
  it('is booking + 48 hours when the start is far away', () => {
    const now = new Date(start.getTime() - 10 * 24 * HOUR)
    expect(confirmationDueAt(now, start).getTime()).toBe(now.getTime() + 48 * HOUR)
  })
  it('is start - 24 hours when that is earlier', () => {
    const now = new Date(start.getTime() - 30 * HOUR)
    expect(confirmationDueAt(now, start).getTime()).toBe(start.getTime() - 24 * HOUR)
  })
  it('both formulas meet exactly 72 hours before the start', () => {
    const now = new Date(start.getTime() - 72 * HOUR)
    expect(confirmationDueAt(now, start).getTime()).toBe(now.getTime() + 48 * HOUR)
    expect(confirmationDueAt(now, start).getTime()).toBe(start.getTime() - 24 * HOUR)
  })
})

describe('isOverdue (expiry boundary)', () => {
  const due = new Date('2026-11-01T00:00:00.000Z')
  it('awaiting confirmation: overdue at and after the deadline, not 1 ms before', () => {
    expect(isOverdue({ status: 'AWAITING_CONFIRMATION', paymentDueAt: null, confirmationDueAt: due }, new Date(due.getTime() - 1))).toBe(false)
    expect(isOverdue({ status: 'AWAITING_CONFIRMATION', paymentDueAt: null, confirmationDueAt: due }, due)).toBe(true)
  })
  it('grandfathered bookings (no deadline) are never overdue', () => {
    expect(isOverdue({ status: 'PENDING_PAYMENT', paymentDueAt: null, confirmationDueAt: null }, new Date('2100-01-01T00:00:00Z'))).toBe(false)
  })
  it('confirmed and cancelled bookings are never overdue', () => {
    expect(isOverdue({ status: 'CONFIRMED', paymentDueAt: null, confirmationDueAt: due }, new Date(due.getTime() + HOUR))).toBe(false)
    expect(isOverdue({ status: 'CANCELLED', paymentDueAt: due, confirmationDueAt: null }, new Date(due.getTime() + HOUR))).toBe(false)
  })
})
