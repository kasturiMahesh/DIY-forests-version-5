// Operator CLI: `npm run admin -- <command> …` (see src/modules/auth/admin-cli.ts or run with no arguments).
// Uses backend/.env. Prints account ids, pools, roles, statuses and the email searched for; never tokens.
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { loadAuthConfig } from '../src/config/auth.js'
import { loadDatabaseConfig } from '../src/config/database.js'
import { ConfigError, loadEnv } from '../src/config/env.js'
import { createPrismaClient } from '../src/db/client.js'
import { CliUsageError, runAdminCommand } from '../src/modules/auth/admin-cli.js'
import { createAuthRepository } from '../src/modules/auth/auth.repository.js'

if (existsSync('.env')) process.loadEnvFile('.env')

let prisma
try {
  const env = loadEnv()
  const authConfig = loadAuthConfig(process.env, env)
  prisma = createPrismaClient(loadDatabaseConfig().url, { maxConnections: 1 })
  const actor = (() => {
    try {
      return userInfo().username
    } catch {
      return 'unknown'
    }
  })()
  await runAdminCommand(process.argv.slice(2), { repository: createAuthRepository(prisma), authConfig, actorLabel: `operator-cli:${actor}`.slice(0, 120) })
} catch (error) {
  if (error instanceof CliUsageError || error instanceof ConfigError) {
    console.error(error.message)
    process.exitCode = 1
  } else {
    console.error('Command failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
} finally {
  await prisma?.$disconnect()
}
