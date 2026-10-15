type Level = 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

export type Logger = Record<Level, (message: string, fields?: Fields) => void>

/** Minimal structured (JSON-lines) logger. Silent in tests. */
export function createLogger(nodeEnv: string): Logger {
  const write = (level: Level) => (message: string, fields: Fields = {}) => {
    if (nodeEnv === 'test') return
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}
