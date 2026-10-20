// The retire migration on a database that already holds the obsolete products, with and without
// references. Runs the real migration SQL files in order on an in-memory PGlite (no Prisma involved).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BACKEND_DIR } from './pglite-server.js'

const MIGRATIONS = path.join(BACKEND_DIR, 'prisma/migrations')
const RETIRE = '20261016140000_retire_obsolete_products'
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort()
const sql = (name: string) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8')

let db: PGlite
const product = (slug: string, name: string, type = 'ONLINE_TRAINING') =>
  db.query<{ id: string }>(
    `INSERT INTO products (id, slug, name, type, price_amount, currency, is_active, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, 'INR', $4, now()) RETURNING id`,
    [slug, name, type, slug === 'online-training'],
  ).then((result) => result.rows[0]!.id)
const rows = async () =>
  (await db.query<{ slug: string; is_active: boolean; archived: boolean }>(`SELECT slug, is_active, archived_at IS NOT NULL AS archived FROM products ORDER BY slug`)).rows

describe(`migration ${RETIRE}`, () => {
  let referenced = ''
  let sessionId = ''

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`SET TIME ZONE 'UTC'`)
    // Apply exactly the migrations that precede the retire migration, in order (later ones, such as
    // the Stage 4C booking foundation, are not part of the state this migration was written against).
    const retireIndex = migrations.indexOf(RETIRE)
    expect(retireIndex).toBeGreaterThan(0)
    for (const name of migrations.slice(0, retireIndex)) await db.exec(sql(name))

    // State before the migration: both obsolete products exist; Detailed Training has a session and a cohort.
    await product('online-training', 'Online Training')
    await product('crash-course', 'Crash Course')
    referenced = await product('detailed-training', 'Detailed Training')
    const cohort = await db.query<{ id: string }>(`INSERT INTO training_cohorts (id, product_id, updated_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`, [referenced])
    sessionId = (await db.query<{ id: string }>(
      `INSERT INTO sessions (id, product_id, starts_at, status, cohort_id, cohort_sequence, updated_at)
       VALUES (gen_random_uuid(), $1, now() + interval '30 days', 'PUBLISHED', $2, 1, now()) RETURNING id`,
      [referenced, cohort.rows[0]!.id],
    )).rows[0]!.id

    await db.exec(sql(RETIRE))
  }, 60_000) // PGlite start-up plus four migrations can exceed the 10 s default while other db suites run in parallel
  afterAll(async () => db?.close())

  it('deletes an unreferenced obsolete product and archives (deactivates) a referenced one; others are untouched', async () => {
    expect(await rows()).toEqual([
      { slug: 'detailed-training', is_active: false, archived: true },
      { slug: 'online-training', is_active: true, archived: false },
    ])
  })

  it('keeps the referenced sessions and cohorts intact', async () => {
    const session = await db.query<{ product_id: string; status: string }>(`SELECT product_id, status FROM sessions WHERE id = $1`, [sessionId])
    expect(session.rows).toEqual([{ product_id: referenced, status: 'PUBLISHED' }])
    expect((await db.query(`SELECT 1 FROM training_cohorts WHERE product_id = $1`, [referenced])).rows).toHaveLength(1)
  })

  it('does not let an archived product be re-activated', async () => {
    await expect(db.query(`UPDATE products SET is_active = true WHERE slug = 'detailed-training'`)).rejects.toThrow(/products_archived_inactive/)
  })

  it('is safe to re-run its data steps (no further changes)', async () => {
    const before = await rows()
    const dataSteps = sql(RETIRE).slice(sql(RETIRE).indexOf('DELETE FROM'))
    await db.exec(dataSteps)
    expect(await rows()).toEqual(before)
  })
})
