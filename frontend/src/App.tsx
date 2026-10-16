import { Route, Routes } from 'react-router-dom'
import { CatalogProvider } from './catalog/CatalogContext'
import HomePage from './pages/HomePage'
import WebinarPage from './pages/WebinarPage'

// Each page injects its own copy of the original stylesheet (see src/styles),
// because the two static pages define conflicting rules for .btn, .wrap, .brand, etc.
// CatalogProvider loads prices and the next published webinar from the API once for both pages.
function App() {
  return (
    <CatalogProvider>
      <Routes>
        <Route path="/monthly-webinar" element={<WebinarPage />} />
        <Route path="/monthly-webinar.html" element={<WebinarPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </CatalogProvider>
  )
}

export default App
