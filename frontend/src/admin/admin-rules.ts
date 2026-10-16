// Client-side validation that mirrors the server's rules (the server re-validates everything).
import type { ProductType } from '../api/types'
import { addDaysToIstLocal, istLocalToInstant, istLocalWeekday } from './admin-time'

export const TYPE_LABEL: Record<ProductType, string> = { ONLINE_TRAINING: 'Online training', OFFLINE_WORKSHOP: 'Offline workshop', WEBINAR: 'Webinar' }
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/

export type ProductDraft = { slug: string; name: string; type: ProductType; summary: string; description: string; audience: string; durationLabel: string; amount: string; currency: string }
/** Same rules as the server, so most mistakes are caught before sending. The server still decides. */
export function validateProductDraft(draft: ProductDraft): string | null {
  if (!SLUG.test(draft.slug)) return 'Slug: lower-case words joined by hyphens, e.g. "weekend-workshop".'
  if (!draft.name.trim()) return 'Name must not be blank.'
  if (!AMOUNT.test(draft.amount.trim())) return 'Price: a non-negative amount like 149 or 1000.50 (at most 2 decimals).'
  if (!/^[A-Z]{3}$/.test(draft.currency.trim())) return 'Currency: a 3-letter code such as INR or USD.'
  return null
}


export type SessionKind = 'WEBINAR' | 'OFFLINE_WORKSHOP'
export type SessionDraft = { productId: string; start: string; end: string; venue: string; capacity: string; internalNote: string }

/** Client-side checks mirroring the server (the server re-validates everything). */
export function validateSessionDraft(kind: SessionKind, draft: SessionDraft): string | null {
  if (!draft.productId) return 'Choose a product.'
  const start = istLocalToInstant(draft.start)
  if (!start) return 'Enter a valid start date and time.'
  if (new Date(start).getTime() <= Date.now()) return 'The start must be in the future.'
  const end = draft.end ? istLocalToInstant(draft.end) : null
  if (draft.end && !end) return 'Enter a valid end date and time.'
  if (end && new Date(end).getTime() <= new Date(start).getTime()) return 'The end must be after the start.'
  if (kind === 'OFFLINE_WORKSHOP' && !end) return 'A workshop batch needs an end date and time.'
  if (kind === 'OFFLINE_WORKSHOP' && !draft.venue.trim()) return 'A workshop batch needs a venue or location.'
  if (draft.capacity && !/^[1-9]\d{0,5}$/.test(draft.capacity)) return 'Capacity must be a whole number of at least 1 (or empty).'
  return null
}


const SESSION_HOURS = 4

export type CohortPlan = { first: { start: string; end: string }; second: { start: string; end: string } }

/**
 * Builds the two-Friday schedule from the first session's date and time (IST), applying the confirmed
 * rule: two 4-hour sessions on consecutive Fridays. Returns an error message or the plan (as instants).
 */
export function planCohort(date: string, time: string): CohortPlan | string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return 'Choose the first Friday and a start time.'
  const firstLocal = `${date}T${time}`
  const start = istLocalToInstant(firstLocal)
  if (!start) return 'Enter a valid date and time.'
  if (istLocalWeekday(firstLocal) !== 5) return 'The first session must be on a Friday.'
  if (new Date(start).getTime() <= Date.now()) return 'The first session must be in the future.'
  const secondLocal = addDaysToIstLocal(firstLocal, 7)!
  const second = istLocalToInstant(secondLocal)!
  const plusHours = (iso: string) => new Date(new Date(iso).getTime() + SESSION_HOURS * 3_600_000).toISOString()
  return { first: { start, end: plusHours(start) }, second: { start: second, end: plusHours(second) } }
}

