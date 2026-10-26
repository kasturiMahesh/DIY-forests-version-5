import { useState, type FormEvent } from 'react'
import { ApiError, api } from '../api/client'
import { useAuth } from '../auth/auth-context'
import { MyBookings } from '../bookings/MyBookings'
import { SubPageLayout } from './SubPageLayout'

const formatExpiry = (iso: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

/** The signed-in person's own account. Data comes only from /auth/me and /me/profile. */
export default function AccountPage() {
  const auth = useAuth()
  const [name, setName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  if (auth.status === 'loading') {
    return <SubPageLayout title="Your account"><section className="auth-card" aria-busy="true"><h1>Your account</h1><p>Loading your account…</p></section></SubPageLayout>
  }
  if (auth.status === 'unavailable' || auth.status === 'error') {
    return (
      <SubPageLayout title="Your account">
        <section className="auth-card">
          <h1>Your account</h1>
          <p className="auth-message is-error" role="alert">{auth.status === 'unavailable' ? 'Sign-in isn’t available at the moment.' : 'We couldn’t reach the server.'}</p>
          <div className="auth-actions"><button className="btn" type="button" onClick={auth.refresh}>Try again</button></div>
        </section>
      </SubPageLayout>
    )
  }
  if (auth.status === 'signed-out' || !auth.me) {
    return (
      <SubPageLayout title="Your account">
        <section className="auth-card">
          <h1>Your account</h1>
          <p className={auth.expired ? 'auth-message is-error' : undefined} role={auth.expired ? 'alert' : undefined}>
            {auth.expired ? 'Your session has expired. Please sign in again.' : 'Please sign in to see your account.'}
          </p>
          <div className="auth-actions">
            <a className="btn" href={api.signInUrl('/account')}>Sign in</a>
            <a className="btn btn-quiet" href={api.registerUrl('/account')}>Create an account</a>
          </div>
        </section>
      </SubPageLayout>
    )
  }

  const { user, session, csrfToken } = auth.me
  const currentName = name ?? user.displayName ?? ''

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setNotice(null)
    try {
      await api.updateProfile(csrfToken, currentName.trim() === '' ? null : currentName.trim())
      setNotice({ kind: 'ok', text: 'Saved.' })
      auth.refresh()
      setName(null)
    } catch (error) {
      if (error instanceof ApiError && error.details.status === 401) return auth.sessionExpired()
      setNotice({ kind: 'error', text: error instanceof ApiError && error.details.status === 400 ? error.message : 'Couldn’t save your name. Please try again.' })
    } finally {
      setSaving(false)
    }
  }

  const signOut = async () => {
    setSigningOut(true)
    setNotice(null)
    try {
      await auth.signOut()
    } catch {
      setNotice({ kind: 'error', text: 'Couldn’t sign you out. Please try again.' })
      setSigningOut(false)
    }
  }

  return (
    <SubPageLayout title="Your account">
      <section className="auth-card" aria-labelledby="account-heading">
        <span className="auth-tag">{user.role === 'ADMIN' ? 'Staff account' : 'Customer account'}</span>
        <h1 id="account-heading">Hello{user.displayName ? `, ${user.displayName}` : ''}</h1>
        <dl className="auth-details">
          <dt>Email</dt><dd>{user.email}{user.emailVerified ? '' : ' (not verified)'}</dd>
          <dt>Signed in until</dt><dd>{formatExpiry(session.idleExpiresAt)} if inactive (at the latest {formatExpiry(session.absoluteExpiresAt)})</dd>
        </dl>
        <form className="auth-form" onSubmit={save}>
          <label>Display name
            <input name="displayName" value={currentName} maxLength={80} autoComplete="name" onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="auth-actions" style={{ marginTop: 4 }}>
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-quiet" type="button" onClick={signOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
          </div>
        </form>
        {notice ? <p className={`auth-message${notice.kind === 'error' ? ' is-error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
      </section>
      <section className="auth-card" aria-labelledby="bookings-heading">
        <h2 id="bookings-heading">Your bookings</h2>
        {user.role === 'CUSTOMER' && session.kind === 'CUSTOMER' ? (
          <>
            <p>Online payment isn’t available yet. New booking requests hold your seat while our team confirms them, and nothing is charged through this website. Our team aims to contact you by phone within 24 hours. Older bookings may still show as <strong>pending payment</strong>; nothing has been charged for them either.</p>
            <MyBookings csrfToken={csrfToken} />
          </>
        ) : <p>Staff accounts don’t make bookings. Customer bookings are in the admin area.</p>}
      </section>
    </SubPageLayout>
  )
}
