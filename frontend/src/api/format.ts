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
