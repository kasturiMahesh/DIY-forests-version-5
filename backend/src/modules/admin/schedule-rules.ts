import { HttpError } from '../../lib/http-error.js'
import { ORGANIZER_TIMEZONE, instantToZonedTime, zonedTimeToInstant } from '../../lib/time.js'

/** Confirmed business rule: an online training is two 4-hour sessions on consecutive Fridays. */
export const TRAINING_SESSION_HOURS = 4
export const TRAINING_GAP_DAYS = 7
const HOUR_MS = 3_600_000

export const invalid = (code: string, message: string) => new HttpError(400, code, message)

/** Day of week (0 = Sunday … 5 = Friday) of an instant as seen in `timeZone`. */
export function weekdayIn(instant: Date, timeZone: string): number {
  const local = instantToZonedTime(instant, timeZone)
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()
}

/** The same wall-clock time `days` calendar days later in `timeZone` (correct across DST in any zone). */
export function addCalendarDays(instant: Date, days: number, timeZone: string): Date {
  const local = instantToZonedTime(instant, timeZone)
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days))
  return zonedTimeToInstant({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: local.hour, minute: local.minute }, timeZone)
}

export type CohortTimes = { first: { startsAt: Date; endsAt: Date }; second: { startsAt: Date; endsAt: Date } }

/**
 * Builds the two sessions from the first session's start, and checks the rules:
 * a Friday in the organizer zone, 4 hours each, the second exactly 7 calendar days later.
 * `secondStartsAt`, when supplied (e.g. from a form showing both dates), must match exactly.
 */
export function deriveCohortTimes(firstStartsAt: Date, secondStartsAt: Date | undefined, now: Date, timeZone = ORGANIZER_TIMEZONE): CohortTimes {
  if (weekdayIn(firstStartsAt, timeZone) !== 5) throw invalid('NOT_A_FRIDAY', `The first session must start on a Friday (${timeZone})`)
  if (firstStartsAt.getTime() <= now.getTime()) throw invalid('START_IN_PAST', 'The first session must start in the future')
  const second = addCalendarDays(firstStartsAt, TRAINING_GAP_DAYS, timeZone)
  if (secondStartsAt && secondStartsAt.getTime() !== second.getTime()) {
    throw invalid('SECOND_SESSION_MISMATCH', 'The second session must start exactly 7 days after the first, at the same time')
  }
  if (weekdayIn(second, timeZone) !== 5) throw invalid('NOT_A_FRIDAY', 'The second session must also be on a Friday')
  return {
    first: { startsAt: firstStartsAt, endsAt: new Date(firstStartsAt.getTime() + TRAINING_SESSION_HOURS * HOUR_MS) },
    second: { startsAt: second, endsAt: new Date(second.getTime() + TRAINING_SESSION_HOURS * HOUR_MS) },
  }
}

/** True when two stored sessions still satisfy the cohort rules (used before publishing). */
export function cohortTimesAreValid(sessions: { cohortSequence: number | null; startsAt: Date; endsAt: Date | null }[], timeZone = ORGANIZER_TIMEZONE): boolean {
  const first = sessions.find((session) => session.cohortSequence === 1)
  const second = sessions.find((session) => session.cohortSequence === 2)
  if (sessions.length !== 2 || !first || !second || !first.endsAt || !second.endsAt) return false
  const fourHours = TRAINING_SESSION_HOURS * HOUR_MS
  return weekdayIn(first.startsAt, timeZone) === 5
    && second.startsAt.getTime() === addCalendarDays(first.startsAt, TRAINING_GAP_DAYS, timeZone).getTime()
    && first.endsAt.getTime() - first.startsAt.getTime() === fourHours
    && second.endsAt.getTime() - second.startsAt.getTime() === fourHours
}

export type SingleSessionInput = { startsAt: Date; endsAt: Date | null; venue: string | null }

/** Webinar and workshop rules. Workshops need an end and a venue; every end must follow the start. */
export function checkSingleSession(type: 'WEBINAR' | 'OFFLINE_WORKSHOP', value: SingleSessionInput) {
  if (value.endsAt && value.endsAt.getTime() <= value.startsAt.getTime()) throw invalid('INVALID_TIME_RANGE', 'The end must be after the start')
  if (type === 'OFFLINE_WORKSHOP') {
    if (!value.endsAt) throw invalid('END_REQUIRED', 'A workshop batch needs an end date and time')
    if (!value.venue) throw invalid('VENUE_REQUIRED', 'A workshop batch needs a venue or location')
  }
}
