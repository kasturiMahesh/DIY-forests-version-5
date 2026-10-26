import { describe, expect, it } from 'vitest'
import { normalizePhone, PHONE_COUNTRIES } from '../../src/modules/bookings/phone.js'

// Unit tests: pure functions, no database.

describe('normalizePhone', () => {
  it.each([
    ['IN', '98765 43210', { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }],
    ['IN', '098765-43210', { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }],
    ['IN', '+91 98765 43210', { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }],
    ['IN', '0091 9876543210', { country: 'IN', dialingCode: '91', national: '9876543210', e164: '+919876543210' }],
    ['IN', '011 2345 6789', { country: 'IN', dialingCode: '91', national: '1123456789', e164: '+911123456789' }],
    ['US', '(202) 555-0123', { country: 'US', dialingCode: '1', national: '2025550123', e164: '+12025550123' }],
    ['US', '1 202 555 0123', { country: 'US', dialingCode: '1', national: '2025550123', e164: '+12025550123' }],
    ['CA', '+1 416 555 0199', { country: 'CA', dialingCode: '1', national: '4165550199', e164: '+14165550199' }],
    ['GB', '07700 900123', { country: 'GB', dialingCode: '44', national: '7700900123', e164: '+447700900123' }],
    ['SG', '8123 4567', { country: 'SG', dialingCode: '65', national: '81234567', e164: '+6581234567' }],
    ['AE', '050 123 4567', { country: 'AE', dialingCode: '971', national: '501234567', e164: '+971501234567' }],
  ])('%s %s → normalized parts and E.164', (country, input, expected) => {
    expect(normalizePhone(country, input)).toEqual({ ok: true, phone: expected })
  })

  it.each([
    ['IN', '12345', 'too short'],
    ['IN', '98765432100', 'too long'],
    ['IN', '0123456789', 'nine digits after the trunk prefix'],
    ['IN', '+1 202 555 0123', 'dialing code of another country'],
    ['IN', '98765abc10', 'letters'],
    ['IN', '98765*43210', 'other symbols'],
    ['IN', '', 'empty'],
    ['IN', '+', 'only a plus'],
    ['US', '(102) 555-0123', 'invalid NANP area code'],
    ['US', '202 155 0123', 'invalid NANP exchange'],
    ['SG', '08123 4567', 'trunk prefix where none exists'],
    ['GB', '9'.repeat(25), 'absurdly long'],
  ])('%s "%s" is rejected (%s)', (country, input) => {
    expect(normalizePhone(country, input)).toMatchObject({ ok: false, code: 'PHONE_INVALID' })
  })

  it('rejects countries it has no numbering rules for instead of guessing', () => {
    expect(normalizePhone('BR', '11 91234 5678')).toMatchObject({ ok: false, code: 'PHONE_COUNTRY_UNSUPPORTED' })
    expect(normalizePhone('in', '9876543210')).toMatchObject({ ok: false, code: 'PHONE_COUNTRY_UNSUPPORTED' })
  })

  it('error messages never echo the submitted number', () => {
    const result = normalizePhone('IN', '55555')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain('55555')
  })

  it('every supported country produces numbers the database CHECK constraints accept', () => {
    // Mirrors bookings_phone_parts_format and bookings_phone_e164_consistent.
    for (const plan of PHONE_COUNTRIES) {
      expect(plan.country).toMatch(/^[A-Z]{2}$/)
      expect(plan.dialingCode).toMatch(/^[1-9][0-9]{0,3}$/)
    }
    const samples: [string, string][] = [['IN', '9876543210'], ['US', '2025550123'], ['GB', '7700900123'], ['AU', '412345678'], ['NZ', '211234567'], ['DE', '15123456789'], ['FR', '612345678'], ['NL', '612345678'], ['AM', '77123456']]
    for (const [country, number] of samples) {
      const result = normalizePhone(country, number)
      expect(result.ok, `${country} ${number}`).toBe(true)
      if (!result.ok) continue
      const { dialingCode, national, e164 } = result.phone
      expect(national).toMatch(/^[0-9]{4,14}$/)
      expect(e164).toBe(`+${dialingCode}${national}`)
      expect((dialingCode + national).length).toBeGreaterThanOrEqual(8)
      expect((dialingCode + national).length).toBeLessThanOrEqual(15)
    }
  })
})
