// Server-side phone validation and normalization for booking contacts.
//
// No phone-number library is installed in this project, so instead of guessing at every numbering plan
// this module supports an explicit list of countries with conservative national-number rules, and
// rejects any other country. Unsupported or malformed numbers are never stored "as typed".
// To support another country, add it here (and to the checkout's country list in the frontend).

export type PhoneCountry = {
  /** ISO 3166-1 alpha-2. */
  country: string
  /** ITU dialing code without "+". */
  dialingCode: string
  /** National significant number (no trunk prefix). */
  national: RegExp
  /** Domestic trunk prefix that people often type before the national number ("0" in India and the UK). */
  trunkPrefix?: string
}

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  // India: 10-digit national numbers (mobiles start 6-9; landlines are area code + subscriber, e.g. Delhi 11).
  { country: 'IN', dialingCode: '91', national: /^[1-9]\d{9}$/, trunkPrefix: '0' },
  // North American Numbering Plan: NXX-NXX-XXXX. The number alone cannot tell US from CA.
  { country: 'US', dialingCode: '1', national: /^[2-9]\d{2}[2-9]\d{6}$/, trunkPrefix: '1' },
  { country: 'CA', dialingCode: '1', national: /^[2-9]\d{2}[2-9]\d{6}$/, trunkPrefix: '1' },
  { country: 'GB', dialingCode: '44', national: /^[1-9]\d{8,9}$/, trunkPrefix: '0' },
  { country: 'AU', dialingCode: '61', national: /^[2-478]\d{8}$/, trunkPrefix: '0' },
  { country: 'NZ', dialingCode: '64', national: /^[2-9]\d{7,9}$/, trunkPrefix: '0' },
  { country: 'AE', dialingCode: '971', national: /^(?:5\d{8}|[2-9]\d{7})$/, trunkPrefix: '0' },
  { country: 'SG', dialingCode: '65', national: /^[3689]\d{7}$/ },
  { country: 'DE', dialingCode: '49', national: /^[1-9]\d{6,13}$/, trunkPrefix: '0' },
  { country: 'FR', dialingCode: '33', national: /^[1-9]\d{8}$/, trunkPrefix: '0' },
  { country: 'NL', dialingCode: '31', national: /^[1-9]\d{8}$/, trunkPrefix: '0' },
  { country: 'AM', dialingCode: '374', national: /^[1-9]\d{7}$/, trunkPrefix: '0' },
]

const BY_COUNTRY = new Map(PHONE_COUNTRIES.map((entry) => [entry.country, entry]))

export type NormalizedPhone = { country: string; dialingCode: string; national: string; e164: string }

export type PhoneResult =
  | { ok: true; phone: NormalizedPhone }
  | { ok: false; code: 'PHONE_COUNTRY_UNSUPPORTED' | 'PHONE_INVALID'; message: string }

// Separators people type between digit groups. Anything else (letters, "ext", "*", "#") is rejected.
const SEPARATORS = /[\s().\- ]/g

/**
 * Validates `number` for `country` and returns the parts and the E.164 form. Accepts the national
 * number with or without its trunk prefix, or the full international form (+CC… or 00CC…) as long as
 * the dialing code matches the chosen country.
 */
export function normalizePhone(country: string, number: string): PhoneResult {
  const plan = BY_COUNTRY.get(country)
  if (!plan) return { ok: false, code: 'PHONE_COUNTRY_UNSUPPORTED', message: 'Phone numbers from this country are not supported yet. Please contact us to book.' }
  const invalid = { ok: false as const, code: 'PHONE_INVALID' as const, message: `Enter a valid phone number for the selected country (+${plan.dialingCode}).` }

  const compact = number.trim().replace(SEPARATORS, '')
  if (compact.length === 0 || compact.length > 20) return invalid
  let digits: string
  if (compact.startsWith('+') || compact.startsWith('00')) {
    const international = compact.startsWith('+') ? compact.slice(1) : compact.slice(2)
    if (!/^\d+$/.test(international) || !international.startsWith(plan.dialingCode)) return invalid
    digits = international.slice(plan.dialingCode.length)
  } else {
    if (!/^\d+$/.test(compact)) return invalid
    digits = compact
  }
  // A domestic trunk prefix ("0…", or "1…" in North America) is dropped only when what remains is valid.
  if (!plan.national.test(digits) && plan.trunkPrefix && digits.startsWith(plan.trunkPrefix) && plan.national.test(digits.slice(plan.trunkPrefix.length))) {
    digits = digits.slice(plan.trunkPrefix.length)
  }
  if (!plan.national.test(digits)) return invalid
  const e164 = `+${plan.dialingCode}${digits}`
  // Same limits as the bookings_phone_* CHECK constraints (E.164 allows at most 15 digits).
  if (e164.length - 1 > 15 || e164.length - 1 < 8) return invalid
  return { ok: true, phone: { country: plan.country, dialingCode: plan.dialingCode, national: digits, e164 } }
}
