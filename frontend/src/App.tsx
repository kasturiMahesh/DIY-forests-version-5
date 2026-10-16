import { Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { CatalogProvider } from './catalog/CatalogContext'
import AccountPage from './pages/AccountPage'
import AdminPage from './pages/AdminPage'
import HomePage from './pages/HomePage'
import SignInPage from './pages/SignInPage'
import WebinarPage from './pages/WebinarPage'

// Each page injects its own copy of the original stylesheet (see src/styles),
// because the two static pages define conflicting rules for .btn, .wrap, .brand, etc.
// CatalogProvider loads prices and the next published webinar from the API once for both pages.
// AuthProvider loads the signed-in state (GET /auth/me) once; admin access is always re-checked by the server.
function App() {
  return (
    <AuthProvider>
      <CatalogProvider>
        <Routes>
          <Route path="/monthly-webinar" element={<WebinarPage />} />
          <Route path="/monthly-webinar.html" element={<WebinarPage />} />
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </CatalogProvider>
    </AuthProvider>
  )
}

export default App
