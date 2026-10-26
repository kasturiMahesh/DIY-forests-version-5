import { describe, expect, it } from 'vitest'
import { money } from '../data'
import { formatPrice, formatSessionDateTime, getCountdown, staticMoney } from './format'

describe('formatPrice', () => {
  it('matches the site’s existing money() output for the catalog prices', () => {
    expect(formatPrice({ amount: '500.00', currency: 'USD' })).toBe(money(500, 'USD'))
    expect(formatPrice({ amount: '100000.00', currency: 'INR' })).toBe(money(100000, 'INR'))
    expect(formatPrice({ amount: '149.00', currency: 'INR' })).toBe('₹149')
    expect(formatPrice({ amount: '100000.00', currency: 'INR' })).toBe('₹1,00,000') // Indian grouping
  })

  it('keeps non-zero decimals exactly and never goes through floating point', () => {
    expect(formatPrice({ amount: '149.50', currency: 'INR' })).toBe('₹149.50')
    expect(formatPrice({ amount: '0.10', currency: 'USD' })).toBe('$0.10')
    expect(formatPrice({ amount: '9999999999.99', currency: 'USD' })).toBe('$9,999,999,999.99')
  })

  it('shows the ISO code for currencies without a known symbol (no conversion)', () => {
    expect(formatPrice({ amount: '20.00', currency: 'EUR' })).toBe('EUR 20')
  })

  it('builds static fallbacks in the API shape', () => {
    expect(staticMoney(500, 'USD')).toEqual({ amount: '500.00', currency: 'USD' })
  })
})

describe('formatSessionDateTime: one instant, shown in each visitor’s zone', () => {
  const instant = '2026-11-06T13:00:00.000Z' // Friday 18:30 in Asia/Kolkata

  it.each([
    ['Asia/Kolkata', 'Fri, 6 Nov · 6:30 PM'],
    ['America/New_York', 'Fri, 6 Nov · 8:00 AM'],
    ['Europe/London', 'Fri, 6 Nov · 1:00 PM'],
    ['Pacific/Auckland', 'Sat, 7 Nov · 2:00 AM'],
  ])('%s → %s', (zone, expected) => {
    expect(formatSessionDateTime(instant, zone)).toBe(expected)
  })

  it('accepts Date objects too', () => {
    expect(formatSessionDateTime(new Date(instant), 'UTC')).toBe('Fri, 6 Nov · 1:00 PM')
  })
})

describe('getCountdown', () => {
  it('counts down to the instant and completes at zero', () => {
    const target = new Date('2026-11-06T13:00:00.000Z')
    expect(getCountdown(target, new Date('2026-11-05T11:58:30.000Z'))).toEqual({ days: 1, hours: 1, minutes: 1, seconds: 30, complete: false })
    expect(getCountdown(target, new Date('2026-11-06T13:00:01.000Z'))).toMatchObject({ days: 0, complete: true })
  })
})
