// Organizer time for the admin forms. Sessions are scheduled in Asia/Kolkata (IST, UTC+05:30, no
// daylight saving), so a "datetime-local" value entered by an admin means that wall-clock time in IST.
// The backend stores the resulting instant and re-validates every rule (e.g. Fridays) itself.

export const ORGANIZER_ZONE = 'Asia/Kolkata'
const IST_OFFSET = '+05:30'
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** "2026-11-06T18:30" (IST wall clock) → "2026-11-06T18:30:00+05:30" (an exact instant). */
export function istLocalToInstant(local: string): string | null {
  const match = LOCAL_PATTERN.exec(local)
  if (!match) return null
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number]
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null
  return `${local}:00${IST_OFFSET}`
}

/** An instant → the IST wall-clock value for a datetime-local input. */
export function instantToIstLocal(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: ORGANIZER_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** Day of week (0 = Sunday … 5 = Friday) of an IST wall-clock value. */
export function istLocalWeekday(local: string): number | null {
  const match = LOCAL_PATTERN.exec(local)
  if (!match) return null
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
}

/** Same IST wall-clock time `days` later (IST has no DST, so this is exact). */
export function addDaysToIstLocal(local: string, days: number): string | null {
  const instant = istLocalToInstant(local)
  if (!instant) return null
  return instantToIstLocal(new Date(new Date(instant).getTime() + days * 86_400_000).toISOString())
}

/** Admin display: "Fri, 6 Nov 2026, 6:30 pm IST" (always organizer time, so admins compare like with like). */
export function formatIst(iso: string): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: ORGANIZER_ZONE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso))} IST`
}
