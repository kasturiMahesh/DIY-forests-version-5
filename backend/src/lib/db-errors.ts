// Reads PostgreSQL failures out of Prisma 7 errors (pg driver adapter) without ever exposing them.
// Prisma reports a unique violation as P2002, and CHECK / trigger failures (SQLSTATE 23514) as P2039
// (model queries) or P2010 (raw queries); the SQLSTATE and constraint sit under meta.driverAdapterError.

type AdapterCause = { code?: string; originalCode?: string; message?: string; originalMessage?: string; constraint?: { index?: string } }

const adapterCause = (error: unknown): AdapterCause | undefined =>
  ((error as { meta?: { driverAdapterError?: { cause?: AdapterCause } } })?.meta?.driverAdapterError?.cause)

export type DbFailure = {
  /** Prisma error code, e.g. "P2002". */
  prismaCode: string | undefined
  /** PostgreSQL SQLSTATE, e.g. "23505" (unique) or "23514" (check / trigger). */
  sqlState: string | undefined
  /** Violated constraint or unique index name, when PostgreSQL reported one. */
  constraint: string | undefined
}

export function dbFailure(error: unknown): DbFailure {
  const cause = adapterCause(error)
  const message = cause?.originalMessage ?? cause?.message ?? ''
  return {
    prismaCode: (error as { code?: unknown })?.code === undefined ? undefined : String((error as { code: unknown }).code),
    sqlState: cause?.originalCode ?? cause?.code,
    constraint: cause?.constraint?.index ?? /constraint "([^"]+)"/.exec(message)?.[1],
  }
}

export const isUniqueViolation = (error: unknown, index?: string) => {
  const failure = dbFailure(error)
  return (failure.prismaCode === 'P2002' || failure.sqlState === '23505') && (index === undefined || failure.constraint === index)
}

export const isCheckViolation = (error: unknown, constraint?: string) => {
  const failure = dbFailure(error)
  return failure.sqlState === '23514' && (constraint === undefined || failure.constraint === constraint)
}

/**
 * A log-safe stand-in for a database error. PostgreSQL's "Failing row contains (...)" detail and
 * Prisma's message (which quotes the calling source) can carry customer data such as phone numbers,
 * so only the codes and the constraint name are kept.
 */
export function sanitizedDbError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error('Non-error thrown')
  const failure = dbFailure(error)
  if (failure.prismaCode === undefined && failure.sqlState === undefined) {
    // Not a database error (e.g. a connection or timeout failure): the name and first line are enough.
    // First non-empty line only (Prisma messages start with a newline; later lines quote arguments).
    const safe = new Error(error.message.split('\n').find((line) => line.trim() !== '')?.trim().slice(0, 200) ?? '')
    safe.name = error.name
    return safe
  }
  const safe = new Error(`Database error ${failure.prismaCode ?? '?'} / SQLSTATE ${failure.sqlState ?? '?'}${failure.constraint ? ` (${failure.constraint})` : ''}`)
  safe.name = error.name
  return safe
}

/** True for errors raised by Prisma or its driver adapter (their messages may quote query arguments). */
export const isPrismaError = (error: unknown) =>
  error instanceof Error && (error.name.startsWith('PrismaClient') || error.name === 'DriverAdapterError' || adapterCause(error) !== undefined)

/** { name, message } for logs: Prisma errors are reduced to codes and constraint names (no row data or arguments). */
export function describeForLog(error: unknown): { name: string; message: string } | string {
  if (!(error instanceof Error)) return String(error)
  const safe = isPrismaError(error) ? sanitizedDbError(error) : error
  return { name: error.name, message: safe.message }
}
