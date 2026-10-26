import { Router } from 'express'

export type ReadinessCheck = 'ok' | 'unavailable' | 'not_configured'
export type ReadyResponse = { status: 'ready' | 'not_ready'; checks: { database: ReadinessCheck; shuttingDown: boolean } }

export type ReadinessOptions = {
  /** Resolves when the database answers (and is usable); null when no database is configured. */
  checkDatabase: (() => Promise<void>) | null
  /** True once graceful shutdown has begun: stop receiving new traffic. */
  isShuttingDown?: () => boolean
  timeoutMs?: number
}

/**
 * Readiness (GET /ready): can this instance serve real traffic right now? Unlike /health (liveness:
 * "the process is up", no dependencies), this checks the database and answers 503 when it is missing,
 * unreachable or slow, or while the instance is shutting down. No error detail is ever returned.
 */
export function readinessRouter({ checkDatabase, isShuttingDown = () => false, timeoutMs = 2_000 }: ReadinessOptions): Router {
  const router = Router()
  router.get('/ready', async (_req, res) => {
    let database: ReadinessCheck = 'not_configured'
    if (checkDatabase) {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          checkDatabase(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs) }),
        ])
        database = 'ok'
      } catch {
        database = 'unavailable'
      } finally {
        clearTimeout(timer)
      }
    }
    const shuttingDown = isShuttingDown()
    const ready = database === 'ok' && !shuttingDown
    const body: ReadyResponse = { status: ready ? 'ready' : 'not_ready', checks: { database, shuttingDown } }
    res.status(ready ? 200 : 503).set('Cache-Control', 'no-store').json(body)
  })
  return router
}
