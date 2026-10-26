import type { PrismaClient } from '../generated/prisma/client.js'

// Zone names PostgreSQL may report for a session that is always UTC (no daylight saving).
const UTC_ZONES = new Set(['utc', 'etc/utc', 'universal', 'etc/universal', 'zulu', 'etc/zulu', 'uct', 'etc/uct', 'gmt', 'etc/gmt', 'gmt0', 'etc/gmt0', 'etc/gmt+0', 'etc/gmt-0', 'greenwich', 'etc/greenwich'])

export class DatabaseTimeZoneError extends Error {
  override name = 'DatabaseTimeZoneError'
}

/**
 * Refuse to work with a database session that is not UTC.
 *
 * Prisma 7.10's pg adapter writes DateTime values without an offset and reads timestamptz
 * values ignoring the offset. In a non-UTC session every stored instant would be shifted, while
 * Prisma reads would still look right. The init migration sets the database default to UTC;
 * this check catches databases where that default is missing or overridden (e.g. per role).
 */
export async function assertUtcSession(prisma: Pick<PrismaClient, '$queryRaw'>): Promise<void> {
  const [row] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
  const zone = row?.tz ?? '(unknown)'
  if (!UTC_ZONES.has(zone.toLowerCase())) {
    throw new DatabaseTimeZoneError(
      `Database session time zone is "${zone}", but it must be UTC so session times are stored correctly. ` +
        'Apply the migrations (npm run db:migrate:deploy), which set the database default to UTC, then reconnect; ' +
        'also check for a role-level TimeZone override (ALTER ROLE ... RESET timezone).',
    )
  }
}
