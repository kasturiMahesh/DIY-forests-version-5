import { formatDateRange, formatDayMonth, formatSessionDateTime, formatTime } from '../api/format'
import type { BookingTarget, CancellationRequest, CustomerBooking, PaymentConfig } from '../api/types'

/**
 * Countries the server can validate phone numbers for (backend/src/modules/bookings/phone.ts).
 * The server is the authority: it normalizes the number and rejects anything it can't validate.
 */
export const PHONE_COUNTRIES = [
  { code: 'IN', dial: '91', label: 'India' },
  { code: 'US', dial: '1', label: 'United States' },
  { code: 'CA', dial: '1', label: 'Canada' },
  { code: 'GB', dial: '44', label: 'United Kingdom' },
  { code: 'AU', dial: '61', label: 'Australia' },
  { code: 'NZ', dial: '64', label: 'New Zealand' },
  { code: 'AE', dial: '971', label: 'United Arab Emirates' },
  { code: 'SG', dial: '65', label: 'Singapore' },
  { code: 'DE', dial: '49', label: 'Germany' },
  { code: 'FR', dial: '33', label: 'France' },
  { code: 'NL', dial: '31', label: 'Netherlands' },
  { code: 'AM', dial: '374', label: 'Armenia' },
] as const

/** The mandatory wording for every simulated confirmation (the server sends the same notice). */
export const SIMULATED_CONFIRMATION = 'Confirmed — simulated payment, no money received.'
/** The mandatory wording for every manual confirmation (the server sends the same notice). */
export const MANUAL_CONFIRMATION = 'Confirmed by DIY Forests. No payment was taken through this website. Our team will explain any agreed payment arrangements separately.'
export const AWAITING_LABEL = 'Awaiting confirmation · seat held, nothing paid'
export const EXPIRED_MESSAGE = 'We could not confirm your booking before the deadline, so your request has been cancelled and the seat released.'
export const CUTOFF_MESSAGE = 'Bookings close 24 hours before the start time. Please contact us if you’d like to join.'
/** The contact promise is an operational target, not an automated notification (no email service exists). */
export const CONTACT_TARGET = 'Our team aims to contact you by phone within 24 hours to confirm your booking and explain the next steps.'

/**
 * Plain wording: a pending booking holds a seat but nothing has been paid. A confirmed booking is
 * always described with the server's notice; a confirmation without one is still shown as simulated,
 * because no real payment provider exists yet.
 */
export function bookingStatusLabel(booking: Pick<CustomerBooking, 'status' | 'confirmation' | 'cancellation'>): string {
  if (booking.status === 'PENDING_PAYMENT') return 'Pending payment · seat held, not yet paid'
  if (booking.status === 'AWAITING_CONFIRMATION') return AWAITING_LABEL
  if (booking.status === 'CONFIRMED') return booking.confirmation?.notice ?? (booking.confirmation?.method === 'MANUAL' ? MANUAL_CONFIRMATION : SIMULATED_CONFIRMATION)
  if (booking.cancellation?.by === 'SYSTEM') return booking.cancellation.reason === 'Not confirmed in time' ? 'Cancelled · not confirmed in time' : 'Cancelled · payment not completed in time'
  return 'Cancelled'
}

/** The full explanation shown under a booking awaiting confirmation. */
export function awaitingConfirmationText(booking: Pick<CustomerBooking, 'status' | 'confirmationDueAt'>): string | null {
  if (booking.status !== 'AWAITING_CONFIRMATION' || !booking.confirmationDueAt) return null
  return `Your booking request has been received. We are holding your seat until ${formatClock(booking.confirmationDueAt)}. No payment has been taken through this website. ${CONTACT_TARGET} If we cannot confirm your request before the deadline, the request will be cancelled and the seat released.`
}

/** Truthful wording for a cancellation request: never says money was received or refunded. */
export function cancellationRequestText(request: CancellationRequest): string {
  if (request.status === 'PENDING') {
    return `Cancellation requested on ${formatClock(request.requestedAt)}. Under our policy this request is eligible for a ${request.refundPercent}% refund of any amount you paid. Our team will review it; your booking remains active until then.`
  }
  if (request.status === 'REJECTED') return `Your cancellation request was not approved: ${request.decisionReason ?? ''}. Your booking remains confirmed.`
  switch (request.refundOutcome) {
    case 'NO_REFUND_COMPLIMENTARY':
      return 'Your booking has been cancelled. This booking was complimentary, so there is no payment to refund.'
    case 'NO_REFUND_SIMULATED_PAYMENT':
      return 'Your booking has been cancelled. Its payment was a test-mode simulation: no money was received and no refund is issued.'
    default:
      return `Your booking has been cancelled. No payment was taken and no refund has been made through this website. If you paid our team directly, they will contact you about any refund due under our policy (${request.refundPercent}%).`
  }
}

const formatClock = (iso: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

/** "Seat held until …" for a pending booking with a payment deadline (older bookings have none). */
export function paymentDeadlineText(booking: Pick<CustomerBooking, 'status' | 'payment'>, now: Date = new Date()): string | null {
  const dueAt = booking.payment?.dueAt
  if (booking.status !== 'PENDING_PAYMENT' || !dueAt) return null
  if (Date.parse(dueAt) <= now.getTime()) return 'The 30-minute payment window has passed; this booking will be released.'
  return `Seat held until ${formatClock(dueAt)} (30 minutes from booking). Unpaid bookings are released automatically.`
}

/** When the booked dates are, in the visitor's own time zone. */
export function bookingWhen(target: BookingTarget): string {
  if (target.kind === 'cohort') {
    const [first, second] = [target.sessions.find((s) => s.sequence === 1), target.sessions.find((s) => s.sequence === 2)]
    if (!first || !second) return 'Dates to be confirmed'
    return `${formatDayMonth(first.startsAt)} & ${formatDayMonth(second.startsAt)} · ${formatTime(first.startsAt)}`
  }
  if (target.endsAt && target.venue) return `${formatDateRange(target.startsAt, target.endsAt)} · ${target.venue}`
  return formatSessionDateTime(target.startsAt)
}

/** Simulator controls appear only in a development build AND when the server reports the simulator enabled. */
export const simulatorAvailable = (isDevBuild: boolean, config: PaymentConfig | null) => isDevBuild && config?.simulator.enabled === true && config.realPayments === false
