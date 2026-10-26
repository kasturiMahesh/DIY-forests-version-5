/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API origin (no secrets). Empty/unset = same origin, served by the Vite dev/preview proxy. */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
