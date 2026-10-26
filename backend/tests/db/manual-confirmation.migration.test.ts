// The Revision 3 migrations on a database that already holds Stage 4C and Stage 2 data. Runs the real
// migration SQL files in order on an in-memory PGlite (no Prisma involved), seeding data between the
// stages exactly as it would have been written at the time:
//   * before Stage 2: a pending booking with no deadline (grandfathered) and a customer-cancelled one;
//   * after Stage 2: a pending booking with a 30-minute payment deadline, an expired one (SYSTEM), an
//     admin-cancelled one, and audit events.
// Existing rows, audit events and seat counters must be byte-identical after both migrations, and the
// grandfathered booking must stay out of reach of expiry, confirmation and new deadlines.
// A second database holds a Stage 2 simulated-CONFIRMED booking (which has no confirmation_method): the
// migration must stop safely, change nothing and name the booking.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BACKEND_DIR } from './pglite-server.js'

const MIGRATIONS = path.join(BACKEND_DIR, 'prisma/migrations')
const STAGE2_ENUM = '20261026090000_payment_states_enum'
const ENUM = '20261027090000_awaiting_confirmation_enum'
const MAIN = '20261027090100_manual_confirmation_cancellation_requests'
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort()
const sql = (name: string) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8')
const upTo = (name: string) => migrations.slice(0, migrations.indexOf(name))

type Db = PGlite
const one = async <T>(db: Db, query: string, params: unknown[] = []) => (await db.query<T>(query, params)).rows[0]!
const snapshot = async (db: Db) => ({
  bookings: (await db.query(`SELECT id, reference, user_id, session_id, status, price_amount, currency, product_name, payment_due_at, confirmed_at, cancelled_at, cancelled_by, cancel_reason, created_at, updated_at FROM bookings ORDER BY id`)).rows,
  attempts: (await db.query(`SELECT * FROM payment_attempts ORDER BY id`)).rows,
  audit: (await db.query(`SELECT * FROM audit_events ORDER BY id`)).rows,
  seats: (await db.query(`SELECT id, seats_held FROM sessions ORDER BY id`)).rows,
})

async function seedBase(db: Db) {
  const user = (subject: string) => one<{ id: string }>(db, `INSERT INTO users (id, identity_pool, identity_issuer, identity_subject, email, updated_at) VALUES (gen_random_uuid(), 'CUSTOMER', 'test', $1::text, $1::text || '@example.test', now()) RETURNING id`, [subject]).then((row) => row.id)
  const users = { a: await user('legacy-a'), b: await user('legacy-b'), c: await user('legacy-c'), d: await user('legacy-d'), e: await user('legacy-e') }
  const productId = (await one<{ id: string }>(db, `INSERT INTO products (id, slug, name, type, price_amount, currency, updated_at) VALUES (gen_random_uuid(), 'legacy-webinar', 'Legacy Webinar', 'WEBINAR', 149, 'INR', now()) RETURNING id`)).id
  const sessionId = (await one<{ id: string }>(db, `INSERT INTO sessions (id, product_id, starts_at, ends_at, status, capacity, updated_at) VALUES (gen_random_uuid(), $1, now() + interval '30 days', now() + interval '30 days 1 hour', 'PUBLISHED', 10, now()) RETURNING id`, [productId])).id
  const insert = (userId: string, reference: string, extraColumns = '', extraValues = '', createdAt = `now() - interval '3 days'`) => one<{ id: string }>(db,
    `INSERT INTO bookings (id, reference, user_id, product_id, session_id, price_amount, currency, product_name, contact_name, phone_country, phone_dialing_code, phone_national, phone_e164, idempotency_key, created_at, updated_at${extraColumns})
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 149, 'INR', 'Legacy Webinar', 'Legacy Customer', 'IN', '91', '9876543210', '+919876543210', $5, ${createdAt}, ${createdAt}${extraValues}) RETURNING id`,
    [reference, userId, productId, sessionId, `legacy-key-${reference.toLowerCase().replace(/[^a-z0-9]/g, '')}x`]).then((row) => row.id)
  return { users, productId, sessionId, insert }
}

