import { useState, type FormEvent } from 'react'
import { formatPrice } from '../api/format'
import type { AdminBooking, AdminBookingSummary, BookingStatus, CancellationRequest, ManualConfirmationReason } from '../api/types'
import { bookingStatusLabel, bookingWhen } from '../bookings/booking-display'
import type { AdminApi, AdminBookingView } from './admin-api'
import { useAction, useLoad } from './admin-hooks'
import { formatIst } from './admin-time'
import { ConfirmAction, LoadState, Notice, Pager } from './ui'

const statusBadge = (booking: AdminBookingSummary) =>
  booking.status === 'CANCELLED' ? { tone: 'cancelled', text: booking.cancellation?.by === 'SYSTEM' ? 'Expired' : 'Cancelled' }
    : booking.status === 'CONFIRMED' ? { tone: 'active', text: booking.confirmation?.method === 'MANUAL' ? 'Confirmed (manual)' : 'Confirmed (simulated)' }
      : booking.status === 'AWAITING_CONFIRMATION' ? { tone: 'draft', text: 'Awaiting confirmation' }
        : { tone: 'draft', text: 'Pending payment' }
const cancelledByWord = { ADMIN: 'admin', CUSTOMER: 'customer', SYSTEM: 'system (deadline passed)' } as const
const REASONS: { value: ManualConfirmationReason; label: string }[] = [
  { value: 'PAYMENT_ARRANGED_OFFLINE', label: 'Payment arranged offline' },
  { value: 'COMPLIMENTARY', label: 'Complimentary' },
  { value: 'OTHER', label: 'Other (explain)' },
]
const reasonLabel = (reason: ManualConfirmationReason) => REASONS.find((item) => item.value === reason)?.label ?? reason
const OUTCOME_LABEL = {
  NO_REFUND_SIMULATED_PAYMENT: 'Simulated payment — no real refund',
  NO_REFUND_COMPLIMENTARY: 'Complimentary — no refund',
  NOT_PROCESSED_BY_WEBSITE: 'Not processed by the website (any offline arrangement is handled by staff)',
} as const
/** Card, CVV or bank numbers must never be typed into notes (the server refuses 12+ digits in a row too). */
const hasLongNumber = (value: string) => /\d{12,}/.test(value.replace(/[\s-]/g, ''))

