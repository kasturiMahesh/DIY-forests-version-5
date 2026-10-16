import { useState, type ReactNode } from 'react'
import type { PageMeta, ScheduleStatus } from '../api/types'
import type { Load } from './admin-hooks'

export function Notice({ notice }: { notice: { kind: 'ok' | 'error'; text: string } | null }) {
  if (!notice) return null
  return <p className={`auth-message${notice.kind === 'error' ? ' is-error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>
}

const STATUS_LABEL: Record<ScheduleStatus, string> = { DRAFT: 'Draft', PUBLISHED: 'Published', CANCELLED: 'Cancelled' }
export function StatusBadge({ status }: { status: ScheduleStatus | 'ACTIVE' | 'INACTIVE' }) {
  const label = status === 'ACTIVE' ? 'Active' : status === 'INACTIVE' ? 'Inactive' : STATUS_LABEL[status]
  return <span className={`admin-badge is-${status.toLowerCase()}`}>{label}</span>
}

export function LoadState<T>({ load, retry, empty, children }: { load: Load<T>; retry: () => void; empty?: (data: T) => boolean; children: (data: T) => ReactNode }) {
  if (load.state === 'loading') return <p aria-busy="true">Loading…</p>
  if (load.state === 'error') return <div><p className="auth-message is-error" role="alert">{load.message}</p><button className="btn btn-quiet" type="button" onClick={retry}>Try again</button></div>
  if (empty?.(load.data)) return <p className="admin-empty">Nothing here yet.</p>
  return <>{children(load.data)}</>
}

/** Two-step confirmation for significant actions (e.g. cancelling), with an optional reason. */
export function ConfirmAction({ label, confirmLabel, withReason, disabled, onConfirm }: {
  label: string
  confirmLabel: string
  withReason?: boolean
  disabled?: boolean
  onConfirm: (reason: string | null) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  if (!open) return <button className="btn btn-quiet btn-small" type="button" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
  return (
    <span className="admin-confirm" role="group" aria-label={confirmLabel}>
      {withReason ? <input aria-label="Reason (optional)" placeholder="Reason (optional)" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /> : null}
      <button className="btn btn-small" type="button" disabled={disabled} onClick={async () => { await onConfirm(reason.trim() || null); setOpen(false); setReason('') }}>{confirmLabel}</button>
      <button className="btn btn-quiet btn-small" type="button" onClick={() => setOpen(false)}>Keep</button>
    </span>
  )
}

export function Pager({ meta, onPage }: { meta: PageMeta; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(meta.total / meta.pageSize))
  if (pages <= 1) return null
  return (
    <nav className="admin-pager" aria-label="Pages">
      <button className="btn btn-quiet btn-small" type="button" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Previous</button>
      <span>Page {meta.page} of {pages}</span>
      <button className="btn btn-quiet btn-small" type="button" disabled={meta.page >= pages} onClick={() => onPage(meta.page + 1)}>Next</button>
    </nav>
  )
}
