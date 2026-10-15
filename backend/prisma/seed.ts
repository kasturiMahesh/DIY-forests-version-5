// Development seed entry point. Run with `npm run db:seed` (prisma db seed → tsx prisma/seed.ts).
import { existsSync } from 'node:fs'
import { ConfigError } from '../src/config/env.js'
import { describeDatabaseUrl, loadDatabaseConfig } from '../src/config/database.js'
import { createPrismaClient } from '../src/db/client.js'
import { seedCatalog } from '../src/db/seed-catalog.js'

if (existsSync('.env')) process.loadEnvFile('.env')

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV is "production". The seed contains development data only.')
  process.exit(1)
}

let url: string
try {
  ;({ url } = loadDatabaseConfig())
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}

const prisma = createPrismaClient(url, { maxConnections: 1 })
try {
  const result = await seedCatalog(prisma)
  console.log(`Seeded ${result.products} products and ${result.sessions} session(s) into ${describeDatabaseUrl(url)}.`)
} finally {
  await prisma.$disconnect()
}
