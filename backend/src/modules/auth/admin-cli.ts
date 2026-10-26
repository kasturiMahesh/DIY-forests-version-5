import { parseArgs } from 'node:util'
import type { AuthConfig } from '../../config/auth.js'
import type { AccountAdministration, AccountUser } from './auth.repository.js'
import { DEV_IDENTITIES, DEV_ISSUERS } from './dev-provider.js'

export const ADMIN_CLI_USAGE = `Operator commands (not available over HTTP):

  grant --subject <sub> --email <email> [--name <display name>]
      Provision an administrator from the ADMIN identity pool. <sub> is the user's "sub" (User ID)
      in the admin Cognito user pool. In AUTH_MODE=dev use: grant --dev-identity dev-admin-1
  disable --user-id <id>          Disable an account and revoke all of its sessions immediately.
  enable --user-id <id>           Re-enable a disabled account.
  revoke-sessions --user-id <id>  Sign an account out everywhere.
  find --email <email>            List accounts with that email (both pools).`

export class CliUsageError extends Error {
  override name = 'CliUsageError'
}

const describe = (user: AccountUser) => `${user.id}  pool=${user.identityPool}  role=${user.role}  status=${user.status}  email=${user.email}`

/** Runs one operator command. Every change writes an audit event (actor: `actorLabel`). */
export async function runAdminCommand(
  argv: string[],
  { repository, authConfig, actorLabel, now = () => new Date(), print = console.log }: {
    repository: AccountAdministration
    authConfig: AuthConfig
    actorLabel: string
    now?: () => Date
    print?: (line: string) => void
  },
): Promise<void> {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: { subject: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, 'user-id': { type: 'string' }, 'dev-identity': { type: 'string' } },
    strict: true,
  })
  const userId = () => {
    const id = values['user-id']
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new CliUsageError('--user-id <uuid> is required (find it with: find --email <email>)')
    return id
  }

  switch (command) {
    case 'grant': {
      let issuer: string
      let subject = values.subject
      let email = values.email
      let name = values.name ?? null
      if (values['dev-identity']) {
        if (authConfig.mode !== 'dev') throw new CliUsageError('--dev-identity only works with AUTH_MODE=dev')
        const identity = DEV_IDENTITIES.ADMIN.find((candidate) => candidate.subject === values['dev-identity'])
        if (!identity) throw new CliUsageError(`Unknown dev admin identity; choose one of: ${DEV_IDENTITIES.ADMIN.map((i) => i.subject).join(', ')}`)
        issuer = DEV_ISSUERS.ADMIN
        subject = identity.subject
        email = identity.email
        name ??= identity.name
      } else if (authConfig.mode === 'cognito' && authConfig.oidc) {
        issuer = authConfig.oidc.ADMIN.issuer
      } else {
        throw new CliUsageError('Configure the admin identity pool first (AUTH_MODE=cognito with COGNITO_ADMIN_ISSUER, or AUTH_MODE=dev)')
      }
      if (!subject || !email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new CliUsageError('grant needs --subject <sub> and a valid --email <email>')
      const { user, created } = await repository.grantAdmin({ issuer, subject, email, displayName: name, actorLabel })
      print(`${created ? 'Provisioned' : 'Confirmed'} admin: ${describe(user)}`)
      if (user.status !== 'ACTIVE') print('Note: this account is DISABLED; run "enable --user-id …" to allow sign-in.')
      return
    }
    case 'disable':
    case 'enable': {
      const { user, revokedSessions } = await repository.setStatus({ userId: userId(), status: command === 'disable' ? 'DISABLED' : 'ACTIVE', actorLabel, now: now() })
      print(`${command === 'disable' ? 'Disabled' : 'Enabled'}: ${describe(user)}${command === 'disable' ? `  (revoked ${revokedSessions} session(s))` : ''}`)
      return
    }
    case 'revoke-sessions': {
      const count = await repository.revokeSessions({ userId: userId(), actorLabel, now: now() })
      print(`Revoked ${count} session(s).`)
      return
    }
    case 'find': {
      if (!values.email) throw new CliUsageError('find needs --email <email>')
      const users = await repository.findUsers({ email: values.email })
      print(users.length ? users.map(describe).join('\n') : 'No accounts with that email.')
      return
    }
    default:
      throw new CliUsageError(ADMIN_CLI_USAGE)
  }
}
