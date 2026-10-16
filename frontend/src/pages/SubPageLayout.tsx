import { useEffect, type ReactNode } from 'react'
import authCss from '../styles/auth.css?inline'
import webinarCss from '../styles/webinar.css?inline'

/** Header and footer shared by the sign-in, account and admin pages (same as the webinar page). */
export function SubPageLayout({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} — DIY Forests` }, [title])
  return (
    <>
      <style>{webinarCss}</style>
      <style>{authCss}</style>
      <header className="site-header">
        <div className="wrap header-inner">
          <a className="brand" href="/#top" aria-label="DIY Forests home">
            <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="var(--forest)" /><path d="M20 30V19M20 19C15 19 12 15 12 10C17 10 20 13 20 17C20 13 23 10 28 10C28 15 25 19 20 19Z" stroke="var(--on-forest)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></svg>
            <span>DIY Forests</span>
          </a>
          <a className="btn header-return" href="/#top" aria-label="Back to the main DIY Forests website">Back to Main Website</a>
        </div>
      </header>
      <main className="auth-main"><div className="wrap">{children}</div></main>
      <footer className="site-footer">
        <div className="wrap footer-inner">
          <span>DIY Forests · Learn to grow a native forest</span>
          <a href="/">Return to DIY Forests</a>
        </div>
      </footer>
    </>
  )
}
