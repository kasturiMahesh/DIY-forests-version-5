import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrismaClient, type PrismaClient } from '../../src/db/client.js'
import { SEED_PRODUCTS, SEED_SESSIONS, seedCatalog } from '../../src/db/seed-catalog.js'
import { DatabaseTimeZoneError, assertUtcSession } from '../../src/db/timezone-guard.js'
import { ProductType, SessionStatus } from '../../src/generated/prisma/enums.js'
import { prismaCli, startTestDatabase, type TestDatabase } from './pglite-server.js'

let database: TestDatabase
let prisma: PrismaClient

beforeAll(async () => {
  database = await startTestDatabase()
  // The real migration files, applied with the real CLI.
  await prismaCli(['migrate', 'deploy'], database.url)
  prisma = createPrismaClient(database.url, { maxConnections: 1 })
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await database?.stop()
})

const counts = async () => ({ products: await prisma.product.count(), sessions: await prisma.session.count() })
const productId = async (slug: string) => (await prisma.product.findUniqueOrThrow({ where: { slug } })).id
const sessionTimeZone = async () => (await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`)[0]!.tz

// Runs first. A non-UTC session is exactly the misconfiguration the guard and the migration
// exist to prevent, so force one regardless of the machine's zone.
describe('database time zone', () => {
  it('starts in a hostile (non-UTC) session for this test run', async () => {
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'Etc/GMT-5'`)
    expect(await sessionTimeZone()).toBe('Etc/GMT-5')
  })

  it('guard refuses to seed in a non-UTC session and writes nothing', async () => {
    await expect(seedCatalog(prisma)).rejects.toThrow(DatabaseTimeZoneError)
    await expect(seedCatalog(prisma)).rejects.toThrow(/must be UTC/)
    expect(await counts()).toEqual({ products: 0, sessions: 0 })
  })

  it('the migration set the database default time zone to UTC', async () => {
    const rows = await prisma.$queryRaw<{ setconfig: string[] }[]>`
      SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = current_database() AND s.setrole = 0`
    expect(rows.flatMap((row) => row.setconfig)).toContain('TimeZone=UTC')
  })

  it('a UTC session (what every new real connection now gets) passes the guard', async () => {
    // PGlite serves every connection from one already-open backend session, so the database
    // default cannot apply to it; set it explicitly, as a new Neon/RDS session would get it.
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
    expect(await sessionTimeZone()).toBe('UTC')
    await expect(assertUtcSession(prisma)).resolves.toBeUndefined()
  })
})

describe('migrations', () => {
  it('match the Prisma schema exactly (no drift)', async () => {
    const result = await prismaCli(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], database.url)
    expect(result.stdout).toMatch(/No difference detected/i)
  }, 120_000)

  it('report the database as up to date', async () => {
    const result = await prismaCli(['migrate', 'status'], database.url)
    expect(result.stdout).toMatch(/Database schema is up to date/i)
  }, 120_000)

  it('create the expected column types', async () => {
    const columns = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null; is_nullable: string }[]>`
      SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('products', 'sessions')`
    const col = (table: string, name: string) => columns.find((c) => c.table_name === table && c.column_name === name)

    expect(col('products', 'id')).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' })
    expect(col('products', 'price_amount')).toMatchObject({ data_type: 'numeric', numeric_precision: 12, numeric_scale: 2, is_nullable: 'NO' })
    expect(col('products', 'currency')).toMatchObject({ data_type: 'character', is_nullable: 'NO' })
    expect(col('sessions', 'starts_at')).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'NO' })
    expect(col('sessions', 'ends_at')).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' })
    expect(col('sessions', 'product_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' })
    expect(col('sessions', 'capacity')).toMatchObject({ data_type: 'integer', is_nullable: 'YES' })
  })
})

