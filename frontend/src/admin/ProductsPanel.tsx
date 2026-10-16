import { useState, type FormEvent } from 'react'
import { formatPrice } from '../api/format'
import type { AdminProduct, ProductType } from '../api/types'
import type { AdminApi, ProductForm } from './admin-api'
import { useAction, useLoad } from './admin-hooks'
import { TYPE_LABEL, validateProductDraft, type ProductDraft } from './admin-rules'
import { ConfirmAction, LoadState, Notice, Pager, StatusBadge } from './ui'

const emptyDraft: ProductDraft = { slug: '', name: '', type: 'WEBINAR', summary: '', description: '', audience: '', durationLabel: '', amount: '', currency: 'INR' }
const toDraft = (product: AdminProduct): ProductDraft => ({
  slug: product.slug, name: product.name, type: product.type, summary: product.summary ?? '', description: product.description ?? '', audience: product.audience ?? '',
  durationLabel: product.durationLabel ?? '', amount: product.price.amount, currency: product.price.currency,
})

const nullable = (value: string) => (value.trim() === '' ? null : value.trim())
const toForm = (draft: ProductDraft): ProductForm => ({
  slug: draft.slug.trim(), name: draft.name.trim(), type: draft.type, summary: nullable(draft.summary), description: nullable(draft.description),
  audience: nullable(draft.audience), durationLabel: nullable(draft.durationLabel), price: { amount: draft.amount.trim(), currency: draft.currency.trim() },
})

export function ProductsPanel({ api }: { api: AdminApi }) {
  const [filter, setFilter] = useState<{ type: '' | ProductType; active: '' | 'true' | 'false'; page: number }>({ type: '', active: '', page: 1 })
  const [load, reload] = useLoad((signal) => api.listProducts({ ...(filter.type ? { type: filter.type } : {}), ...(filter.active ? { active: filter.active === 'true' } : {}), page: filter.page, pageSize: 20 }, signal), [api, filter])
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; product: AdminProduct } | null>(null)
  const action = useAction()

  return (
    <section aria-labelledby="products-heading">
      <div className="admin-toolbar">
        <h2 id="products-heading">Products</h2>
        <label>Type
          <select value={filter.type} onChange={(event) => setFilter({ ...filter, type: event.target.value as '' | ProductType, page: 1 })}>
            <option value="">All</option>{Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Status
          <select value={filter.active} onChange={(event) => setFilter({ ...filter, active: event.target.value as '' | 'true' | 'false', page: 1 })}>
            <option value="">All</option><option value="true">Active</option><option value="false">Inactive</option>
          </select>
        </label>
        <button className="btn btn-small" type="button" onClick={() => setEditing({ mode: 'create' })}>New product</button>
      </div>
      <Notice notice={action.notice} />
      {editing ? (
        <ProductEditor
          api={api}
          initial={editing.mode === 'edit' ? toDraft(editing.product) : emptyDraft}
          productId={editing.mode === 'edit' ? editing.product.id : null}
          onDone={(message) => { setEditing(null); action.setNotice({ kind: 'ok', text: message }); reload() }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      <LoadState load={load} retry={reload} empty={(data) => data.items.length === 0}>
        {(data) => (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Price</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {data.items.map((product) => (
                    <tr key={product.id}>
                      <td><strong>{product.name}</strong><br /><small>{product.slug}</small></td>
                      <td>{TYPE_LABEL[product.type]}</td>
                      <td>{formatPrice(product.price)}</td>
                      <td><StatusBadge status={product.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                      <td className="admin-actions">
                        <button className="btn btn-quiet btn-small" type="button" onClick={() => setEditing({ mode: 'edit', product })}>Edit</button>
                        {product.isActive ? (
                          <ConfirmAction label="Deactivate" confirmLabel={`Hide ${product.name} from the website`} disabled={action.pending}
                            onConfirm={() => action.run(() => api.setProductActive(product.id, false), `${product.name} is now inactive (hidden from the website; nothing deleted).`).then(reload)} />
                        ) : (
                          <button className="btn btn-quiet btn-small" type="button" disabled={action.pending}
                            onClick={() => void action.run(() => api.setProductActive(product.id, true), `${product.name} is now active.`).then(reload)}>Activate</button>
                        )}
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

export function ProductEditor({ api, initial, productId, onDone, onCancel }: { api: AdminApi; initial: ProductDraft; productId: string | null; onDone: (message: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ProductDraft>(initial)
  const action = useAction()
  const set = (key: keyof ProductDraft) => (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problem = validateProductDraft(draft)
    if (problem) return action.setNotice({ kind: 'error', text: problem })
    const form = toForm(draft)
    const ok = await action.run(
      () => (productId ? api.updateProduct(productId, (({ type: _type, ...changes }) => changes)(form)) : api.createProduct(form)),
      productId ? 'Saved.' : 'Created. New products start inactive: activate when ready.',
    )
    if (ok) onDone(productId ? `${form.name} saved.` : `${form.name} created (inactive until you activate it).`)
  }

  return (
    <form className="admin-form" onSubmit={submit} aria-label={productId ? 'Edit product' : 'New product'}>
      <h3>{productId ? `Edit ${initial.name}` : 'New product'}</h3>
      <div className="admin-form-grid">
        <label>Name<input value={draft.name} onChange={set('name')} required maxLength={160} /></label>
        <label>Slug (web address)<input value={draft.slug} onChange={set('slug')} required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" /></label>
        <label>Type
          {productId ? <input value={TYPE_LABEL[draft.type]} disabled /> : (
            <select value={draft.type} onChange={set('type')}>{Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          )}
        </label>
        <label>Price<input value={draft.amount} onChange={set('amount')} required inputMode="decimal" placeholder="149" /></label>
        <label>Currency<input value={draft.currency} onChange={set('currency')} required maxLength={3} list="currencies" /><datalist id="currencies"><option value="INR" /><option value="USD" /></datalist></label>
        <label>Duration label<input value={draft.durationLabel} onChange={set('durationLabel')} maxLength={80} placeholder="8 hours · 2 days" /></label>
        <label className="is-wide">Summary<input value={draft.summary} onChange={set('summary')} maxLength={500} /></label>
        <label className="is-wide">Description<textarea value={draft.description} onChange={set('description')} maxLength={5000} rows={3} /></label>
        <label className="is-wide">Suitable for<input value={draft.audience} onChange={set('audience')} maxLength={500} /></label>
      </div>
      <p className="admin-footnote">Prices are stored exactly as entered, in the chosen currency. No conversion or tax is applied.</p>
      <div className="auth-actions">
        <button className="btn" type="submit" disabled={action.pending}>{action.pending ? 'Saving…' : productId ? 'Save' : 'Create product'}</button>
        <button className="btn btn-quiet" type="button" onClick={onCancel}>Close</button>
      </div>
      <Notice notice={action.notice} />
    </form>
  )
}
