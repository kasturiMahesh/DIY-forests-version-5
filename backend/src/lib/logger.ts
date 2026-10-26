type Level = 'info' | 'warn' | 'error'
type Fields = Record<string, unknown>

export type Logger = Record<Level, (message: string, fields?: Fields) => void>

// Defence in depth: values under these keys are never written, wherever they appear in a log entry.
const SECRET_KEYS = /^(cookie|set-cookie|authorization|password|secret|clientsecret|token|sessiontoken|accesstoken|idtoken|refreshtoken|csrftoken|codeverifier|code_verifier|nonce|state)$/i

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : redact(item, depth + 1)]))
}

/** Minimal structured (JSON-lines) logger. Silent in tests. Secret-looking keys are redacted. */
export function createLogger(nodeEnv: string): Logger {
  const write = (level: Level) => (message: string, fields: Fields = {}) => {
    if (nodeEnv === 'test') return
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...(redact(fields) as Fields) })
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}
