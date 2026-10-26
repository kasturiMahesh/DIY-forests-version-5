// Revision 3 refund ELIGIBILITY rules (mirrored by the database functions; the integration tests check
// that the database accepts exactly these values). Exact milliseconds, no calendar days.
import { describe, expect, it } from 'vitest'
import { refundOutcomeFor, refundPercentFor, refundPolicyFor } from '../../src/modules/bookings/refund-policy.js'

const DAY = 86_400_000
const start = new Date('2026-11-20T04:30:00.000Z') // 10:00 IST, 20 November
const before = (ms: number) => new Date(start.getTime() - ms)

describe('refundPolicyFor', () => {
  it('webinars use WEBINAR_V1; online training, offline workshops and other types use TRAINING_V1', () => {
    expect(refundPolicyFor('WEBINAR')).toBe('WEBINAR_V1')
    expect(refundPolicyFor('ONLINE_TRAINING')).toBe('TRAINING_V1')
    expect(refundPolicyFor('OFFLINE_WORKSHOP')).toBe('TRAINING_V1')
    expect(refundPolicyFor('SOME_FUTURE_TRAINING')).toBe('TRAINING_V1')
  })
})

describe('refundPercentFor: TRAINING_V1 (online training and offline workshops alike)', () => {
  it.each([
    ['30 days before', 30 * DAY, 100],
    ['exactly 7 x 24h before (10:00 IST on 13 Nov)', 7 * DAY, 100],
    ['7 x 24h - 1 ms before', 7 * DAY - 1, 50],
    ['exactly 3 x 24h before (10:00 IST on 17 Nov)', 3 * DAY, 50],
    ['3 x 24h - 1 ms before', 3 * DAY - 1, 0],
    ['1 ms before the start', 1, 0],
  ])('%s: %i%%', (_label, ms, percent) => {
    expect(refundPercentFor('TRAINING_V1', start, before(ms))).toBe(percent)
    // Offline workshops share the policy with online training, so the same instant gives the same result.
    expect(refundPercentFor(refundPolicyFor('OFFLINE_WORKSHOP'), start, before(ms))).toBe(refundPercentFor(refundPolicyFor('ONLINE_TRAINING'), start, before(ms)))
  })

  it('at or after the start: no online request (null)', () => {
    expect(refundPercentFor('TRAINING_V1', start, start)).toBeNull()
    expect(refundPercentFor('TRAINING_V1', start, new Date(start.getTime() + 1))).toBeNull()
  })
})

describe('refundPercentFor: WEBINAR_V1', () => {
  it('1 ms before the start: 100%; at or after the start: outside the promise (null)', () => {
    expect(refundPercentFor('WEBINAR_V1', start, before(1))).toBe(100)
    expect(refundPercentFor('WEBINAR_V1', start, before(30 * DAY))).toBe(100)
    expect(refundPercentFor('WEBINAR_V1', start, start)).toBeNull()
  })
})

describe('refundOutcomeFor', () => {
  it('never claims money was received or refunded', () => {
    expect(refundOutcomeFor({ confirmationMethod: 'PAYMENT', confirmationReason: null, simulatedPaymentSucceeded: true })).toBe('NO_REFUND_SIMULATED_PAYMENT')
    expect(refundOutcomeFor({ confirmationMethod: 'MANUAL', confirmationReason: 'COMPLIMENTARY', simulatedPaymentSucceeded: false })).toBe('NO_REFUND_COMPLIMENTARY')
    expect(refundOutcomeFor({ confirmationMethod: 'MANUAL', confirmationReason: 'PAYMENT_ARRANGED_OFFLINE', simulatedPaymentSucceeded: false })).toBe('NOT_PROCESSED_BY_WEBSITE')
    expect(refundOutcomeFor({ confirmationMethod: 'MANUAL', confirmationReason: 'OTHER', simulatedPaymentSucceeded: false })).toBe('NOT_PROCESSED_BY_WEBSITE')
  })

  it('refuses combinations that would need a real payment provider', () => {
    expect(refundOutcomeFor({ confirmationMethod: 'PAYMENT', confirmationReason: null, simulatedPaymentSucceeded: false })).toBeNull()
    expect(refundOutcomeFor({ confirmationMethod: null, confirmationReason: null, simulatedPaymentSucceeded: false })).toBeNull()
  })
})
