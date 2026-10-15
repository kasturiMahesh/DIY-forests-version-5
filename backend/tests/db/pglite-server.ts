// Isolated, throwaway PostgreSQL for integration tests: PGlite (Postgres compiled to WASM)
// served over the Postgres wire protocol on a local port. In-memory, no account, no network.
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

const execFileAsync = promisify(execFile)
export const BACKEND_DIR = path.resolve(import.meta.dirname, '../..')
const PRISMA_CLI = path.join(BACKEND_DIR, 'node_modules/prisma/build/index.js')

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

export type TestDatabase = { url: string; stop: () => Promise<void> }

export async function startTestDatabase(): Promise<TestDatabase> {
  const db = await PGlite.create()
  const port = await freePort()
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 8 })
  await server.start()
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    stop: async () => {
      await server.stop()
      await db.close()
    },
  }
}

/**
 * Run the real Prisma CLI against the test database. Must be asynchronous: PGlite serves
 * connections from this same process, so a synchronous spawn would deadlock.
 * The environment is built from scratch so a developer's backend/.env can never redirect
 * these commands to a real database (the CLI only loads .env when the variable is unset).
 */
export async function prismaCli(args: string[], url: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    CHECKPOINT_DISABLE: '1',
    NODE_ENV: 'test',
    DATABASE_URL: url,
    DIRECT_DATABASE_URL: url,
    ...extraEnv,
  }
  return execFileAsync(process.execPath, [PRISMA_CLI, ...args], { cwd: BACKEND_DIR, env, timeout: 120_000, windowsHide: true })
}
