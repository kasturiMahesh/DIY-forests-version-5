// Revision 3 refund ELIGIBILITY. Mirrors the database functions refund_policy_for, refund_percent_for and
// refund_outcome_for (migration 20261027090100), which re-check every stored value: keep them identical.
//
// A percentage is eligibility only. It is never turned into a money amount here (no amount is captured
// through the website), never shown as a completed refund, and never evidence that anyone paid.

export type ProductType = 'ONLINE_TRAINING' | 'OFFLINE_WORKSHOP' | 'WEBINAR'
export type RefundPolicy = 'TRAINING_V1' | 'WEBINAR_V1'
export type RefundOutcome = 'NO_REFUND_SIMULATED_PAYMENT' | 'NO_REFUND_COMPLIMENTARY' | 'NOT_PROCESSED_BY_WEBSITE'

const DAY_MS = 86_400_000

/** Webinars: WEBINAR_V1. Online training, offline workshops and any other (training) type: TRAINING_V1. */
export const refundPolicyFor = (type: string): RefundPolicy => (type === 'WEBINAR' ? 'WEBINAR_V1' : 'TRAINING_V1')

/**
 * Eligibility from the exact time remaining before the start (milliseconds, no calendar days), fixed at the
 * server time the request is submitted. null at or after the start: online requests are refused then.
 *   TRAINING_V1: >= 7 x 24h 100% · >= 3 x 24h 50% · otherwise 0%.   WEBINAR_V1: 100% strictly before start.
 */
export function refundPercentFor(policy: RefundPolicy, start: Date, requestedAt: Date): 0 | 50 | 100 | null {
  const remaining = start.getTime() - requestedAt.getTime()
  if (remaining <= 0) return null
  if (policy === 'WEBINAR_V1') return 100
  if (remaining >= 7 * DAY_MS) return 100
  if (remaining >= 3 * DAY_MS) return 50
  return 0
}

/**
 * What the website did about money when an approved request cancels a confirmed booking. Truthful by
 * construction: it never says a payment was or wasn't received offline, or that a refund was made.
 *   simulated payment -> NO_REFUND_SIMULATED_PAYMENT (no money ever existed)
 *   manual COMPLIMENTARY -> NO_REFUND_COMPLIMENTARY (no payment was due)
 *   manual PAYMENT_ARRANGED_OFFLINE / OTHER -> NOT_PROCESSED_BY_WEBSITE (anything arranged with staff is outside the website)
 * Anything else (e.g. a future real payment) is refused until provider refund work exists.
 */
export function refundOutcomeFor(booking: { confirmationMethod: string | null; confirmationReason: string | null; simulatedPaymentSucceeded: boolean }): RefundOutcome | null {
  if (booking.confirmationMethod === 'MANUAL') return booking.confirmationReason === 'COMPLIMENTARY' ? 'NO_REFUND_COMPLIMENTARY' : 'NOT_PROCESSED_BY_WEBSITE'
  if (booking.confirmationMethod === 'PAYMENT' && booking.simulatedPaymentSucceeded) return 'NO_REFUND_SIMULATED_PAYMENT'
  return null
}
