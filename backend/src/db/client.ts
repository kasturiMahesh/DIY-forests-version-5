import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

export type { PrismaClient }

export type PrismaClientOptions = {
  /** Upper bound on pooled connections from this process. */
  maxConnections?: number
}

/**
 * Create a Prisma client over the standard `pg` driver. Works the same against Neon (use the
 * pooled URL) and Amazon RDS, so no business code depends on the database host.
 * The caller owns the client and must `await client.$disconnect()` when done.
 */
export function createPrismaClient(connectionString: string, { maxConnections = 10 }: PrismaClientOptions = {}): PrismaClient {
  const adapter = new PrismaPg({ connectionString, max: maxConnections })
  return new PrismaClient({ adapter })
}
