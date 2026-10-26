import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadEnv } from '../src/config/env.js'
import { createShutdown } from '../src/lib/shutdown.js'
import { memoryLogger, testApp, type LoggedLine } from './helpers.js'

// Unit tests with fakes: readiness is exercised over HTTP with a stubbed database check, and
// shutdown with a fake server (no real signals, sockets or database).

const env = loadEnv({ NODE_ENV: 'test' })
const appWith = (checkDatabase: (() => Promise<void>) | null, isShuttingDown = () => false) =>
  createApp({ env, version: 't', logger: memoryLogger(), readiness: { checkDatabase, isShuttingDown, timeoutMs: 50 } })

describe('GET /api/v1/ready (readiness) vs /health (liveness)', () => {
  it('ready only when the database answers', async () => {
    const res = await request(appWith(async () => {})).get('/api/v1/ready')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'ok', shuttingDown: false } })
  })

  it('503 without a configured database, while /health stays 200', async () => {
    const app = testApp()
    expect((await request(app).get('/api/v1/ready')).body).toEqual({ status: 'not_ready', checks: { database: 'not_configured', shuttingDown: false } })
    expect((await request(app).get('/api/v1/ready')).status).toBe(503)
    expect((await request(app).get('/api/v1/health')).status).toBe(200)
  })

  it('503 when the database fails, without leaking the error', async () => {
    const res = await request(appWith(async () => { throw new Error('password authentication failed for user "admin" at db.internal:5432') })).get('/api/v1/ready')
    expect(res.status).toBe(503)
    expect(res.body.checks.database).toBe('unavailable')
    expect(JSON.stringify(res.body)).not.toMatch(/password|db\.internal|5432/)
  })

  it('503 when the database hangs (bounded by a timeout)', async () => {
    const started = Date.now()
    const res = await request(appWith(() => new Promise(() => {}))).get('/api/v1/ready')
    expect(res.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('503 as soon as shutdown has begun', async () => {
    const res = await request(appWith(async () => {}, () => true)).get('/api/v1/ready')
    expect(res.status).toBe(503)
    expect(res.body.checks).toEqual({ database: 'ok', shuttingDown: true })
  })
})

describe('graceful shutdown', () => {
  afterEach(() => vi.useRealTimers())

  const fakeServer = () => {
    const calls: string[] = []
    let finish: ((error?: Error) => void) | undefined
    return {
      calls,
      finishClose: (error?: Error) => finish?.(error),
      server: { close: (callback: (error?: Error) => void) => { calls.push('close'); finish = callback }, closeIdleConnections: () => calls.push('closeIdle') },
    }
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  it('stops accepting connections, waits for in-flight requests, then closes the database and exits 0', async () => {
    const { server, calls, finishClose } = fakeServer()
    const exits: number[] = []
    const shutdown = createShutdown({ server, disconnect: async () => { calls.push('disconnect') }, logger: memoryLogger(), exit: (code) => exits.push(code) })
    expect(shutdown.isShuttingDown()).toBe(false)
    shutdown.shutdown('SIGTERM')
    expect(shutdown.isShuttingDown()).toBe(true)
    expect(calls).toEqual(['close', 'closeIdle'])
    expect(exits).toEqual([]) // nothing is torn down while requests are still finishing
    finishClose()
    await flush()
    expect(calls).toEqual(['close', 'closeIdle', 'disconnect'])
    expect(exits).toEqual([0])
  })

  it('ignores a second signal', () => {
    const { server, calls } = fakeServer()
    const shutdown = createShutdown({ server, disconnect: async () => {}, logger: memoryLogger(), exit: () => {} })
    shutdown.shutdown('SIGTERM')
    shutdown.shutdown('SIGINT')
    expect(calls.filter((call) => call === 'close')).toHaveLength(1)
  })

  it('exits 1 and logs (without secrets) when the database disconnect fails', async () => {
    const { server, finishClose } = fakeServer()
    const lines: LoggedLine[] = []
    const exits: number[] = []
    const shutdown = createShutdown({ server, disconnect: async () => { throw new Error('socket hang up') }, logger: memoryLogger(lines), exit: (code) => exits.push(code) })
    shutdown.shutdown('SIGTERM')
    finishClose()
    await flush()
    expect(exits).toEqual([1])
    expect(lines.find((line) => line.level === 'error')).toMatchObject({ message: 'Database disconnect failed', fields: { error: 'socket hang up' } })
  })

  it('forces exit 1 when connections keep the server open past the deadline', () => {
    vi.useFakeTimers()
    const { server } = fakeServer()
    const exits: number[] = []
    createShutdown({ server, disconnect: async () => {}, logger: memoryLogger(), exit: (code) => exits.push(code), forceAfterMs: 1_000 }).shutdown('SIGTERM')
    vi.advanceTimersByTime(999)
    expect(exits).toEqual([])
    vi.advanceTimersByTime(1)
    expect(exits).toEqual([1])
  })
})
