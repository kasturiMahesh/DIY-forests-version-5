import { useState, type FormEvent } from 'react'
import type { AdminSession, ScheduleStatus } from '../api/types'
import type { AdminApi, SessionForm } from './admin-api'
import { useAction, useLoad } from './admin-hooks'
import { validateSessionDraft, type SessionDraft, type SessionKind } from './admin-rules'
import { formatIst, instantToIstLocal, istLocalToInstant } from './admin-time'
import { ConfirmAction, LoadState, Notice, Pager, StatusBadge } from './ui'

type Kind = SessionKind
const COPY: Record<Kind, { title: string; item: string; plural: string }> = {
  WEBINAR: { title: 'Webinars', item: 'webinar', plural: 'webinars' },
  OFFLINE_WORKSHOP: { title: 'Offline workshop batches', item: 'batch', plural: 'batches' },
}

type Draft = SessionDraft

export function SessionsPanel({ api, kind }: { api: AdminApi; kind: Kind }) {
  const copy = COPY[kind]
  const [filter, setFilter] = useState<{ status: '' | ScheduleStatus; page: number }>({ status: '', page: 1 })
  const [load, reload] = useLoad((signal) => api.listSessions({ type: kind, ...(filter.status ? { status: filter.status } : {}), page: filter.page, pageSize: 20 }, signal), [api, kind, filter])
  const [products] = useLoad((signal) => api.listProducts({ type: kind, pageSize: 100 }, signal), [api, kind])
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; session: AdminSession } | null>(null)
  const action = useAction()

  return (
    <section aria-labelledby={`${kind}-heading`}>
      <div className="admin-toolbar">
        <h2 id={`${kind}-heading`}>{copy.title}</h2>
        <label>Status
          <select value={filter.status} onChange={(event) => setFilter({ status: event.target.value as '' | ScheduleStatus, page: 1 })}>
            <option value="">All</option><option value="DRAFT">Draft</option><option value="PUBLISHED">Published</option><option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <button className="btn btn-small" type="button" onClick={() => setEditing({ mode: 'create' })}>New {copy.item}</button>
      </div>
      <p className="admin-footnote">Times are entered and shown in organizer time (IST). Visitors see them in their own time zone. Only published, upcoming {copy.plural} of active products appear on the website.</p>
      <Notice notice={action.notice} />
      {editing ? (
        <SessionEditor
          api={api} kind={kind} products={products.state === 'ready' ? products.data.items : []}
          session={editing.mode === 'edit' ? editing.session : null}
          onDone={(message) => { setEditing(null); action.setNotice({ kind: 'ok', text: message }); reload() }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      <LoadState load={load} retry={reload} empty={(data) => data.items.length === 0}>
        {(data) => (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th scope="col">When (IST)</th><th scope="col">Product</th>{kind === 'OFFLINE_WORKSHOP' ? <th scope="col">Venue</th> : null}<th scope="col">Booked / capacity</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {data.items.map((session) => (
                    <tr key={session.id}>
                      <td>{formatIst(session.startsAt)}{session.endsAt ? <><br /><small>until {formatIst(session.endsAt)}</small></> : null}</td>
                      <td>{session.product.name}{session.product.isActive ? null : <><br /><small>product inactive</small></>}</td>
                      {kind === 'OFFLINE_WORKSHOP' ? <td>{session.venue ?? '—'}</td> : null}
                      <td>{session.seatsHeld} / {session.capacity ?? 'no limit'}</td>
                      <td><StatusBadge status={session.status} /></td>
                      <td className="admin-actions">
                        {session.status !== 'CANCELLED' ? <button className="btn btn-quiet btn-small" type="button" onClick={() => setEditing({ mode: 'edit', session })}>{session.status === 'PUBLISHED' ? 'Edit / reschedule' : 'Edit'}</button> : null}
                        {session.status === 'DRAFT' ? (
                          <button className="btn btn-small" type="button" disabled={action.pending}
                            onClick={() => void action.run(() => api.publishSession(session.id), `Published: it now appears on the website.`).then(reload)}>Publish</button>
                        ) : null}
                        {session.status !== 'CANCELLED' ? (
                          <ConfirmAction label="Cancel" confirmLabel={`Cancel this ${copy.item}`} withReason disabled={action.pending}
                            onConfirm={(reason) => action.run(() => api.cancelSession(session.id, reason), `Cancelled: hidden from the website and kept for the record.`).then(reload)} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager meta={data.meta} onPage={(page) => setFilter({ ...filter, page })} />
          </>
        )}
      </LoadState>
    </section>
  )
}

export function SessionEditor({ api, kind, products, session, onDone, onCancel }: {
  api: AdminApi; kind: Kind; products: { id: string; name: string; isActive: boolean }[]; session: AdminSession | null; onDone: (message: string) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<Draft>(session ? {
    productId: session.product.id, start: instantToIstLocal(session.startsAt), end: session.endsAt ? instantToIstLocal(session.endsAt) : '',
    venue: session.venue ?? '', capacity: session.capacity?.toString() ?? '', internalNote: session.internalNote ?? '',
  } : { productId: products.length === 1 ? products[0]!.id : '', start: '', end: '', venue: '', capacity: '', internalNote: '' })
  const action = useAction()
  const set = (key: keyof Draft) => (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problem = validateSessionDraft(kind, draft)
    if (problem) return action.setNotice({ kind: 'error', text: problem })
    const values: Omit<SessionForm, 'productId'> = {
      startsAt: istLocalToInstant(draft.start)!, endsAt: draft.end ? istLocalToInstant(draft.end) : null, venue: draft.venue.trim() || null,
      capacity: draft.capacity ? Number(draft.capacity) : null, internalNote: draft.internalNote.trim() || null,
    }
    const ok = await action.run(() => (session ? api.updateSession(session.id, values) : api.createSession({ productId: draft.productId, ...values })), 'Saved.')
    if (ok) onDone(session ? 'Saved.' : 'Created as a draft: publish it when ready.')
  }

  return (
    <form className="admin-form" onSubmit={submit} aria-label={session ? 'Edit date' : 'New date'}>
      <h3>{session ? 'Edit / reschedule' : `New ${COPY[kind].item}`}</h3>
      <div className="admin-form-grid">
        <label>Product
          <select value={draft.productId} onChange={set('productId')} disabled={Boolean(session)} required>
            <option value="">Choose…</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}{product.isActive ? '' : ' (inactive)'}</option>)}
          </select>
        </label>
        <label>Starts (IST)<input type="datetime-local" value={draft.start} onChange={set('start')} required /></label>
        <label>Ends (IST){kind === 'WEBINAR' ? ' (optional)' : ''}<input type="datetime-local" value={draft.end} onChange={set('end')} required={kind === 'OFFLINE_WORKSHOP'} /></label>
        {kind === 'OFFLINE_WORKSHOP' ? <label className="is-wide">Venue / location<input value={draft.venue} onChange={set('venue')} required maxLength={200} placeholder="e.g. Afforestt farm, Kashipur, Uttarakhand" /></label> : null}
        <label>Capacity (optional)<input value={draft.capacity} onChange={set('capacity')} inputMode="numeric" placeholder="e.g. 40" /></label>
        <label className="is-wide">Internal note (staff only)<textarea value={draft.internalNote} onChange={set('internalNote')} maxLength={2000} rows={2} /></label>
      </div>
      <div className="auth-actions">
        <button className="btn" type="submit" disabled={action.pending}>{action.pending ? 'Saving…' : session ? 'Save' : 'Create draft'}</button>
        <button className="btn btn-quiet" type="button" onClick={onCancel}>Close</button>
      </div>
      <Notice notice={action.notice} />
    </form>
  )
}
