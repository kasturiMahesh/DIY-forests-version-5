import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { testApp } from './helpers.js'

describe('GET /api/v1/health', () => {
  it('returns ok with service metadata', async () => {
    const res = await request(testApp()).get('/api/v1/health')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      status: 'ok',
      service: 'diy-forests-api',
      version: '9.9.9-test',
      time: expect.any(String),
      uptimeSeconds: expect.any(Number),
    })
    expect(Number.isNaN(Date.parse(res.body.time))).toBe(false)
  })

  it('sets security headers and hides the framework', async () => {
    const res = await request(testApp()).get('/api/v1/health')

    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBeDefined()
    expect(res.headers['strict-transport-security']).toBeDefined()
  })
})

describe('request IDs', () => {
  it('generates a UUID when none is supplied', async () => {
    const res = await request(testApp()).get('/api/v1/health')
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('echoes a safe caller-supplied ID', async () => {
    const res = await request(testApp()).get('/api/v1/health').set('X-Request-Id', 'lb-abc.123_x')
    expect(res.headers['x-request-id']).toBe('lb-abc.123_x')
  })

  it('replaces an unsafe caller-supplied ID', async () => {
    const res = await request(testApp()).get('/api/v1/health').set('X-Request-Id', '<script>alert(1)</script>')
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('CORS', () => {
  it('allows configured origins', async () => {
    const res = await request(testApp()).get('/api/v1/health').set('Origin', 'http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Request-Id/i)
  })

  it('does not allow other origins', async () => {
    const res = await request(testApp()).get('/api/v1/health').set('Origin', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
