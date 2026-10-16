import type { Money } from './types'

const SYMBOLS: Record<string, string> = { USD: '$', INR: '₹' }

/**
 * Format an exact decimal amount without going through floating point.
 * "500.00" USD → "$500", "100000.00" INR → "₹1,00,000", "149.50" INR → "₹149.50".
 * Same output as the site's existing money() for whole amounts.
 */
export function formatPrice({ amount, currency }: Money): string {
  const [whole = '0', fraction = '00'] = amount.split('.')
  const grouped = BigInt(whole).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US')
  const number = fraction === '00' ? grouped : `${grouped}.${fraction}`
  const symbol = SYMBOLS[currency]
  return symbol ? `${symbol}${number}` : `${currency} ${number}`
}

/** Static (pre-API) price in the same shape as the API. */
export const staticMoney = (amount: number, currency: string): Money => ({ amount: amount.toFixed(2), currency })

/**
 * The site's date style ("Tue, 13 Oct · 6:30 PM") for one fixed instant, shown in the
 * visitor's own time zone (or `timeZone` when given, e.g. in tests).
 */
export function formatSessionDateTime(instant: string | Date, timeZone?: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, ...(timeZone ? { timeZone } : {}),
    }).formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.weekday}, ${parts.day} ${parts.month} · ${parts.hour}:${parts.minute} ${parts.dayPeriod}`
}

export type Countdown = { days: number; hours: number; minutes: number; seconds: number; complete: boolean }

export function getCountdown(target: Date, now: Date): Countdown {
  const remaining = Math.max(0, target.getTime() - now.getTime())
  const seconds = Math.floor(remaining / 1000)
  return {
    days: Math.floor(seconds / 86400),
    hours: Math.floor((seconds % 86400) / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
    complete: remaining === 0,
  }
}

const part = (instant: string | Date, options: Intl.DateTimeFormatOptions, timeZone?: string) =>
  Object.fromEntries(new Intl.DateTimeFormat('en-US', { ...options, ...(timeZone ? { timeZone } : {}) }).formatToParts(typeof instant === 'string' ? new Date(instant) : instant).map((p) => [p.type, p.value]))

/** "Fri, 6 Nov" in the visitor's zone (or `timeZone`). */
export function formatDayMonth(instant: string | Date, timeZone?: string): string {
  const p = part(instant, { weekday: 'short', day: 'numeric', month: 'short' }, timeZone)
  return `${p.weekday}, ${p.day} ${p.month}`
}

/** "6:30 PM" in the visitor's zone (or `timeZone`). */
export function formatTime(instant: string | Date, timeZone?: string): string {
  const p = part(instant, { hour: 'numeric', minute: '2-digit', hour12: true }, timeZone)
  return `${p.hour}:${p.minute} ${p.dayPeriod}`
}

/** The site's batch style: "17–21 Oct", or "28 Nov – 2 Dec" across months, in the visitor's zone. */
export function formatDateRange(start: string | Date, end: string | Date, timeZone?: string): string {
  const a = part(start, { day: 'numeric', month: 'short' }, timeZone)
  const b = part(end, { day: 'numeric', month: 'short' }, timeZone)
  return a.month === b.month ? `${a.day}–${b.day} ${b.month}` : `${a.day} ${a.month} – ${b.day} ${b.month}`
}

/** Calendar days covered, counting both the first and the last day (e.g. Sat–Wed = 5). */
export function calendarDaysInclusive(start: string | Date, end: string | Date, timeZone?: string): number {
  const day = (instant: string | Date) => {
    const p = part(instant, { year: 'numeric', month: 'numeric', day: 'numeric' }, timeZone)
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))
  }
  return Math.round((day(end) - day(start)) / 86_400_000) + 1
}
