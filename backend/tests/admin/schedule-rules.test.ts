import { describe, expect, it } from 'vitest'
import { HttpError } from '../../src/lib/http-error.js'
import { addCalendarDays, checkSingleSession, cohortTimesAreValid, deriveCohortTimes, weekdayIn } from '../../src/modules/admin/schedule-rules.js'

const NOW = new Date('2026-10-16T06:00:00Z') // Fri 16 Oct 2026, 11:30 IST
const FRI_6_NOV_1830_IST = new Date('2026-11-06T13:00:00Z')

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError)
    return (error as HttpError).code
  }
  throw new Error('expected an HttpError')
}

describe('weekdayIn / addCalendarDays', () => {
  it('evaluates the weekday in the organizer zone, not UTC', () => {
    // 20:00 UTC Thursday = 01:30 IST Friday
    expect(weekdayIn(new Date('2026-11-05T20:00:00Z'), 'Asia/Kolkata')).toBe(5)
    expect(weekdayIn(new Date('2026-11-05T20:00:00Z'), 'UTC')).toBe(4)
  })

  it('adds calendar days keeping the wall-clock time, even across a DST change', () => {
    expect(addCalendarDays(FRI_6_NOV_1830_IST, 7, 'Asia/Kolkata').toISOString()).toBe('2026-11-13T13:00:00.000Z')
    // New York leaves DST on 1 Nov 2026: 18:30 local stays 18:30 local, the UTC gap is 7 days + 1 hour.
    const before = new Date('2026-10-30T22:30:00Z') // Fri 30 Oct 18:30 EDT
    expect(addCalendarDays(before, 7, 'America/New_York').toISOString()).toBe('2026-11-06T23:30:00.000Z')
  })
})

describe('deriveCohortTimes (online training: two 4-hour Fridays, one week apart)', () => {
  it('derives the second Friday and 4-hour sessions from the first start', () => {
    const times = deriveCohortTimes(FRI_6_NOV_1830_IST, undefined, NOW)
    expect(times.first).toEqual({ startsAt: FRI_6_NOV_1830_IST, endsAt: new Date('2026-11-06T17:00:00Z') })
    expect(times.second).toEqual({ startsAt: new Date('2026-11-13T13:00:00Z'), endsAt: new Date('2026-11-13T17:00:00Z') })
  })

  it('accepts a matching explicit second date and rejects any other', () => {
    expect(deriveCohortTimes(FRI_6_NOV_1830_IST, new Date('2026-11-13T13:00:00Z'), NOW).second.startsAt.toISOString()).toBe('2026-11-13T13:00:00.000Z')
    expect(code(() => deriveCohortTimes(FRI_6_NOV_1830_IST, new Date('2026-11-20T13:00:00Z'), NOW))).toBe('SECOND_SESSION_MISMATCH') // two weeks
    expect(code(() => deriveCohortTimes(FRI_6_NOV_1830_IST, new Date('2026-11-13T13:30:00Z'), NOW))).toBe('SECOND_SESSION_MISMATCH') // other time
  })

  it.each([
    ['a Thursday', new Date('2026-11-05T13:00:00Z')],
    ['a Saturday', new Date('2026-11-07T13:00:00Z')],
    ['Friday in UTC but Saturday in IST', new Date('2026-11-06T19:00:00Z')],
  ])('rejects %s', (_label, start) => {
    expect(code(() => deriveCohortTimes(start, undefined, NOW))).toBe('NOT_A_FRIDAY')
  })

  it('rejects a start in the past', () => {
    expect(code(() => deriveCohortTimes(new Date('2026-10-09T13:00:00Z'), undefined, NOW))).toBe('START_IN_PAST')
  })
})

describe('cohortTimesAreValid (checked again before publishing)', () => {
  const ok = [
    { cohortSequence: 1, startsAt: FRI_6_NOV_1830_IST, endsAt: new Date('2026-11-06T17:00:00Z') },
    { cohortSequence: 2, startsAt: new Date('2026-11-13T13:00:00Z'), endsAt: new Date('2026-11-13T17:00:00Z') },
  ]
  it('accepts two valid sessions', () => expect(cohortTimesAreValid(ok)).toBe(true))
  it.each([
    ['only one session', [ok[0]!]],
    ['two "session 1"s', [ok[0]!, { ...ok[1]!, cohortSequence: 1 }]],
    ['a 3-hour session', [ok[0]!, { ...ok[1]!, endsAt: new Date('2026-11-13T16:00:00Z') }]],
    ['a missing end', [ok[0]!, { ...ok[1]!, endsAt: null }]],
    ['two weeks apart', [ok[0]!, { ...ok[1]!, startsAt: new Date('2026-11-20T13:00:00Z'), endsAt: new Date('2026-11-20T17:00:00Z') }]],
  ])('rejects %s', (_label, sessions) => expect(cohortTimesAreValid(sessions)).toBe(false))
})

describe('checkSingleSession', () => {
  const start = new Date('2026-11-07T04:30:00Z')
  it('requires an end after the start', () => {
    expect(code(() => checkSingleSession('WEBINAR', { startsAt: start, endsAt: start, venue: null }))).toBe('INVALID_TIME_RANGE')
    expect(() => checkSingleSession('WEBINAR', { startsAt: start, endsAt: null, venue: null })).not.toThrow() // webinar end optional
  })
  it('requires an end and a venue for workshops', () => {
    expect(code(() => checkSingleSession('OFFLINE_WORKSHOP', { startsAt: start, endsAt: null, venue: 'Farm' }))).toBe('END_REQUIRED')
    expect(code(() => checkSingleSession('OFFLINE_WORKSHOP', { startsAt: start, endsAt: new Date('2026-11-11T12:00:00Z'), venue: null }))).toBe('VENUE_REQUIRED')
  })
})
