import { createApp } from '../src/app.js'
import { loadEnv } from '../src/config/env.js'
import type { Logger } from '../src/lib/logger.js'

export type LoggedLine = { level: string; message: string; fields?: Record<string, unknown> }

/** Logger that records lines so tests can assert on what would be logged. */
export function memoryLogger(lines: LoggedLine[] = []): Logger {
  const write = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push(fields === undefined ? { level, message } : { level, message, fields })
  }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}

export function testApp() {
  return createApp({ env: loadEnv({ NODE_ENV: 'test' }), version: '9.9.9-test', logger: memoryLogger() })
}
