import { useMemo } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { api as defaultApi, type ApiClient } from '../api/client'
import { createAdminApi } from './admin-api'
import { BookingsPanel } from './BookingsPanel'
import { CohortsPanel } from './CohortsPanel'
import { OverviewPanel } from './OverviewPanel'
import { ProductsPanel } from './ProductsPanel'
import { SessionsPanel } from './SessionsPanel'

const TABS = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/products', label: 'Products' },
  { to: '/admin/webinars', label: 'Webinars' },
  { to: '/admin/workshops', label: 'Workshops' },
  { to: '/admin/training', label: 'Online training' },
  { to: '/admin/bookings', label: 'Bookings' },
]

/** Functional admin area (Stage 4B; bookings since Stage 4C). Rendered only after the server confirmed admin access. */
export function AdminDashboard({ csrfToken, client = defaultApi }: { csrfToken: string; client?: ApiClient }) {
  const api = useMemo(() => createAdminApi(client, csrfToken), [client, csrfToken])
  return (
    <>
      <nav className="admin-tabs" aria-label="Admin sections">
        {TABS.map((tab) => <NavLink key={tab.to} to={tab.to} end={tab.end ?? false} className={({ isActive }) => (isActive ? 'is-active' : undefined)}>{tab.label}</NavLink>)}
      </nav>
      <Routes>
        <Route index element={<OverviewPanel api={api} />} />
        <Route path="products" element={<ProductsPanel api={api} />} />
        <Route path="webinars" element={<SessionsPanel key="WEBINAR" api={api} kind="WEBINAR" />} />
        <Route path="workshops" element={<SessionsPanel key="OFFLINE_WORKSHOP" api={api} kind="OFFLINE_WORKSHOP" />} />
        <Route path="training" element={<CohortsPanel api={api} />} />
        <Route path="bookings" element={<BookingsPanel api={api} />} />
        <Route path="*" element={<OverviewPanel api={api} />} />
      </Routes>
    </>
  )
}
