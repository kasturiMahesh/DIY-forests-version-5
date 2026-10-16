import { useEffect, useState } from 'react'
import { ApiError, api } from '../api/client'
import type { AdminMeResponse } from '../api/types'
import { useAuth, type AuthState } from '../auth/auth-context'
import { SubPageLayout } from './SubPageLayout'

export type AdminCheck = { state: 'checking' } | { state: 'ok'; data: AdminMeResponse } | { state: 'forbidden' } | { state: 'error' }

// Management areas arrive in later, separately approved stages. Nothing here shows invented data.
const UPCOMING = [
  { title: 'Products & prices', note: 'Edit products, prices and availability. (Stage 4B)' },
  { title: 'Schedule', note: 'Create, publish, reschedule and cancel webinars, workshop batches and training dates. (Stage 4B)' },
  { title: 'Bookings', note: 'Search and manage bookings and capacity. (Stage 4C)' },
  { title: 'Customers', note: 'Look up customers and their booking history. (Stage 4C)' },
]

/**
 * Admin dashboard shell. The page asks the server (GET /admin/me) before showing anything; the
 * client-side session info is never treated as proof of admin rights.
 */
export default function AdminPage() {
  const auth = useAuth()
  const [check, setCheck] = useState<AdminCheck>({ state: 'checking' })
  const signedIn = auth.status === 'signed-in'
  const { sessionExpired } = auth

  useEffect(() => {
    if (!signedIn) return
    const controller = new AbortController()
    api.getAdminMe(controller.signal).then(
      (data) => setCheck({ state: 'ok', data }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.details.status === 401) return sessionExpired()
        setCheck(error instanceof ApiError && error.details.status === 403 ? { state: 'forbidden' } : { state: 'error' })
      },
    )
    return () => controller.abort()
  }, [signedIn, sessionExpired])

  return <AdminView auth={auth} check={check} />
}

/** Pure view for every state (rendered directly in tests). */
export function AdminView({ auth, check }: { auth: AuthState; check: AdminCheck }) {
  const signedIn = auth.status === 'signed-in'
  const staffSignIn = <a className="btn" href={api.adminSignInUrl('/admin')}>Staff sign-in</a>

  if (auth.status === 'loading' || (signedIn && check.state === 'checking')) {
    return <SubPageLayout title="Admin"><section className="auth-card" aria-busy="true"><h1>Admin</h1><p>Checking access…</p></section></SubPageLayout>
  }
  if (auth.status === 'unavailable' || auth.status === 'error' || check.state === 'error') {
    return (
      <SubPageLayout title="Admin">
        <section className="auth-card">
          <h1>Admin</h1>
          <p className="auth-message is-error" role="alert">{auth.status === 'unavailable' ? 'Sign-in isn’t available at the moment.' : 'We couldn’t reach the server.'}</p>
          <div className="auth-actions"><button className="btn" type="button" onClick={auth.refresh}>Try again</button></div>
        </section>
      </SubPageLayout>
    )
  }
  if (!signedIn) {
    return (
      <SubPageLayout title="Admin">
        <section className="auth-card">
          <span className="auth-tag">Staff</span>
          <h1>Admin</h1>
          <p className={auth.expired ? 'auth-message is-error' : undefined} role={auth.expired ? 'alert' : undefined}>
            {auth.expired ? 'Your session has expired. Please sign in again.' : 'This area is for DIY Forests staff. Sign in with your staff account.'}
          </p>
          <div className="auth-actions">{staffSignIn}</div>
        </section>
      </SubPageLayout>
    )
  }
  if (check.state === 'forbidden') {
    return (
      <SubPageLayout title="Admin">
        <section className="auth-card">
          <h1>Admin</h1>
          <p className="auth-message is-error" role="alert">You’re signed in, but this account doesn’t have access to the admin area.</p>
          <p>Customer accounts can’t be used here. Staff should sign in with their staff account.</p>
          <div className="auth-actions">{staffSignIn}<button className="btn btn-quiet" type="button" onClick={() => void auth.signOut()}>Sign out</button></div>
        </section>
      </SubPageLayout>
    )
  }

  if (check.state !== 'ok') return null
  const { user, session } = check.data
  return (
    <SubPageLayout title="Admin">
      <section className="auth-card" style={{ maxWidth: 'none' }} aria-labelledby="admin-heading">
        <span className="auth-tag">Admin dashboard</span>
        <h1 id="admin-heading">Welcome{user.displayName ? `, ${user.displayName}` : ''}</h1>
        <p>Signed in as {user.email}. Admin sessions end after 1 hour of inactivity (at the latest {new Date(session.absoluteExpiresAt).toLocaleString()}).</p>
        <div className="admin-grid">
          {UPCOMING.map((tile) => (
            <div className="admin-tile" key={tile.title}><h3>{tile.title}</h3><p>Not available yet. {tile.note}</p></div>
          ))}
        </div>
        <div className="auth-actions"><button className="btn btn-quiet" type="button" onClick={() => void auth.signOut()}>Sign out</button></div>
      </section>
    </SubPageLayout>
  )
}
