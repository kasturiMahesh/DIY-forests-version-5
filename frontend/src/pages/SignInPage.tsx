import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { SubPageLayout } from './SubPageLayout'

// Codes come from the backend's sign-in redirects; anything unknown gets a generic message.
const MESSAGES: Record<string, string> = {
  auth_unavailable: 'Sign-in isn’t available at the moment. Please try again later.',
  provider_unavailable: 'We couldn’t reach the sign-in service. Please try again in a moment.',
  service_unavailable: 'Something went wrong on our side while signing you in. Please try again.',
  login_expired: 'Your sign-in took too long or was started in another tab. Please start again.',
  invalid_state: 'We couldn’t verify that sign-in attempt. Please start again.',
  invalid_response: 'We couldn’t verify that sign-in attempt. Please start again.',
  cancelled: 'Sign-in was cancelled.',
  email_unverified: 'Please verify your email address first, then sign in again.',
  account_disabled: 'This account has been disabled. Please contact us if you think this is a mistake.',
  not_authorized: 'This staff account hasn’t been given access to the admin area.',
}

export default function SignInPage() {
  const [params] = useSearchParams()
  const error = params.get('error')
  const staff = params.get('pool') === 'admin'
  const message = error ? (MESSAGES[error] ?? 'Sign-in didn’t complete. Please try again.') : null

  return (
    <SubPageLayout title={staff ? 'Staff sign-in' : 'Sign in'}>
      <section className="auth-card" aria-labelledby="sign-in-heading">
        <span className="auth-tag">{staff ? 'Staff' : 'Your DIY Forests account'}</span>
        <h1 id="sign-in-heading">{staff ? 'Staff sign-in' : 'Sign in'}</h1>
        {message ? <p className="auth-message is-error" role="alert">{message}</p> : <p>Sign in to see your account. New here? Create an account in a minute.</p>}
        <div className="auth-actions">
          {staff ? (
            <a className="btn" href={api.adminSignInUrl('/admin')}>Staff sign-in</a>
          ) : (
            <>
              <a className="btn" href={api.signInUrl('/account')}>Sign in</a>
              <a className="btn btn-quiet" href={api.registerUrl('/account')}>Create an account</a>
            </>
          )}
        </div>
        <p className="auth-message" style={{ fontWeight: 400 }}>
          {staff ? <Link to="/sign-in">Customer sign-in</Link> : <Link to="/admin">Staff sign-in</Link>}
        </p>
      </section>
    </SubPageLayout>
  )
}
