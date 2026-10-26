/**
 * Validate a post-login destination so sign-in can never be used as an open redirect.
 * Only same-site relative paths are accepted (e.g. "/account", "/admin?tab=x#y"); anything else
 * — absolute URLs, protocol-relative "//evil", backslashes, control characters, API paths —
 * falls back to `fallback`.
 */
export function safeReturnTo(value: unknown, publicOrigin: string, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback
  if ([...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return fallback // control characters
  let url: URL
  try {
    url = new URL(value, publicOrigin)
  } catch {
    return fallback
  }
  if (url.origin !== publicOrigin) return fallback
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return fallback
  return `${url.pathname}${url.search}${url.hash}`
}
