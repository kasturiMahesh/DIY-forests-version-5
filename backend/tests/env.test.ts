import { describe, expect, it } from 'vitest'
import { ConfigError, loadEnv } from '../src/config/env.js'

describe('loadEnv', () => {
  it('applies development defaults', () => {
    expect(loadEnv({})).toEqual({
      nodeEnv: 'development',
      port: 3000,
      corsOrigins: ['http://localhost:5173', 'http://localhost:4173'],
      trustProxy: 0,
    })
  })

  it('parses PORT and a comma-separated origin list', () => {
    const env = loadEnv({ NODE_ENV: 'production', PORT: '8080', CORS_ORIGINS: ' https://diyforests.example , https://www.diyforests.example ' })
    expect(env).toEqual({ nodeEnv: 'production', port: 8080, corsOrigins: ['https://diyforests.example', 'https://www.diyforests.example'], trustProxy: 0 })
  })

  it.each([
    [{ PORT: 'abc' }, /PORT/],
    [{ PORT: '70000' }, /PORT/],
    [{ NODE_ENV: 'staging' }, /NODE_ENV/],
    [{ CORS_ORIGINS: 'https://ok.example,not a url' }, /not a url/],
    [{ CORS_ORIGINS: 'https://example.com/path' }, /must be an origin/],
  ])('rejects invalid config %j', (source, message) => {
    expect(() => loadEnv(source)).toThrow(ConfigError)
    expect(() => loadEnv(source)).toThrow(message)
  })

  it('requires CORS_ORIGINS in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS is required in production/)
  })
})
