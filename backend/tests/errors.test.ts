import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/lib/http-error.js'
import { errorHandler } from '../src/middleware/error-handler.js'
import { notFound } from '../src/middleware/not-found.js'
import { requestId } from '../src/middleware/request-id.js'
import { memoryLogger, testApp, type LoggedLine } from './helpers.js'

const errorShape = (code: string) => ({ error: { code, message: expect.any(String), requestId: expect.any(String) } })

describe('JSON 404 responses', () => {
  it.each(['/api/v1/does-not-exist', '/', '/api/v2/health'])('returns a JSON 404 for %s', async (path) => {
    const res = await request(testApp()).get(path)

    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).toEqual(errorShape('NOT_FOUND'))
    expect(res.body.error.requestId).toBe(res.headers['x-request-id'])
  })

  it('returns 404 for an unsupported method on an existing path', async () => {
    const res = await request(testApp()).post('/api/v1/health').send({})
    expect(res.status).toBe(404)
    expect(res.body).toEqual(errorShape('NOT_FOUND'))
  })
})

describe('request body errors (through the real app)', () => {
  it('rejects malformed JSON with 400', async () => {
    const res = await request(testApp()).post('/api/v1/health').set('Content-Type', 'application/json').send('{"bad": ')

    expect(res.status).toBe(400)
    expect(res.body).toEqual(errorShape('INVALID_JSON'))
    expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|at .+\.js/)
  })

  it('rejects bodies over 100kb with 413', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(110 * 1024) })
    const res = await request(testApp()).post('/api/v1/health').set('Content-Type', 'application/json').send(big)

    expect(res.status).toBe(413)
    expect(res.body).toEqual(errorShape('PAYLOAD_TOO_LARGE'))
  })
})

describe('error handler', () => {
  function appThrowing(error: unknown, lines: LoggedLine[]) {
    const app = express()
    app.use(requestId)
    app.get('/boom', () => {
      throw error
    })
    app.get('/async-boom', async () => {
      await Promise.resolve()
      throw error
    })
    app.use(notFound)
    app.use(errorHandler(memoryLogger(lines)))
    return app
  }

  it('hides internal details of unexpected errors and logs them', async () => {
    const lines: LoggedLine[] = []
    const res = await request(appThrowing(new Error('db password=hunter2 leaked'), lines)).get('/boom')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: res.headers['x-request-id'] } })
    expect(JSON.stringify(res.body)).not.toContain('hunter2')
    expect(JSON.stringify(res.body)).not.toContain('stack')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', fields: { requestId: res.headers['x-request-id'], path: '/boom' } })
  })

  it('catches errors thrown from async handlers (Express 5)', async () => {
    const res = await request(appThrowing(new Error('async failure'), [])).get('/async-boom')
    expect(res.status).toBe(500)
    expect(res.body).toEqual(errorShape('INTERNAL_ERROR'))
  })

  it('handles non-Error throw values', async () => {
    const res = await request(appThrowing('just a string', [])).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body).toEqual(errorShape('INTERNAL_ERROR'))
  })

  it('passes through HttpError status, code and message without logging', async () => {
    const lines: LoggedLine[] = []
    const res = await request(appThrowing(new HttpError(409, 'SEAT_UNAVAILABLE', 'No seats left'), lines)).get('/boom')

    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'SEAT_UNAVAILABLE', message: 'No seats left' })
    expect(lines).toHaveLength(0)
  })
})
