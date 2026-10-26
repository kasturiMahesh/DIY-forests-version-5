import type { IdentityPoolName, SessionPolicy } from '../../config/auth.js'
import { assertUtcSession } from '../../db/timezone-guard.js'
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js'
import type { VerifiedIdentity } from './identity-provider.js'
import { sessionExpiry } from './session.js'

export type AccountUser = {
  id: string
  identityPool: IdentityPoolName
  identityIssuer: string
  email: string
  emailVerified: boolean
  displayName: string | null
  role: 'CUSTOMER' | 'ADMIN'
  status: 'ACTIVE' | 'DISABLED'
}

export type StoredSession = {
  id: string
  kind: IdentityPoolName
  lastSeenAt: Date
  idleExpiresAt: Date
  absoluteExpiresAt: Date
  revokedAt: Date | null
  user: AccountUser
}

export type AuditInput = {
  actorUserId?: string | null
  actorLabel: string
  action: string
  targetType?: string
  targetId?: string
  requestId?: string
  details?: Prisma.InputJsonValue
}

export type SignInOutcome =
  | { kind: 'ok'; user: AccountUser }
  | { kind: 'disabled' }
  | { kind: 'not_admin' }

const USER_SELECT = { id: true, identityPool: true, identityIssuer: true, email: true, emailVerified: true, displayName: true, role: true, status: true } as const

export interface AuthRepository {
  /** Customer pool: find-or-create (always CUSTOMER). Never links to other accounts by email. */
  signInCustomer(identity: VerifiedIdentity, now: Date): Promise<SignInOutcome>
  /** Admin pool: only a pre-provisioned ACTIVE ADMIN account may sign in; nothing is created here. */
  signInAdmin(identity: VerifiedIdentity, now: Date): Promise<SignInOutcome>
  createSession(input: { userId: string; kind: IdentityPoolName; tokenHash: string; policy: SessionPolicy; userAgent: string | null; now: Date }): Promise<void>
  findSession(tokenHash: string): Promise<StoredSession | null>
  touchSession(sessionId: string, now: Date, idleExpiresAt: Date): Promise<void>
  revokeSession(tokenHash: string, reason: string, now: Date): Promise<boolean>
  updateDisplayName(userId: string, displayName: string | null): Promise<AccountUser>
  audit(event: AuditInput): Promise<void>
}

/** Operator-only actions (CLI); never exposed over HTTP. */
export interface AccountAdministration {
  grantAdmin(input: { issuer: string; subject: string; email: string; displayName: string | null; actorLabel: string }): Promise<{ user: AccountUser; created: boolean }>
  setStatus(input: { userId: string; status: 'ACTIVE' | 'DISABLED'; actorLabel: string; now: Date }): Promise<{ user: AccountUser; revokedSessions: number }>
  revokeSessions(input: { userId: string; actorLabel: string; now: Date }): Promise<number>
  findUsers(input: { email?: string; userId?: string }): Promise<AccountUser[]>
}

