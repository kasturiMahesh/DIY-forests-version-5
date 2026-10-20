import { formatDateRange, formatDayMonth, formatSessionDateTime, formatTime } from '../api/format'
import type { BookingTarget, CustomerBooking } from '../api/types'

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

/** Plain wording: a pending booking holds a seat but nothing has been paid. */
export const bookingStatusLabel = (booking: Pick<CustomerBooking, 'status'>) =>
  booking.status === 'PENDING_PAYMENT' ? 'Pending payment · seat held, not yet paid' : 'Cancelled'

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
