import { Router } from 'express'

export type HealthResponse = {
  status: 'ok'
  service: string
  version: string
  time: string
  uptimeSeconds: number
}

/** Liveness check. Deliberately has no dependencies (no database yet). */
export function healthRouter(version: string): Router {
  const router = Router()
  router.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'diy-forests-api',
      version,
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    }
    res.set('Cache-Control', 'no-store').json(body)
  })
  return router
}
