import { existsSync, readFileSync } from 'node:fs'
import { createApp } from './app.js'
import { ConfigError, loadEnv } from './config/env.js'
import { createLogger } from './lib/logger.js'

// Local development convenience: load backend/.env if present (Node's built-in loader, no dependency).
if (existsSync('.env')) process.loadEnvFile('.env')

// package.json sits one level above both src/ (tsx) and dist/ (compiled).
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

let env
try {
  env = loadEnv()
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}

const logger = createLogger(env.nodeEnv)
const app = createApp({ env, version, logger })
const server = app.listen(env.port, () => {
  logger.info('API listening', { port: env.port, nodeEnv: env.nodeEnv, version })
})

function shutdown(signal: string) {
  logger.info('Shutting down', { signal })
  server.close(() => process.exit(0))
  // Force exit if open connections keep the server alive.
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