export function createAuthRepository(prisma: PrismaClient): AuthRepository & AccountAdministration {
  // Every write path follows the Stage 2 rule: refuse to work with a non-UTC database session.
  let utcChecked: Promise<void> | null = null
  const ready = () => {
    utcChecked ??= assertUtcSession(prisma).catch((error: unknown) => {
      utcChecked = null
      throw error
    })
    return utcChecked
  }

  const revokeAll = (tx: Prisma.TransactionClient, userId: string, reason: string, now: Date) =>
    tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } }).then((result) => result.count)

  return {
    async signInCustomer(identity, now) {
      await ready()
      return prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { identityIssuer_identitySubject: { identityIssuer: identity.issuer, identitySubject: identity.subject } }, select: USER_SELECT })
        if (existing) {
          if (existing.identityPool !== 'CUSTOMER') return { kind: 'not_admin' } as const // cannot happen with distinct issuers; fail closed
          if (existing.status !== 'ACTIVE') return { kind: 'disabled' } as const
          const user = await tx.user.update({
            where: { id: existing.id },
            data: { email: identity.email, emailVerified: identity.emailVerified, lastLoginAt: now, ...(existing.displayName ? {} : { displayName: identity.name }) },
            select: USER_SELECT,
          })
          return { kind: 'ok', user } as const
        }
        const user = await tx.user.create({
          data: {
            identityPool: 'CUSTOMER', role: 'CUSTOMER', identityIssuer: identity.issuer, identitySubject: identity.subject,
            email: identity.email, emailVerified: identity.emailVerified, displayName: identity.name, lastLoginAt: now,
          },
          select: USER_SELECT,
        })
        await tx.auditEvent.create({ data: { actorUserId: user.id, actorLabel: 'self', action: 'CUSTOMER_REGISTERED', targetType: 'user', targetId: user.id } })
        return { kind: 'ok', user } as const
      })
    },

    async signInAdmin(identity, now) {
      await ready()
      const existing = await prisma.user.findUnique({ where: { identityIssuer_identitySubject: { identityIssuer: identity.issuer, identitySubject: identity.subject } }, select: USER_SELECT })
      if (!existing || existing.identityPool !== 'ADMIN' || existing.role !== 'ADMIN') return { kind: 'not_admin' }
      if (existing.status !== 'ACTIVE') return { kind: 'disabled' }
      const user = await prisma.user.update({ where: { id: existing.id }, data: { email: identity.email, emailVerified: identity.emailVerified, lastLoginAt: now }, select: USER_SELECT })
      return { kind: 'ok', user }
    },

    async createSession({ userId, kind, tokenHash, policy, userAgent, now }) {
      await ready()
      const { idleExpiresAt, absoluteExpiresAt } = sessionExpiry(policy, now)
      await prisma.authSession.create({ data: { userId, kind, tokenHash, createdAt: now, lastSeenAt: now, idleExpiresAt, absoluteExpiresAt, userAgent: userAgent?.slice(0, 200) ?? null } })
    },

    async findSession(tokenHash) {
      await ready()
      return prisma.authSession.findUnique({
        where: { tokenHash },
        select: { id: true, kind: true, lastSeenAt: true, idleExpiresAt: true, absoluteExpiresAt: true, revokedAt: true, user: { select: USER_SELECT } },
      })
    },

    async touchSession(sessionId, now, idleExpiresAt) {
      await ready()
      await prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } })
    },

    async revokeSession(tokenHash, reason, now) {
      await ready()
      const result = await prisma.authSession.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } })
      return result.count > 0
    },

    async updateDisplayName(userId, displayName) {
      await ready()
      return prisma.user.update({ where: { id: userId }, data: { displayName }, select: USER_SELECT })
    },

    async audit(event) {
      await ready()
      await prisma.auditEvent.create({ data: event })
    },

    // ---- operator CLI ----

    async grantAdmin({ issuer, subject, email, displayName, actorLabel }) {
      await ready()
      return prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { identityIssuer_identitySubject: { identityIssuer: issuer, identitySubject: subject } }, select: USER_SELECT })
        if (existing && existing.identityPool !== 'ADMIN') throw new Error('That identity belongs to the customer pool and can never be an admin')
        const user = existing
          ? await tx.user.update({ where: { id: existing.id }, data: { email: email.toLowerCase(), ...(displayName ? { displayName } : {}) }, select: USER_SELECT })
          : await tx.user.create({ data: { identityPool: 'ADMIN', role: 'ADMIN', identityIssuer: issuer, identitySubject: subject, email: email.toLowerCase(), emailVerified: true, displayName }, select: USER_SELECT })
        await tx.auditEvent.create({ data: { actorLabel, action: 'ADMIN_GRANTED', targetType: 'user', targetId: user.id, details: { created: !existing } } })
        return { user, created: !existing }
      })
    },

    async setStatus({ userId, status, actorLabel, now }) {
      await ready()
      return prisma.$transaction(async (tx) => {
        const user = await tx.user.update({ where: { id: userId }, data: { status, disabledAt: status === 'DISABLED' ? now : null }, select: USER_SELECT })
        const revokedSessions = status === 'DISABLED' ? await revokeAll(tx, userId, 'ACCOUNT_DISABLED', now) : 0
        await tx.auditEvent.create({ data: { actorLabel, action: status === 'DISABLED' ? 'ACCOUNT_DISABLED' : 'ACCOUNT_ENABLED', targetType: 'user', targetId: userId, details: { revokedSessions } } })
        return { user, revokedSessions }
      })
    },

    async revokeSessions({ userId, actorLabel, now }) {
      await ready()
      return prisma.$transaction(async (tx) => {
        const count = await revokeAll(tx, userId, 'REVOKED_BY_OPERATOR', now)
        await tx.auditEvent.create({ data: { actorLabel, action: 'SESSIONS_REVOKED', targetType: 'user', targetId: userId, details: { count } } })
        return count
      })
    },

    async findUsers({ email, userId }) {
      await ready()
      return prisma.user.findMany({ where: { ...(email ? { email: email.toLowerCase() } : {}), ...(userId ? { id: userId } : {}) }, select: USER_SELECT, orderBy: { createdAt: 'asc' } })
    },
  }
}
