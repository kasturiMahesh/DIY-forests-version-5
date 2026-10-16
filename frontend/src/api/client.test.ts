import { describe, expect, it } from 'vitest'
import { ApiError, createApiClient } from './client'

const product = {
  id: '0199a000-0000-7000-8000-000000000001', slug: 'monthly-webinar', name: 'Monthly Webinar', type: 'WEBINAR',
  summary: 'Q&A', description: null, audience: null, durationLabel: null, price: { amount: '149.00', currency: 'INR' },
}
const session = {
  id: '0199a000-0000-7000-8000-000000000002', startsAt: '2026-11-06T13:00:00.000Z', endsAt: null, timezone: 'Asia/Kolkata', capacity: 40,
  product: { id: product.id, slug: product.slug, name: product.name, type: product.type, price: product.price },
}

type Call = { url: string; init?: RequestInit }
function fakeFetch(respond: (url: string) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) })
    return respond(String(input))
  }) as typeof fetch
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected the call to fail')
}

describe('createApiClient', () => {
  it('lists products, preserving exact decimal strings and currencies', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(() => json({ data: [product] }), calls) })
    const products = await client.listProducts()
    expect(products).toEqual([product])
    expect(products[0]!.price).toEqual({ amount: '149.00', currency: 'INR' })
    expect(calls[0]!.url).toBe('/api/v1/products')
  })

  it('builds session queries and returns meta', async () => {
    const calls: Call[] = []
    const meta = { from: '2026-10-16T05:00:00.000Z', limit: 1, count: 1 }
    const client = createApiClient({ baseUrl: 'https://api.example.com/', fetch: fakeFetch(() => json({ data: [session], meta }), calls) })
    expect(await client.listSessions({ type: 'WEBINAR', limit: 1 })).toEqual({ sessions: [session], meta })
    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/sessions?type=WEBINAR&limit=1')
  })

  it('encodes path parameters', async () => {
    const calls: Call[] = []
    const client = createApiClient({ fetch: fakeFetch(() => json({ data: product }), calls) })
    await client.getProduct('monthly-webinar')
    await client.getProduct('a/b').catch(() => {})
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/products/monthly-webinar', '/api/v1/products/a%2Fb'])
  })

  it('turns an API error envelope into an http ApiError with code and request id', async () => {
    const client = createApiClient({ fetch: fakeFetch(() => json({ error: { code: 'CATALOG_UNAVAILABLE', message: 'The catalog is temporarily unavailable.', requestId: 'r1' } }, 503, { 'X-Request-Id': 'r1' })) })
    const error = await failure(client.listProducts())
    expect(error).toMatchObject({ kind: 'http', message: 'The catalog is temporarily unavailable.', details: { status: 503, code: 'CATALOG_UNAVAILABLE', requestId: 'r1' } })
  })

  it('handles non-JSON error pages (e.g. a proxy 502)', async () => {
    const client = createApiClient({ fetch: fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 })) })
    expect(await failure(client.listProducts())).toMatchObject({ kind: 'http', message: 'Request failed (502).', details: { status: 502 } })
  })

  it('reports network failures without leaking the low-level error', async () => {
    const client = createApiClient({ fetch: (() => Promise.reject(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:3000'))) as typeof fetch })
    expect(await failure(client.listSessions())).toMatchObject({ kind: 'network', message: 'Could not reach the server.' })
  })

  it('times out slow responses', async () => {
    const never = ((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as typeof fetch
    const client = createApiClient({ fetch: never, timeoutMs: 20 })
    expect(await failure(client.listProducts())).toMatchObject({ kind: 'timeout' })
  })

  it.each([
    ['a float price', { data: [{ ...product, price: { amount: 149, currency: 'INR' } }] }],
    ['a lower-case currency', { data: [{ ...product, price: { amount: '149.00', currency: 'inr' } }] }],
    ['an unknown product type', { data: [{ ...product, type: 'PODCAST' }] }],
    ['a missing data array', { products: [product] }],
    ['a 200 with an empty body', null],
  ])('rejects %s as invalid-response', async (_label, body) => {
    const client = createApiClient({ fetch: fakeFetch(() => (body === null ? new Response('', { status: 200 }) : json(body))) })
    expect(await failure(client.listProducts())).toMatchObject({ kind: 'invalid-response' })
  })

  it.each([
    ['a local (offset-less) startsAt', { ...session, startsAt: '2026-11-06T18:30:00' }],
    ['an offset instead of UTC Z', { ...session, startsAt: '2026-11-06T18:30:00+05:30' }],
    ['a zero capacity', { ...session, capacity: 0 }],
  ])('rejects a session with %s', async (_label, bad) => {
    const client = createApiClient({ fetch: fakeFetch(() => json({ data: [bad], meta: { from: '2026-10-16T05:00:00.000Z', limit: 50, count: 1 } })) })
    expect(await failure(client.listSessions())).toMatchObject({ kind: 'invalid-response' })
  })
})
