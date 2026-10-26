import { describe, expect, it } from 'vitest'
import { ConfigError } from '../src/config/env.js'
import { describeDatabaseUrl, loadDatabaseConfig } from '../src/config/database.js'

const SECRET = 's3cr3t-p4ss'

describe('loadDatabaseConfig', () => {
  it('accepts postgresql:// and postgres:// URLs', () => {
    const url = `postgresql://app:${SECRET}@ep-cool-pooler.ap-southeast-1.aws.neon.tech/diyforests?sslmode=verify-full`
    expect(loadDatabaseConfig({ DATABASE_URL: ` ${url} ` })).toEqual({ url })
    expect(loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' }).url).toBe('postgres://u:p@localhost:5432/db')
  })

  it('explains how to fix a missing DATABASE_URL', () => {
    expect(() => loadDatabaseConfig({})).toThrow(ConfigError)
    expect(() => loadDatabaseConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL is missing.*backend\/\.env/)
  })

  it.each([
    ['not a URL', `app:${SECRET}@host/db`],
    ['wrong protocol', `mysql://app:${SECRET}@host/db`],
    ['no database name', `postgresql://app:${SECRET}@host`],
  ])('rejects %s without echoing the password', (_label, value) => {
    let message = ''
    try {
      loadDatabaseConfig({ DATABASE_URL: value })
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      message = (error as Error).message
    }
    expect(message).toMatch(/DATABASE_URL/)
    expect(message).not.toContain(SECRET)
    expect(message).not.toContain('app:')
  })
})

describe('describeDatabaseUrl', () => {
  it('shows only host, port and database', () => {
    expect(describeDatabaseUrl(`postgresql://app:${SECRET}@db.internal:6543/diy?sslmode=require`)).toBe('db.internal:6543/diy')
    expect(describeDatabaseUrl(`postgresql://app:${SECRET}@db.internal/diy`)).toBe('db.internal/diy')
    expect(describeDatabaseUrl('nonsense')).toBe('(unparseable database URL)')
  })
})
