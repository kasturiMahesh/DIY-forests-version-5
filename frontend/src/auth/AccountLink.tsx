import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { isAdminSession, useAuth } from './auth-context'

// Same pill as the header's Cart button (icon-toggle + the cart's inline sizing), so it reads as one family.
const pill = { width: 'auto', padding: '0 14px 0 12px', borderRadius: 22, gap: 6, textDecoration: 'none' } as const

const PersonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" width="19" height="19" aria-hidden="true" style={{ position: 'static' }}>
    <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
    <path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

/** Header control: "Sign in" (full-page redirect to the identity provider) or "Account"/"Admin". */
export function AccountLink() {
  const auth = useAuth()
  const label = (text: string) => <span className="account-link-label" style={{ fontSize: 14, fontWeight: 600 }}>{text}</span>

  if (auth.status === 'signed-in') {
    const admin = isAdminSession(auth)
    return (
      <Link className="icon-toggle account-link" to={admin ? '/admin' : '/account'} style={pill} aria-label={admin ? 'Admin dashboard' : 'Your account'}>
        <PersonIcon />{label(admin ? 'Admin' : 'Account')}
      </Link>
    )
  }
  return (
    <a className="icon-toggle account-link" href={api.signInUrl('/account')} style={pill} aria-label="Sign in" aria-busy={auth.status === 'loading' ? 'true' : undefined}>
      <PersonIcon />{label('Sign in')}
    </a>
  )
}
