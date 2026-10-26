import { describe, expect, it } from 'vitest'
import { ORGANIZER_TIMEZONE, TimeZoneError, formatInstantInZone, instantToZonedTime, isValidTimeZone, zonedTimeToInstant } from '../src/lib/time.js'

describe('zonedTimeToInstant', () => {
  it('converts organizer-local IST to the single UTC instant', () => {
    expect(ORGANIZER_TIMEZONE).toBe('Asia/Kolkata')
    expect(zonedTimeToInstant({ year: 2026, month: 10, day: 13, hour: 18, minute: 30 }, 'Asia/Kolkata').toISOString()).toBe('2026-10-13T13:00:00.000Z')
    // Crosses midnight UTC backwards
    expect(zonedTimeToInstant({ year: 2027, month: 1, day: 1, hour: 2, minute: 0 }, 'Asia/Kolkata').toISOString()).toBe('2026-12-31T20:30:00.000Z')
  })

  it('does not depend on the machine time zone (same input → same instant)', () => {
    const a = zonedTimeToInstant({ year: 2026, month: 10, day: 16, hour: 18, minute: 30 }, 'Asia/Kolkata')
    const b = zonedTimeToInstant({ year: 2026, month: 10, day: 16, hour: 18, minute: 30 }, 'Asia/Kolkata')
    expect(a.getTime()).toBe(b.getTime())
    expect(a.toISOString()).toBe('2026-10-16T13:00:00.000Z')
  })

  it('handles zones with daylight saving on both sides of the change', () => {
    expect(zonedTimeToInstant({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedTimeToInstant({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z')
  })

  it('rejects a wall-clock time skipped by a DST change', () => {
    expect(() => zonedTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')).toThrow(/does not exist/)
  })

  it('rejects a wall-clock time repeated by a DST change (ambiguous)', () => {
    expect(() => zonedTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')).toThrow(/ambiguous/)
  })

  it.each([
    [{ year: 2026, month: 2, day: 30, hour: 10, minute: 0 }],
    [{ year: 2026, month: 13, day: 1, hour: 10, minute: 0 }],
    [{ year: 2026, month: 1, day: 1, hour: 24, minute: 0 }],
  ])('rejects invalid local date-time %j', (local) => {
    expect(() => zonedTimeToInstant(local, 'Asia/Kolkata')).toThrow(TimeZoneError)
  })

  it('rejects unknown time zones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(() => zonedTimeToInstant({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 }, 'Mars/Olympus')).toThrow(/Unknown time zone/)
  })
})

describe('round trip and visitor display', () => {
  it('organizer local → instant → organizer local is lossless', () => {
    const local = { year: 2026, month: 11, day: 6, hour: 18, minute: 30 }
    expect(instantToZonedTime(zonedTimeToInstant(local, 'Asia/Kolkata'), 'Asia/Kolkata')).toEqual(local)
  })

  it('shows the same instant differently to visitors in other zones', () => {
    const instant = zonedTimeToInstant({ year: 2026, month: 10, day: 13, hour: 18, minute: 30 }, 'Asia/Kolkata')
    expect(instantToZonedTime(instant, 'America/New_York')).toEqual({ year: 2026, month: 10, day: 13, hour: 9, minute: 0 })
    expect(instantToZonedTime(instant, 'Europe/London')).toEqual({ year: 2026, month: 10, day: 13, hour: 14, minute: 0 })
    expect(instantToZonedTime(instant, 'Pacific/Auckland')).toEqual({ year: 2026, month: 10, day: 14, hour: 2, minute: 0 })
    expect(formatInstantInZone(instant, 'Asia/Kolkata')).toMatch(/13 Oct 2026.*6:30.*pm.*IST/i)
  })
})
