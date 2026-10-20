import { useState, type FormEvent } from 'react'
import type { AdminCohort, ScheduleStatus } from '../api/types'
import type { AdminApi } from './admin-api'
import { useAction, useLoad } from './admin-hooks'
import { planCohort } from './admin-rules'
import { formatIst, instantToIstLocal } from './admin-time'
import { ConfirmAction, LoadState, Notice, Pager, StatusBadge } from './ui'

export function CohortsPanel({ api }: { api: AdminApi }) {
  const [filter, setFilter] = useState<{ status: '' | ScheduleStatus; page: number }>({ status: '', page: 1 })
  const [load, reload] = useLoad((signal) => api.listCohorts({ ...(filter.status ? { status: filter.status } : {}), page: filter.page, pageSize: 20 }, signal), [api, filter])
  const [products] = useLoad((signal) => api.listProducts({ type: 'ONLINE_TRAINING', pageSize: 100 }, signal), [api])
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; cohort: AdminCohort } | null>(null)
  const action = useAction()

  return (
    <section aria-labelledby="cohorts-heading">
      <div className="admin-toolbar">
        <h2 id="cohorts-heading">Online training dates</h2>
        <label>Status
          <select value={filter.status} onChange={(event) => setFilter({ status: event.target.value as '' | ScheduleStatus, page: 1 })}>
            <option value="">All</option><option value="DRAFT">Draft</option><option value="PUBLISHED">Published</option><option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <button className="btn btn-small" type="button" onClick={() => setEditing({ mode: 'create' })}>New training dates</button>
      </div>
      <p className="admin-footnote">Each online training is two 4-hour sessions on consecutive Fridays (IST). Both sessions are scheduled, published and cancelled together.</p>
      <Notice notice={action.notice} />
      {editing ? (
        <CohortEditor
          api={api} products={products.state === 'ready' ? products.data.items : []} cohort={editing.mode === 'edit' ? editing.cohort : null}
          onDone={(message) => { setEditing(null); action.setNotice({ kind: 'ok', text: message }); reload() }} onCancel={() => setEditing(null)}
        />
      ) : null}
      <LoadState load={load} retry={reload} empty={(data) => data.items.length === 0}>
        {(data) => (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th scope="col">Session 1 (IST)</th><th scope="col">Session 2 (IST)</th><th scope="col">Product</th><th scope="col">Booked / capacity</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {data.items.map((cohort) => (
                    <tr key={cohort.id}>
                      {[1, 2].map((sequence) => {
                        const session = cohort.sessions.find((s) => s.sequence === sequence)
                        return <td key={sequence}>{session ? formatIst(session.startsAt) : <em>missing</em>}</td>
                      })}
                      <td>{cohort.product.name}</td>
                      <td>{cohort.seatsHeld} / {cohort.capacity ?? 'no limit'}</td>
                      <td><StatusBadge status={cohort.status} /></td>
                      <td className="admin-actions">
                        {cohort.status !== 'CANCELLED' ? <button className="btn btn-quiet btn-small" type="button" onClick={() => setEditing({ mode: 'edit', cohort })}>{cohort.status === 'PUBLISHED' ? 'Edit / reschedule' : 'Edit'}</button> : null}
                        {cohort.status === 'DRAFT' ? (
                          <button className="btn btn-small" type="button" disabled={action.pending}
                            onClick={() => void action.run(() => api.publishCohort(cohort.id), 'Published: both Fridays now appear on the website.').then(reload)}>Publish</button>
                        ) : null}
                        {cohort.status !== 'CANCELLED' ? (
                          <ConfirmAction label="Cancel" confirmLabel="Cancel both sessions" withReason disabled={action.pending}
                            onConfirm={(reason) => action.run(() => api.cancelCohort(cohort.id, reason), 'Cancelled: both sessions are hidden from the website and kept for the record.').then(reload)} />
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

export function CohortEditor({ api, products, cohort, onDone, onCancel }: {
  api: AdminApi; products: { id: string; name: string; isActive: boolean }[]; cohort: AdminCohort | null; onDone: (message: string) => void; onCancel: () => void
}) {
  const firstLocal = cohort?.sessions[0] ? instantToIstLocal(cohort.sessions[0].startsAt) : ''
  const [productId, setProductId] = useState(cohort?.product.id ?? (products.length === 1 ? products[0]!.id : ''))
  const [date, setDate] = useState(firstLocal.slice(0, 10))
  const [time, setTime] = useState(firstLocal.slice(11) || '18:30')
  const [capacity, setCapacity] = useState(cohort?.capacity?.toString() ?? '')
  const [note, setNote] = useState(cohort?.internalNote ?? '')
  const action = useAction()
  const plan = date && time ? planCohort(date, time) : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!productId) return action.setNotice({ kind: 'error', text: 'Choose a product.' })
    if (!plan || typeof plan === 'string') return action.setNotice({ kind: 'error', text: typeof plan === 'string' ? plan : 'Choose the first Friday and a start time.' })
    if (capacity && !/^[1-9]\d{0,5}$/.test(capacity)) return action.setNotice({ kind: 'error', text: 'Capacity must be a whole number of at least 1 (or empty).' })
    const values = { firstSessionStartsAt: plan.first.start, secondSessionStartsAt: plan.second.start, capacity: capacity ? Number(capacity) : null, internalNote: note.trim() || null }
    const ok = await action.run(() => (cohort ? api.updateCohort(cohort.id, values) : api.createCohort({ productId, ...values })), 'Saved.')
    if (ok) onDone(cohort ? 'Saved.' : 'Created as a draft: publish it when ready.')
  }

  return (
    <form className="admin-form" onSubmit={submit} aria-label={cohort ? 'Edit training dates' : 'New training dates'}>
      <h3>{cohort ? 'Edit / reschedule training dates' : 'New online training dates'}</h3>
      <div className="admin-form-grid">
        <label>Product
          <select value={productId} onChange={(event) => setProductId(event.target.value)} disabled={Boolean(cohort)} required>
            <option value="">Choose…</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}{product.isActive ? '' : ' (inactive)'}</option>)}
          </select>
        </label>
        <label>First Friday<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        <label>Start time (IST)<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label>
        <label>Capacity (optional)<input value={capacity} onChange={(event) => setCapacity(event.target.value)} inputMode="numeric" placeholder="e.g. 20" /></label>
        <label className="is-wide">Internal note (staff only)<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={2} /></label>
      </div>
      <div className="admin-plan" aria-live="polite">
        {plan === null ? <p>Choose the first Friday to see both sessions.</p> : typeof plan === 'string' ? <p className="auth-message is-error">{plan}</p> : (
          <ol>
            <li><strong>Session 1:</strong> {formatIst(plan.first.start)} – {formatIst(plan.first.end).replace(/^.*, /, '')} (4 hours)</li>
            <li><strong>Session 2:</strong> {formatIst(plan.second.start)} – {formatIst(plan.second.end).replace(/^.*, /, '')} (4 hours, one week later)</li>
          </ol>
        )}
      </div>
      <div className="auth-actions">
        <button className="btn" type="submit" disabled={action.pending || typeof plan === 'string'}>{action.pending ? 'Saving…' : cohort ? 'Save' : 'Create draft'}</button>
        <button className="btn btn-quiet" type="button" onClick={onCancel}>Close</button>
      </div>
      <Notice notice={action.notice} />
    </form>
  )
}
