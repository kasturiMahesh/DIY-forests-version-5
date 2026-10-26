import { describe, expect, it } from 'vitest'
import { ConfigError, loadEnv } from '../src/config/env.js'

describe('loadEnv', () => {
  it('applies development defaults', () => {
    expect(loadEnv({})).toEqual({
      nodeEnv: 'development',
      port: 3000,
      corsOrigins: ['http://localhost:5173', 'http://localhost:4173'],
      trustProxy: 0,
      paymentSimulator: false,
      bookingConfirmationMode: 'manual',
    })
  })

  it('parses PORT and a comma-separated origin list', () => {
    const env = loadEnv({ NODE_ENV: 'production', PORT: '8080', CORS_ORIGINS: ' https://diyforests.example , https://www.diyforests.example ' })
    expect(env).toEqual({ nodeEnv: 'production', port: 8080, corsOrigins: ['https://diyforests.example', 'https://www.diyforests.example'], trustProxy: 0, paymentSimulator: false, bookingConfirmationMode: 'manual' })
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

describe('loadEnv: Stage 2 payment simulator', () => {
  it('is disabled by default in every environment', () => {
    expect(loadEnv({}).paymentSimulator).toBe(false)
    expect(loadEnv({ NODE_ENV: 'development' }).paymentSimulator).toBe(false)
    expect(loadEnv({ NODE_ENV: 'test' }).paymentSimulator).toBe(false)
    expect(loadEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'https://diyforests.example' }).paymentSimulator).toBe(false)
    expect(loadEnv({ NODE_ENV: 'development', PAYMENT_SIMULATOR: 'false' }).paymentSimulator).toBe(false)
  })

  it('is enabled only with NODE_ENV=development and PAYMENT_SIMULATOR=true', () => {
    expect(loadEnv({ NODE_ENV: 'development', PAYMENT_SIMULATOR: 'true' }).paymentSimulator).toBe(true)
  })

  it.each([
    [{ NODE_ENV: 'production', CORS_ORIGINS: 'https://diyforests.example', PAYMENT_SIMULATOR: 'true' }],
    [{ NODE_ENV: 'test', PAYMENT_SIMULATOR: 'true' }],
  ])('refuses to start with the simulator outside development: %j', (source) => {
    expect(() => loadEnv(source)).toThrow(ConfigError)
    expect(() => loadEnv(source)).toThrow(/PAYMENT_SIMULATOR=true is allowed only with NODE_ENV=development/)
  })

  it.each(['1', 'yes', 'TRUE', ''])('rejects the ambiguous value PAYMENT_SIMULATOR=%j', (value) => {
    expect(() => loadEnv({ NODE_ENV: 'development', PAYMENT_SIMULATOR: value })).toThrow(/PAYMENT_SIMULATOR/)
  })
})

describe('loadEnv: Revision 3 booking confirmation mode', () => {
  it('defaults to manual in every environment', () => {
    for (const source of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'production', CORS_ORIGINS: 'https://diyforests.example' }, { NODE_ENV: 'development', PAYMENT_SIMULATOR: 'true' }]) {
      expect(loadEnv(source).bookingConfirmationMode).toBe('manual')
    }
    expect(loadEnv({ BOOKING_CONFIRMATION_MODE: 'manual', NODE_ENV: 'production', CORS_ORIGINS: 'https://diyforests.example' }).bookingConfirmationMode).toBe('manual')
  })

  it('allows payment mode only with NODE_ENV=development and PAYMENT_SIMULATOR=true', () => {
    expect(loadEnv({ NODE_ENV: 'development', PAYMENT_SIMULATOR: 'true', BOOKING_CONFIRMATION_MODE: 'payment' })).toMatchObject({ bookingConfirmationMode: 'payment', paymentSimulator: true })
  })

  it.each([
    [{ NODE_ENV: 'production', CORS_ORIGINS: 'https://diyforests.example', BOOKING_CONFIRMATION_MODE: 'payment' }],
    [{ NODE_ENV: 'test', BOOKING_CONFIRMATION_MODE: 'payment' }],
    [{ NODE_ENV: 'development', BOOKING_CONFIRMATION_MODE: 'payment' }],
    [{ NODE_ENV: 'development', PAYMENT_SIMULATOR: 'false', BOOKING_CONFIRMATION_MODE: 'payment' }],
  ])('refuses payment mode without the development simulator: %j', (source) => {
    expect(() => loadEnv(source)).toThrow(ConfigError)
    expect(() => loadEnv(source)).toThrow(/BOOKING_CONFIRMATION_MODE=payment requires NODE_ENV=development and PAYMENT_SIMULATOR=true/)
  })

  it('never enables the simulator by itself', () => {
    expect(loadEnv({ NODE_ENV: 'development', BOOKING_CONFIRMATION_MODE: 'manual' }).paymentSimulator).toBe(false)
  })

  it.each(['Manual', 'PAYMENT', 'auto', ''])('rejects the invalid value BOOKING_CONFIRMATION_MODE=%j', (value) => {
    expect(() => loadEnv({ BOOKING_CONFIRMATION_MODE: value })).toThrow(/BOOKING_CONFIRMATION_MODE/)
  })
})
