// Offline checks: no database and no DATABASE_URL / DIRECT_DATABASE_URL needed.
import { describe, expect, it } from 'vitest'
import { Prisma } from '../src/generated/prisma/client.js'
import { ProductType, SessionStatus } from '../src/generated/prisma/enums.js'
import { prismaCli } from './db/pglite-server.js'

const offline = { DATABASE_URL: '', DIRECT_DATABASE_URL: '' }

describe('Prisma schema (offline)', () => {
  it('validates without any database configured', async () => {
    const { stdout, stderr } = await prismaCli(['validate'], '', offline)
    expect(stdout + stderr).toMatch(/is valid/)
  }, 60_000)

  // Client generation is verified by `pretest` (prisma generate), not here: regenerating inside the
  // suite would rewrite src/generated while other test files are importing it in parallel.

  it('exposes the expected enums and fields', () => {
    expect(Object.values(ProductType)).toEqual(['ONLINE_TRAINING', 'OFFLINE_WORKSHOP', 'WEBINAR'])
    expect(Object.values(SessionStatus)).toEqual(['DRAFT', 'PUBLISHED', 'CANCELLED'])
    expect(Object.values(Prisma.ProductScalarFieldEnum)).toEqual([
      'id', 'slug', 'name', 'type', 'summary', 'description', 'audience', 'durationLabel', 'priceAmount', 'currency', 'isActive', 'createdAt', 'updatedAt',
    ])
    expect(Object.values(Prisma.SessionScalarFieldEnum)).toEqual([
      'id', 'productId', 'startsAt', 'endsAt', 'timezone', 'capacity', 'status', 'internalNote', 'venue', 'cohortId', 'cohortSequence', 'createdAt', 'updatedAt',
    ])
  })

  it('represents prices as exact decimals, not floats', () => {
    const price = new Prisma.Decimal('100000.00')
    expect(price.plus('0.10').toFixed(2)).toBe('100000.10')
    expect(new Prisma.Decimal('0.1').plus('0.2').toString()).toBe('0.3') // a float would give 0.30000000000000004
  })
})
