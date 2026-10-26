import { existsSync } from 'node:fs'
import { defineConfig } from 'prisma/config'

// Prisma 7 does not load .env files itself. Use Node's built-in loader (no dotenv dependency).
if (existsSync('.env')) process.loadEnvFile('.env')

// The Prisma CLI (migrate, db seed, studio) connects with the DIRECT (non-pooled) URL:
// migrations need a session-level connection that a PgBouncer-style pooler cannot provide.
// The running app uses DATABASE_URL (pooled) instead; see src/config/database.ts.
// Left unset, `prisma validate` and `prisma generate` still work offline.
const directUrl = process.env.DIRECT_DATABASE_URL

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(directUrl ? { datasource: { url: directUrl } } : {}),
})
