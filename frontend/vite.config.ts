import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Local development only: forward /api to the backend so the browser sees one origin
// (no CORS setup needed). Production builds call VITE_API_BASE_URL instead; see README.md.
const apiProxy = { '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000' } }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
})