describe(`migrations ${ENUM} + ${MAIN} on existing Stage 4C / Stage 2 data`, () => {
  let db: Db
  let before: Awaited<ReturnType<typeof snapshot>>
  let grandfathered = ''
  let pending = ''

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`SET TIME ZONE 'UTC'`)
    for (const name of upTo(STAGE2_ENUM)) await db.exec(sql(name))
    const base = await seedBase(db)
    // Stage 4C rows (no deadlines existed yet).
    grandfathered = await base.insert(base.users.a, 'DF-AAAA2222')
    const customerCancelled = await base.insert(base.users.b, 'DF-BBBB2222')
    await db.query(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = now() - interval '2 days', cancelled_by = 'CUSTOMER' WHERE id = $1`, [customerCancelled])
    await db.query(`INSERT INTO audit_events (id, actor_label, action, target_type, target_id) VALUES (gen_random_uuid(), 'self', 'BOOKING_CREATED', 'booking', $1)`, [grandfathered])

    for (const name of migrations.slice(migrations.indexOf(STAGE2_ENUM), migrations.indexOf(ENUM))) await db.exec(sql(name))
    // Stage 2 rows: a pending booking with its 30-minute deadline, an expired one and an admin-cancelled one.
    pending = await base.insert(base.users.c, 'DF-CCCC2222', `, payment_due_at`, `, now() + interval '30 minutes'`, 'now()')
    const expired = await base.insert(base.users.d, 'DF-DDDD2222', `, payment_due_at`, `, now() - interval '90 minutes'`, `now() - interval '2 hours'`)
    await db.query(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'SYSTEM', cancel_reason = 'Payment not completed in time' WHERE id = $1`, [expired])
    const adminCancelled = await base.insert(base.users.e, 'DF-EEEE2222', `, payment_due_at`, `, now() + interval '30 minutes'`, 'now()')
    await db.query(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'ADMIN', cancel_reason = 'Dates changed' WHERE id = $1`, [adminCancelled])
    await db.query(`INSERT INTO audit_events (id, actor_label, action, target_type, target_id, details) VALUES (gen_random_uuid(), 'system', 'BOOKING_EXPIRED', 'booking', $1, '{"by":"SYSTEM"}')`, [expired])
    expect((await one<{ seats_held: number }>(db, `SELECT seats_held FROM sessions WHERE id = $1`, [base.sessionId])).seats_held).toBe(2)

    before = await snapshot(db)
    // Two separate transactions, as `prisma migrate deploy` applies them.
    await db.exec(sql(ENUM))
    await db.exec(sql(MAIN))
  }, 120_000)
  afterAll(async () => db?.close())

  it('leaves every existing booking, payment attempt, audit event and seat counter byte-identical', async () => {
    expect(await snapshot(db)).toEqual(before)
    const added = (await db.query<Record<string, unknown>>(`SELECT confirmation_due_at, confirmation_method, confirmed_by_user_id, confirmation_reason, confirmation_note FROM bookings`)).rows
    expect(added.length).toBe(before.bookings.length)
    expect(added.every((row) => Object.values(row).every((value) => value === null))).toBe(true)
    expect((await one<{ count: number }>(db, `SELECT count(*)::int AS count FROM booking_cancellation_requests`)).count).toBe(0)
  })

  it('the grandfathered booking cannot be expired, confirmed manually or given a deadline', async () => {
    await expect(db.query(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = now() + interval '100 years', cancelled_by = 'SYSTEM', cancel_reason = 'Not confirmed in time' WHERE id = $1`, [grandfathered])).rejects.toThrow(/deadline has passed can expire/)
    const admin = (await one<{ id: string }>(db, `INSERT INTO users (id, identity_pool, identity_issuer, identity_subject, email, role, updated_at) VALUES (gen_random_uuid(), 'ADMIN', 'test', 'mig-admin', 'mig.admin@example.test', 'ADMIN', now()) RETURNING id`)).id
    await expect(db.query(`UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now(), confirmation_method = 'MANUAL', confirmed_by_user_id = $2, confirmation_reason = 'COMPLIMENTARY' WHERE id = $1`, [grandfathered, admin])).rejects.toThrow(/without a successful payment attempt/)
    await expect(db.query(`UPDATE bookings SET confirmation_due_at = now() + interval '1 day' WHERE id = $1`, [grandfathered])).rejects.toThrow(/cannot change/)
    await expect(db.query(`UPDATE bookings SET payment_due_at = now() + interval '1 day' WHERE id = $1`, [grandfathered])).rejects.toThrow(/cannot change/)
    const overdue = await one<{ count: number }>(db, `SELECT count(*)::int AS count FROM bookings WHERE id = $1 AND ((status = 'PENDING_PAYMENT' AND payment_due_at <= now() + interval '100 years') OR (status = 'AWAITING_CONFIRMATION' AND confirmation_due_at <= now() + interval '100 years'))`, [grandfathered])
    expect(overdue.count).toBe(0)
    expect((await one<{ status: string }>(db, `SELECT status FROM bookings WHERE id = $1`, [grandfathered])).status).toBe('PENDING_PAYMENT')
  })

  it('existing cancelled bookings stay valid and their cancellations cannot be edited', async () => {
    await expect(db.query(`UPDATE bookings SET cancel_reason = 'rewritten' WHERE reference = 'DF-EEEE2222'`)).rejects.toThrow(/cancellation cannot be changed/)
    await db.query(`UPDATE bookings SET updated_at = updated_at WHERE status = 'CANCELLED'`) // a no-op update still satisfies every constraint
  })

  it('the Stage 2 pending booking keeps its payment deadline and can still expire through it', async () => {
    const stored = await one<{ payment_due_at: Date; confirmation_due_at: Date | null }>(db, `SELECT payment_due_at, confirmation_due_at FROM bookings WHERE id = $1`, [pending])
    expect(stored.confirmation_due_at).toBeNull()
    await db.query(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = $2, cancelled_by = 'SYSTEM', cancel_reason = 'Payment not completed in time' WHERE id = $1`, [pending, stored.payment_due_at])
    expect((await one<{ status: string }>(db, `SELECT status FROM bookings WHERE id = $1`, [pending])).status).toBe('CANCELLED')
  })
})

describe(`migration ${MAIN} with a Stage 2 simulated confirmation present`, () => {
  let db: Db

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`SET TIME ZONE 'UTC'`)
    for (const name of upTo(ENUM)) await db.exec(sql(name))
  }, 120_000)
  afterAll(async () => db?.close())

  it('stops safely without changing anything and names the booking', async () => {
    const base = await seedBase(db)
    const booking = await base.insert(base.users.a, 'DF-SSSS2222', `, payment_due_at`, `, now() + interval '30 minutes'`, 'now()')
    await db.transaction(async (tx) => {
      const attempt = (await tx.query<{ id: string }>(`INSERT INTO payment_attempts (id, booking_id, provider, is_simulated, amount, currency, idempotency_key, updated_at) VALUES (gen_random_uuid(), $1, 'DEV_SIMULATOR', true, 149, 'INR', 'legacy-attempt-key-0001', now()) RETURNING id`, [booking])).rows[0]!.id
      await tx.query(`UPDATE payment_attempts SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1`, [attempt])
      await tx.query(`UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [booking])
    })
    const before = await snapshot(db)
    await db.exec(sql(ENUM))
    await expect(db.exec(sql(MAIN))).rejects.toThrow(/Migration stopped: .*DF-SSSS2222.*No data was changed/)
    expect(await snapshot(db)).toEqual(before)
    // Nothing from the migration exists: it rolled back as one transaction.
    expect((await one<{ exists: string | null }>(db, `SELECT to_regclass('booking_cancellation_requests')::text AS exists`)).exists).toBeNull()
    expect((await one<{ count: number }>(db, `SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'confirmation_method'`)).count).toBe(0)
    expect((await one<{ status: string }>(db, `SELECT status FROM bookings WHERE id = $1`, [booking])).status).toBe('CONFIRMED')
  })
})