describe('seed', () => {
  it('runs through the real `prisma db seed` entry point', async () => {
    const result = await prismaCli(['db', 'seed'], database.url)
    expect(result.stdout).toMatch(/Seeded 5 products and 1 session\(s\) into 127\.0\.0\.1:\d+\/postgres\./)
    expect(result.stdout + result.stderr).not.toContain('postgres:postgres@') // credentials never printed
    expect(await counts()).toEqual({ products: 5, sessions: 1 })
  }, 120_000)

  it('is idempotent: re-running creates no duplicates and keeps ids stable', async () => {
    const before = await prisma.product.findMany({ orderBy: { slug: 'asc' }, select: { id: true, slug: true } })
    const sessionBefore = await prisma.session.findFirstOrThrow({ select: { id: true } })

    await seedCatalog(prisma)
    await seedCatalog(prisma)
    await prismaCli(['db', 'seed'], database.url)

    expect(await counts()).toEqual({ products: 5, sessions: 1 })
    expect(await prisma.product.findMany({ orderBy: { slug: 'asc' }, select: { id: true, slug: true } })).toEqual(before)
    expect(await prisma.session.findFirstOrThrow({ select: { id: true } })).toEqual(sessionBefore)
  }, 120_000)

  it('stores the catalog exactly as on the site, in its original currencies', async () => {
    const products = await prisma.product.findMany({ orderBy: { slug: 'asc' } })
    const bySlug = Object.fromEntries(products.map((p) => [p.slug, p]))

    for (const expected of SEED_PRODUCTS) {
      const row = bySlug[expected.slug]!
      expect(row.name).toBe(expected.name)
      expect(row.type).toBe(expected.type)
      expect(row.currency).toBe(expected.currency)
      expect(row.priceAmount.toFixed(2)).toBe(expected.priceAmount) // exact Decimal, no float rounding
      expect(row.isActive).toBe(expected.isActive)
    }
    expect(bySlug['online-training']).toMatchObject({ currency: 'USD', type: ProductType.ONLINE_TRAINING })
    expect(bySlug['online-training']!.priceAmount.toString()).toBe('500')
    expect(bySlug['offline-workshop']!.priceAmount.toFixed(2)).toBe('100000.00')
    expect(bySlug['monthly-webinar']).toMatchObject({ currency: 'INR', type: ProductType.WEBINAR })
    expect(products.filter((p) => p.isActive).map((p) => p.slug).sort()).toEqual(['monthly-webinar', 'offline-workshop', 'online-training'])
  })

  it('seeds the expired webinar as a DRAFT with a note, at 18:30 IST = 13:00 UTC', async () => {
    const session = await prisma.session.findFirstOrThrow({ include: { product: true } })
    expect(session.product.slug).toBe('monthly-webinar')
    expect(session.startsAt.toISOString()).toBe('2026-10-13T13:00:00.000Z')
    expect(session.endsAt).toBeNull()
    expect(session.timezone).toBe('Asia/Kolkata')
    expect(session.capacity).toBe(40)
    expect(session.status).toBe(SessionStatus.DRAFT)
    expect(session.internalNote).toMatch(/NEEDS OWNER CONFIRMATION/)
    expect(SEED_SESSIONS).toHaveLength(1)
  })
})

