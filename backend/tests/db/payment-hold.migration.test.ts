// The Stage 2 payment migrations on a database that already holds Stage 4C bookings: existing rows
// must be untouched and GRANDFATHERED (no deadline, never expired). Runs the real migration SQL files
// in order on an in-memory PGlite (no Prisma involved), inserting data between the two stages.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BACKEND_DIR } from './pglite-server.js'

const MIGRATIONS = path.join(BACKEND_DIR, 'prisma/migrations')
const ENUMS = '20261026090000_payment_states_enum'
const SIMULATOR = '20261026090100_payment_simulator'
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort()
const sql = (name: string) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8')

let db: PGlite
const one = async <T>(query: string, params: unknown[] = []) => (await db.query<T>(query, params)).rows[0]!
const snapshot = async () => (await db.query(`SELECT id, reference, status, cancelled_at, cancelled_by, cancel_reason, price_amount, currency, product_name, created_at, updated_at FROM bookings ORDER BY id`)).rows

describe(`migrations ${ENUMS} + ${SIMULATOR} on existing bookings`, () => {
  let userId = ''
  let sessionId = ''
  let pendingA = ''
  let pendingB = ''
  let before: unknown[] = []
  let auditBefore = 0

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`SET TIME ZONE 'UTC'`)
    const first = migrations.indexOf(ENUMS)
    expect(first).toBeGreaterThan(0)
    expect(migrations[first + 1]).toBe(SIMULATOR)
    for (const name of migrations.slice(0, first)) await db.exec(sql(name))

    // Stage 4C state: two pending bookings and one cancelled one on a webinar session.
    userId = (await one<{ id: string }>(`INSERT INTO users (id, identity_pool, identity_issuer, identity_subject, email, updated_at) VALUES (gen_random_uuid(), 'CUSTOMER', 'test', 'legacy', 'legacy@example.test', now()) RETURNING id`)).id
    const other = (await one<{ id: string }>(`INSERT INTO users (id, identity_pool, identity_issuer, identity_subject, email, updated_at) VALUES (gen_random_uuid(), 'CUSTOMER', 'test', 'legacy-2', 'legacy2@example.test', now()) RETURNING id`)).id
    const productId = (await one<{ id: string }>(`INSERT INTO products (id, slug, name, type, price_amount, currency, updated_at) VALUES (gen_random_uuid(), 'legacy-webinar', 'Legacy Webinar', 'WEBINAR', 149, 'INR', now()) RETURNING id`)).id
    sessionId = (await one<{ id: string }>(`INSERT INTO sessions (id, product_id, starts_at, ends_at, status, capacity, updated_at) VALUES (gen_random_uuid(), $1, now() + interval '30 days', now() + interval '30 days 1 hour', 'PUBLISHED', 5, now()) RETURNING id`, [productId])).id
    const insert = (user: string, reference: string, key: string) => one<{ id: string }>(
      `INSERT INTO bookings (id, reference, user_id, product_id, session_id, price_amount, currency, product_name, contact_name, phone_country, phone_dialing_code, phone_national, phone_e164, idempotency_key, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 149, 'INR', 'Legacy Webinar', 'Legacy Customer', 'IN', '91', '9876543210', '+919876543210', $5, now() - interval '3 days', now() - interval '3 days') RETURNING id`,
      [reference, user, productId, sessionId, key],
    ).then((row) => row.id)
    const cancelled = await insert(userId, 'DF-CCCC2222', 'legacy-key-cccccccccccc')
    await db.query(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = now() - interval '2 days', cancelled_by = 'CUSTOMER' WHERE id = $1`, [cancelled])
    pendingA = await insert(userId, 'DF-AAAA2222', 'legacy-key-aaaaaaaaaaaa')
    pendingB = await insert(other, 'DF-BBBB2222', 'legacy-key-bbbbbbbbbbbb')
    await db.query(`INSERT INTO audit_events (id, actor_label, action, target_type, target_id) VALUES (gen_random_uuid(), 'self', 'BOOKING_CREATED', 'booking', $1)`, [pendingA])
    expect((await one<{ seats_held: number }>(`SELECT seats_held FROM sessions WHERE id = $1`, [sessionId])).seats_held).toBe(2)

    before = await snapshot()
    auditBefore = (await one<{ count: number }>(`SELECT count(*)::int AS count FROM audit_events`)).count
    // Two separate transactions, as `prisma migrate deploy` applies them.
    await db.exec(sql(ENUMS))
    await db.exec(sql(SIMULATOR))
  }, 60_000)
  afterAll(async () => db?.close())

  it('leaves every existing booking, audit event and seat counter exactly as it was', async () => {
    expect(await snapshot()).toEqual(before)
    expect((await one<{ count: number }>(`SELECT count(*)::int AS count FROM audit_events`)).count).toBe(auditBefore)
    expect((await one<{ seats_held: number }>(`SELECT seats_held FROM sessions WHERE id = $1`, [sessionId])).seats_held).toBe(2)
    const added = (await db.query<{ payment_due_at: Date | null; confirmed_at: Date | null }>(`SELECT payment_due_at, confirmed_at FROM bookings`)).rows
    expect(added.every((row) => row.payment_due_at === null && row.confirmed_at === null)).toBe(true)
  })

  it('grandfathered bookings cannot be given a deadline or expired by the system', async () => {
    await expect(db.query(`UPDATE bookings SET payment_due_at = now() WHERE id = $1`, [pendingA])).rejects.toThrow(/cannot change/)
    await expect(db.query(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'SYSTEM', cancel_reason = 'Payment not completed in time' WHERE id = $1`, [pendingA])).rejects.toThrow(/deadline has passed/)
    // The sweep's condition never matches them, however far in the future it runs.
    const overdue = await one<{ count: number }>(`SELECT count(*)::int AS count FROM bookings WHERE status = 'PENDING_PAYMENT' AND payment_due_at <= now() + interval '100 years'`)
    expect(overdue.count).toBe(0)
    expect((await one<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [pendingA])).status).toBe('PENDING_PAYMENT')
  })

  it('a grandfathered booking can still be confirmed by a successful (simulated) attempt, without changing seats', async () => {
    await db.transaction(async (tx) => {
      const attempt = (await tx.query<{ id: string }>(
        `INSERT INTO payment_attempts (id, booking_id, provider, is_simulated, amount, currency, idempotency_key, updated_at) VALUES (gen_random_uuid(), $1, 'DEV_SIMULATOR', true, 149, 'INR', 'legacy-attempt-key-0001', now()) RETURNING id`,
        [pendingB],
      )).rows[0]!.id
      await tx.query(`UPDATE payment_attempts SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1`, [attempt])
      await tx.query(`UPDATE bookings SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [pendingB])
    })
    expect((await one<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [pendingB])).status).toBe('CONFIRMED')
    expect((await one<{ seats_held: number }>(`SELECT seats_held FROM sessions WHERE id = $1`, [sessionId])).seats_held).toBe(2)
  })

  it('CONFIRMED and PENDING_PAYMENT both count as the one active booking per customer and dates', async () => {
    const product = (await one<{ product_id: string }>(`SELECT product_id FROM sessions WHERE id = $1`, [sessionId])).product_id
    await expect(db.query(
      `INSERT INTO bookings (id, reference, user_id, product_id, session_id, price_amount, currency, product_name, contact_name, phone_country, phone_dialing_code, phone_national, phone_e164, idempotency_key, created_at, payment_due_at, updated_at)
       VALUES (gen_random_uuid(), 'DF-DDDD2222', $1, $2, $3, 149, 'INR', 'Legacy Webinar', 'Legacy Customer', 'IN', '91', '9876543210', '+919876543210', 'legacy-key-dddddddddddd', now(), now() + interval '30 minutes', now())`,
      [userId, product, sessionId],
    )).rejects.toThrow(/bookings_one_active_per_user_session/)
  })
})
