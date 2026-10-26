import type { Logger } from './logger.js'

type ClosableServer = { close(callback: (error?: Error) => void): unknown; closeIdleConnections?: () => void }

export type ShutdownOptions = {
  server: ClosableServer
  /** Closes the database pool (or other resources) after the HTTP server has stopped. */
  disconnect: () => Promise<void>
  logger: Logger
  exit?: (code: number) => void
  /** Hard deadline: exit(1) if open connections keep the server alive longer than this. */
  forceAfterMs?: number
}

/**
 * Graceful shutdown: stop accepting connections (readiness reports not-ready from the first signal),
 * let in-flight requests finish, then close the database pool and exit. Repeated signals are ignored.
 */
export function createShutdown({ server, disconnect, logger, exit = (code) => process.exit(code), forceAfterMs = 10_000 }: ShutdownOptions) {
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down', { signal })
    const force = setTimeout(() => {
      logger.error('Shutdown timed out; forcing exit', { afterMs: forceAfterMs })
      exit(1)
    }, forceAfterMs)
    force.unref?.()
    server.close((closeError) => {
      if (closeError) logger.error('HTTP server close failed', { error: closeError.message })
      disconnect()
        .then(() => exit(closeError ? 1 : 0), (error: unknown) => {
          logger.error('Database disconnect failed', { error: error instanceof Error ? error.message : String(error) })
          exit(1)
        })
        .finally(() => clearTimeout(force))
    })
    // Keep-alive connections with no request in flight would otherwise hold the server open.
    server.closeIdleConnections?.()
  }
  return { shutdown, isShuttingDown: () => shuttingDown }
}
