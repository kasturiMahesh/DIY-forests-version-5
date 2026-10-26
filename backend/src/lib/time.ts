/**
 * Organizer-local scheduling ↔ real instants.
 *
 * A session is one real moment (a UTC instant, stored as timestamptz). Organizers think in
 * their own wall-clock time ("Friday 18:30 in Asia/Kolkata"); visitors see that same moment
 * converted to their own zone. Never build a session time from a visitor's zone.
 */

export const ORGANIZER_TIMEZONE = 'Asia/Kolkata'

export type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number }

export class TimeZoneError extends Error {
  override name = 'TimeZoneError'
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()
function partsFormatter(timeZone: string) {
  let formatter = formatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/** Wall-clock fields of an instant in a zone. */
export function instantToZonedTime(instant: Date, timeZone: string): LocalDateTime {
  if (!isValidTimeZone(timeZone)) throw new TimeZoneError(`Unknown time zone "${timeZone}"`)
  const parts = Object.fromEntries(partsFormatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) }
}

const sameLocal = (a: LocalDateTime, b: LocalDateTime) =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute

/**
 * The single instant at which the given wall-clock time occurs in `timeZone`.
 * Throws for invalid fields, unknown zones, and wall-clock times that are skipped or
 * repeated by a daylight-saving change (ambiguous), so a schedule can never silently shift.
 */
export function zonedTimeToInstant(local: LocalDateTime, timeZone: string): Date {
  if (!isValidTimeZone(timeZone)) throw new TimeZoneError(`Unknown time zone "${timeZone}"`)
  const { year, month, day, hour, minute } = local
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  const check = new Date(asUtc)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
    throw new TimeZoneError(`Invalid local date-time ${JSON.stringify(local)}`)
  }

  // Try every offset the zone has around that date; keep those that reproduce the wall-clock time.
  const offsets = new Set<number>()
  for (const probeHours of [-36, -12, 0, 12, 36]) {
    const probe = new Date(asUtc + probeHours * 3_600_000)
    const wall = instantToZonedTime(probe, timeZone)
    offsets.add(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - Math.floor(probe.getTime() / 60_000) * 60_000)
  }
  const matches = [...new Set([...offsets].map((offset) => asUtc - offset))]
    .filter((candidate) => sameLocal(instantToZonedTime(new Date(candidate), timeZone), local))
    .sort((a, b) => a - b)

  if (matches.length === 0) throw new TimeZoneError(`${formatLocal(local)} does not exist in ${timeZone} (skipped by a daylight-saving change)`)
  if (matches.length > 1) throw new TimeZoneError(`${formatLocal(local)} is ambiguous in ${timeZone} (repeated by a daylight-saving change)`)
  return new Date(matches[0]!)
}

/** Human-readable rendering of an instant in a zone, e.g. for a visitor's local display. */
export function formatInstantInZone(instant: Date, timeZone: string, locale = 'en-IN'): string {
  if (!isValidTimeZone(timeZone)) throw new TimeZoneError(`Unknown time zone "${timeZone}"`)
  // dateStyle/timeStyle cannot be combined with timeZoneName, so spell the fields out.
  return new Intl.DateTimeFormat(locale, {
    timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(instant)
}

function formatLocal({ year, month, day, hour, minute }: LocalDateTime) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`
}