/** "5 h 20 min left" until an awaiting booking's confirmation deadline. */
function timeLeft(iso: string): string {
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'deadline passed'
  const minutes = Math.floor(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`
}

/**
 * Bookings. Everything shown comes from /admin/bookings. Phone numbers are fetched only when an admin
 * opens one booking (the list never includes them). Admins confirm booking requests manually (never a
 * payment record), decline them, and decide customers' cancellation requests. Simulated and manual
 * confirmations are never revenue; no refund is ever processed here.
 */
export function BookingsPanel({ api }: { api: AdminApi }) {
  const [filter, setFilter] = useState<{ status: '' | BookingStatus; view: '' | AdminBookingView; q: string; page: number }>({ status: '', view: '', q: '', page: 1 })
  const [search, setSearch] = useState('')
  const [load, reload] = useLoad((signal) => api.listBookings({
    ...(filter.status ? { status: filter.status } : {}), ...(filter.view ? { view: filter.view } : {}), ...(filter.q ? { q: filter.q } : {}), page: filter.page, pageSize: 20,
  }, signal), [api, filter])
  const [openId, setOpenId] = useState<string | null>(null)
  const action = useAction()

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    setFilter({ ...filter, q: search.trim().length >= 2 ? search.trim() : '', page: 1 })
  }

  return (
    <section aria-labelledby="bookings-heading">
      <div className="admin-toolbar">
        <h2 id="bookings-heading">Bookings</h2>
        <label>Show
          <select value={filter.view} onChange={(event) => setFilter({ ...filter, view: event.target.value as '' | AdminBookingView, page: 1 })}>
            <option value="">All bookings</option>
            <option value="AWAITING_CONFIRMATION">Awaiting confirmation</option>
            <option value="MANUALLY_CONFIRMED">Manually confirmed</option>
            <option value="SIMULATED_CONFIRMED">Simulated confirmed</option>
            <option value="CANCELLATION_REQUESTED">Cancellation requested</option>
          </select>
        </label>
        <label>Status
          <select value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as '' | BookingStatus, page: 1 })}>
            <option value="">All</option><option value="AWAITING_CONFIRMATION">Awaiting confirmation</option><option value="PENDING_PAYMENT">Pending payment</option>
            <option value="CONFIRMED">Confirmed</option><option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <form onSubmit={submitSearch} role="search">
          <label>Reference or email <input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></label>
          <button className="btn btn-quiet btn-small" type="submit">Search</button>
        </form>
      </div>
      <p className="admin-footnote">
        Online payment isn’t connected. New bookings are <strong>awaiting confirmation</strong> and hold one seat until you confirm or decline them,
        or until their deadline (48 hours after booking, or 24 hours before the start if sooner). Customers are told our team aims to phone them within 24 hours.
        Confirmed bookings (manual or simulated) are not revenue and can only be cancelled through a customer’s cancellation request.
      </p>
      <Notice notice={action.notice} />
      <LoadState load={load} retry={reload} empty={(data) => data.items.length === 0}>
        {(data) => (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th scope="col">Reference</th><th scope="col">Customer</th><th scope="col">Offering</th><th scope="col">Price</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {data.items.map((booking) => (
                    <tr key={booking.id}>
                      <td>{booking.reference}<br /><small>{formatIst(booking.createdAt)}</small></td>
                      <td>{booking.contactName}<br /><small>{booking.customer.email}</small></td>
                      <td>{booking.product.name}<br /><small>{bookingWhen(booking.target)}</small></td>
                      <td>{formatPrice(booking.price)}</td>
                      <td><span className={`admin-badge is-${statusBadge(booking).tone}`}>{statusBadge(booking).text}</span>
                        {booking.cancellation ? <><br /><small>by {cancelledByWord[booking.cancellation.by]}{booking.cancellation.reason ? `: ${booking.cancellation.reason}` : ''}</small></> : null}
                        {booking.status === 'PENDING_PAYMENT' && booking.payment?.dueAt ? <><br /><small>held until {formatIst(booking.payment.dueAt)}</small></> : null}
                        {booking.status === 'AWAITING_CONFIRMATION' && booking.confirmationDueAt ? <><br /><small>confirm by {formatIst(booking.confirmationDueAt)} ({timeLeft(booking.confirmationDueAt)})</small></> : null}
                        {booking.cancellationRequest?.status === 'PENDING' ? <><br /><small><strong>Cancellation requested</strong></small></> : null}
                      </td>
                      <td className="admin-actions">
                        <button className="btn btn-quiet btn-small" type="button" onClick={() => setOpenId(openId === booking.id ? null : booking.id)}>{openId === booking.id ? 'Hide' : booking.canConfirm || booking.cancellationRequest?.status === 'PENDING' ? 'Review' : 'Details'}</button>
                        {booking.canCancel ? (
                          <ConfirmAction label={booking.status === 'AWAITING_CONFIRMATION' ? 'Decline' : 'Cancel'} confirmLabel={`${booking.status === 'AWAITING_CONFIRMATION' ? 'Decline' : 'Cancel'} booking ${booking.reference}`} withReason="required" disabled={action.pending}
                            onConfirm={(reason) => action.run(() => api.cancelBooking(booking.id, reason ?? ''), `Booking ${booking.reference} ${booking.status === 'AWAITING_CONFIRMATION' ? 'declined' : 'cancelled'}; its seat is released.`).then(reload)} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {openId ? <BookingDetail key={openId} api={api} id={openId} onChanged={reload} /> : null}
            <Pager meta={data.meta} onPage={(page) => setFilter({ ...filter, page })} />
          </>
        )}
      </LoadState>
    </section>
  )
}

/** Manual confirmation: a fixed reason, an optional note (required for Other), and clear warnings. */
export function ManualConfirmForm({ disabled, onConfirm }: { disabled: boolean; onConfirm: (reason: ManualConfirmationReason, note: string | null) => Promise<unknown> }) {
  const [reason, setReason] = useState<ManualConfirmationReason | ''>('')
  const [note, setNote] = useState('')
  const trimmed = note.trim()
  const problem = !reason ? 'Choose a reason.'
    : reason === 'OTHER' && trimmed.length < 3 ? 'Explain the reason (at least 3 characters).'
      : hasLongNumber(trimmed) ? 'Remove the long number: never enter card, CVV or bank details.'
        : null
  return (
    <form className="admin-form" aria-label="Confirm booking manually" onSubmit={(event) => { event.preventDefault(); if (!problem && reason) void onConfirm(reason, trimmed || null) }}>
      <p className="auth-message is-error" role="note"><strong>Payment arranged offline is not proof of payment.</strong> Confirming records your decision only; it does not record that any money was received.</p>
      <label>Reason
        <select value={reason} required onChange={(event) => setReason(event.target.value as ManualConfirmationReason | '')}>
          <option value="">Choose…</option>
          {REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <label>Note {reason === 'OTHER' ? '(required)' : '(optional)'}
        <textarea value={note} maxLength={500} rows={2} onChange={(event) => setNote(event.target.value)} />
      </label>
      <small>Never enter card numbers, CVVs or bank details in this note.</small>
      {problem && (reason || note) ? <small role="alert">{problem}</small> : null}
      <button className="btn btn-small" type="submit" disabled={disabled || problem !== null}>Confirm booking</button>
    </form>
  )
}

function RequestPanel({ request, disabled, onDecide }: { request: CancellationRequest; disabled: boolean; onDecide: (decision: 'approve' | 'reject', reason: string) => Promise<unknown> }) {
  return (
    <div aria-label="Cancellation request">
      <p>
        Requested {formatIst(request.requestedAt)} · eligibility {request.refundPercent}% ({request.refundPolicy === 'WEBINAR_V1' ? 'webinar policy' : 'training policy'}, fixed when requested)
        {request.customerReason ? <><br /><small>Customer’s reason: {request.customerReason}</small></> : null}
      </p>
      {request.status === 'PENDING' ? (
        <>
          <p className="admin-footnote">Approving cancels the booking and releases its seat. The website records eligibility only: it takes no payment and makes no refund.</p>
          <span className="admin-actions">
            <ConfirmAction label="Approve cancellation" confirmLabel="Approve cancellation request" withReason="required" disabled={disabled} onConfirm={(reason) => onDecide('approve', reason ?? '')} />
            <ConfirmAction label="Reject" confirmLabel="Reject cancellation request" withReason="required" disabled={disabled} onConfirm={(reason) => onDecide('reject', reason ?? '')} />
          </span>
        </>
      ) : (
        <p>
          {request.status === 'APPROVED' ? 'Approved' : 'Rejected'} {request.decidedAt ? formatIst(request.decidedAt) : ''}{request.decisionReason ? `: ${request.decisionReason}` : ''}
          {request.refundOutcome ? <><br /><small>Outcome: {OUTCOME_LABEL[request.refundOutcome]}</small></> : null}
        </p>
      )}
    </div>
  )
}

function BookingDetail({ api, id, onChanged }: { api: AdminApi; id: string; onChanged: () => void }) {
  const [load, retry] = useLoad((signal) => api.getBooking(id, signal), [api, id])
  const action = useAction()
  const after = (ok: boolean) => { if (ok) { retry(); onChanged() } }
  return (
    <LoadState load={load} retry={retry}>
      {(booking: AdminBooking) => (
        <div className="admin-tile is-live" aria-label={`Booking ${booking.reference}`}>
          <h3>{booking.reference} · {booking.product.name}</h3>
          <p>{bookingWhen(booking.target)}</p>
          <p>{bookingStatusLabel(booking)} · {formatPrice(booking.price)} (price when booked)</p>
          <p>Contact: {booking.contact.name} · <a href={`tel:${booking.contact.phone.e164}`}>{booking.contact.phone.e164}</a> · {booking.customer.email}</p>
          {booking.status === 'AWAITING_CONFIRMATION' && booking.confirmationDueAt ? <p>Confirmation deadline: {formatIst(booking.confirmationDueAt)} ({timeLeft(booking.confirmationDueAt)})</p> : null}
          {booking.payment?.dueAt ? <p>Payment deadline: {formatIst(booking.payment.dueAt)}</p> : null}
          {booking.status === 'PENDING_PAYMENT' && !booking.payment?.dueAt ? <p>No deadline (booked before booking holds existed).</p> : null}
          {booking.manualConfirmation ? (
            <p>Confirmed manually {booking.confirmation ? formatIst(booking.confirmation.at) : ''} by {booking.manualConfirmation.by?.displayName ?? booking.manualConfirmation.by?.email ?? 'an administrator'}: {reasonLabel(booking.manualConfirmation.reason)}
              {booking.manualConfirmation.note ? <><br /><small>Note: {booking.manualConfirmation.note}</small></> : null}
              <br /><small>Not proof of payment; not revenue.</small>
            </p>
          ) : null}
          <Notice notice={action.notice} />
          {booking.canConfirm ? (
            <ManualConfirmForm disabled={action.pending} onConfirm={(reason, note) => action.run(() => api.confirmBooking(booking.id, reason, note), `Booking ${booking.reference} confirmed manually.`).then(after)} />
          ) : null}
          {booking.cancellationRequests?.length ? (
            <>
              <h4>Cancellation requests</h4>
              {booking.cancellationRequests.map((request) => (
                <RequestPanel key={request.id} request={request} disabled={action.pending}
                  onDecide={(decision, reason) => action.run(() => (decision === 'approve' ? api.approveCancellation(booking.id, reason) : api.rejectCancellation(booking.id, reason)),
                    decision === 'approve' ? `Cancellation approved: booking ${booking.reference} is cancelled and its seat released.` : `Cancellation request for ${booking.reference} rejected; the booking stays confirmed.`).then(after)} />
              ))}
            </>
          ) : null}
          <h4>Payment attempts (read-only)</h4>
          {booking.payment?.attempts.length ? (
            <table className="admin-table">
              <thead><tr><th scope="col">Started</th><th scope="col">Status</th><th scope="col">Amount</th><th scope="col">Provider</th><th scope="col">Note</th></tr></thead>
              <tbody>
                {booking.payment.attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <td>{formatIst(attempt.createdAt)}</td>
                    <td>{attempt.status}</td>
                    <td>{formatPrice(attempt.amount)}</td>
                    <td>{attempt.simulated ? 'Development simulator — not real money' : attempt.provider}</td>
                    <td>{attempt.failureReason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="admin-empty">No payment attempts.</p>}
        </div>
      )}
    </LoadState>
  )
}