describe('timezone storage', () => {
  it('keeps one instant regardless of the connection time zone', async () => {
    const [ist, ny, utc] = await prisma.$transaction(async (tx) => {
      const read = async (zone: string) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`)
        const [row] = await tx.$queryRaw<{ epoch: string; shown: string }[]>`
          SELECT extract(epoch FROM starts_at)::text AS epoch, starts_at::text AS shown FROM sessions LIMIT 1`
        return row!
      }
      return [await read('Asia/Kolkata'), await read('America/New_York'), await read('UTC')]
    })
    // Same instant (epoch seconds) in every session time zone...
    expect(new Set([ist.epoch, ny.epoch, utc.epoch]).size).toBe(1)
    // ...and it is the correct instant (this failed before the UTC default/guard existed).
    expect(Number(ist.epoch)).toBe(Date.UTC(2026, 9, 13, 13, 0) / 1000)
    // ...only its display changes.
    expect(ist.shown).toBe('2026-10-13 18:30:00+05:30')
    expect(ny.shown).toBe('2026-10-13 09:00:00-04')
    expect(utc.shown).toBe('2026-10-13 13:00:00+00')
  })

  it('round-trips an instant through Prisma unchanged', async () => {
    const id = await productId('online-training')
    const instant = new Date('2027-01-08T13:00:00.000Z') // a Friday 18:30 IST
    const created = await prisma.session.create({ data: { productId: id, startsAt: instant, endsAt: new Date('2027-01-08T17:00:00.000Z') } })
    const read = await prisma.session.findUniqueOrThrow({ where: { id: created.id } })
    expect(read.startsAt.getTime()).toBe(instant.getTime())
    expect(read.timezone).toBe('Asia/Kolkata') // default
    expect(read.status).toBe(SessionStatus.DRAFT) // default
    await prisma.session.delete({ where: { id: created.id } })
  })
})

describe('integrity constraints', () => {
  const product = (overrides: Record<string, unknown> = {}) => ({
    slug: 'constraint-test', name: 'Constraint test', type: ProductType.WEBINAR, priceAmount: '1.00', currency: 'INR', ...overrides,
  })

  it.each([
    ['duplicate slug', { slug: 'online-training' }, /Unique constraint/i],
    ['negative price', { priceAmount: '-1.00' }, /products_price_amount_non_negative/],
    ['lower-case currency', { currency: 'usd' }, /products_currency_iso4217_format/],
    ['numeric currency', { currency: '840' }, /products_currency_iso4217_format/],
    ['badly formatted slug', { slug: 'Bad Slug' }, /products_slug_format/],
    ['blank name', { name: '   ' }, /products_name_not_blank/],
  ])('rejects a product with %s', async (_label, overrides, error) => {
    await expect(prisma.product.create({ data: product(overrides) })).rejects.toThrow(error)
  })

  it('rounds amounts with more than 2 decimal places (PostgreSQL numeric behaviour; validate input in the API stage)', async () => {
    const created = await prisma.product.create({ data: product({ slug: 'rounding-test', priceAmount: '10.005' }) })
    // PostgreSQL numeric(12,2) rounds half away from zero on input; documented behaviour, asserted here.
    expect(created.priceAmount.toFixed(2)).toBe('10.01')
    await prisma.product.delete({ where: { id: created.id } })
  })

  it.each([
    ['end before start', { startsAt: new Date('2027-01-01T10:00:00Z'), endsAt: new Date('2027-01-01T09:00:00Z') }, /sessions_ends_after_starts/],
    ['end equal to start', { startsAt: new Date('2027-01-01T10:00:00Z'), endsAt: new Date('2027-01-01T10:00:00Z') }, /sessions_ends_after_starts/],
    ['zero capacity', { startsAt: new Date('2027-01-02T10:00:00Z'), capacity: 0 }, /sessions_capacity_positive/],
    ['blank timezone', { startsAt: new Date('2027-01-03T10:00:00Z'), timezone: ' ' }, /sessions_timezone_not_blank/],
  ])('rejects a session with %s', async (_label, fields, error) => {
    const id = await productId('online-training')
    await expect(prisma.session.create({ data: { productId: id, ...fields } })).rejects.toThrow(error)
  })

  it('rejects a second session for the same product at the same instant', async () => {
    const session = await prisma.session.findFirstOrThrow()
    await expect(prisma.session.create({ data: { productId: session.productId, startsAt: session.startsAt } })).rejects.toThrow(/Unique constraint/i)
  })

  it('rejects a session for a product that does not exist', async () => {
    await expect(prisma.session.create({ data: { productId: '01990000-0000-7000-8000-000000000000', startsAt: new Date() } })).rejects.toThrow(/Foreign key constraint/i)
  })

  it('refuses to delete a product that still has sessions', async () => {
    await expect(prisma.product.delete({ where: { slug: 'monthly-webinar' } })).rejects.toThrow(/Foreign key constraint|violates RESTRICT/i)
    expect(await prisma.product.count({ where: { slug: 'monthly-webinar' } })).toBe(1)
  })

  it('leaves the seeded data unchanged after all rejected writes', async () => {
    expect(await counts()).toEqual({ products: 5, sessions: 1 })
  })
})
