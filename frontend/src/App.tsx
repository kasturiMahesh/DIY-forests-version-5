import { Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import WebinarPage from './pages/WebinarPage'

// Each page injects its own copy of the original stylesheet (see src/styles),
// because the two static pages define conflicting rules for .btn, .wrap, .brand, etc.
function App() {
  return (
    <Routes>
      <Route path="/monthly-webinar" element={<WebinarPage />} />
      <Route path="/monthly-webinar.html" element={<WebinarPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  )
}

export default App
