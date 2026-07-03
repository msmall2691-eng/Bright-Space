import { useState, useEffect } from 'react'
import {
  ArrowLeft, Edit2, Mail, Phone, MapPin, Home,
} from 'lucide-react'
import { STATUS_COLORS } from './constants'

/** Twenty-style click-to-edit field for the record rail. Click the value to
 *  edit in place; Enter or blur saves via onSave, Escape cancels. */
function EditableField({ icon: Icon, label, value, placeholder = 'Add', type = 'text', saving = false, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  useEffect(() => { setDraft(value || '') }, [value])
  const commit = () => {
    setEditing(false)
    const v = (draft || '').trim()
    if (v !== (value || '')) onSave(v)
  }
  return (
    <div className="flex items-start gap-2 group">
      <Icon className="w-3.5 h-3.5 text-ink-3 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-ink-3 flex items-center gap-1">
          {label}{saving && <span className="text-ink-3/70">· saving…</span>}
        </div>
        {editing ? (
          <input
            autoFocus type={type} value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit()
              else if (e.key === 'Escape') { setDraft(value || ''); setEditing(false) }
            }}
            className="w-full bg-panel border border-blue-400 rounded px-1.5 py-0.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-blue-400/30"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Click to edit"
            className="text-left text-xs text-ink-2 hover:bg-bg-2 rounded px-1 -mx-1 py-0.5 w-full truncate transition-colors"
          >
            {value || <span className="text-ink-3 italic">{placeholder}</span>}
          </button>
        )}
      </div>
    </div>
  )
}

/** Twenty-style left record rail (desktop): identity, fields, related. */
export default function ClientLeftRail({
  client, navigate, setTab,
  savingField, saveField,
  visitStats, upcomingJobs, totalRevenue, outstanding, properties,
}) {
  return (
    <aside className="hidden lg:flex lg:flex-col w-80 shrink-0 border-r border-hairline bg-panel overflow-y-auto scrollbar-thin">
      <div className="p-4 border-b border-hairline">
        <button onClick={() => navigate('/clients')}
          className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink mb-4 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Clients
        </button>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center shrink-0">
            <span className="text-blue-500 font-bold text-lg">{(client.first_name || client.name)[0]?.toUpperCase()}</span>
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-ink truncate">{client.name}</h1>
            {/* Inline status edit (Twenty-style) */}
            <select
              value={client.status || 'lead'}
              onChange={e => saveField('status', e.target.value)}
              className={`mt-1 text-[10px] px-2 py-0.5 rounded-full border capitalize cursor-pointer focus:outline-none ${STATUS_COLORS[client.status] || ''}`}
              title="Change status"
            >
              <option value="lead">lead</option>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>
        </div>
        <button onClick={() => setTab('details')}
          className="mt-4 w-full flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-hairline border border-hairline px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
          <Edit2 className="w-3.5 h-3.5" /> Edit details
        </button>
      </div>

      <div className="p-4 border-b border-hairline space-y-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">Contact — click to edit</div>
        <EditableField icon={Mail}  label="Email" value={client.email} type="email" placeholder="Add email"
          saving={savingField === 'email'} onSave={v => saveField('email', v)} />
        <EditableField icon={Phone} label="Phone" value={client.phone} type="tel" placeholder="Add phone"
          saving={savingField === 'phone'} onSave={v => saveField('phone', v)} />
        <EditableField icon={MapPin} label="Address" value={client.address} placeholder="Add street address"
          saving={savingField === 'address'} onSave={v => saveField('address', v)} />
      </div>

      <div className="p-4 border-b border-hairline space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1">Pipeline</div>
        <div className="flex justify-between text-xs"><span className="text-ink-3">Upcoming</span><span className="font-semibold text-ink">{visitStats?.upcoming ?? upcomingJobs.length}</span></div>
        <div className="flex justify-between text-xs"><span className="text-ink-3">Revenue</span><span className="font-semibold text-emerald-600">${totalRevenue.toFixed(0)}</span></div>
        <div className="flex justify-between text-xs"><span className="text-ink-3">Outstanding</span><span className={`font-semibold ${outstanding > 0 ? 'text-amber-600' : 'text-ink'}`}>${outstanding.toFixed(0)}</span></div>
        <div className="flex justify-between text-xs"><span className="text-ink-3">Google Cal synced</span><span className="font-semibold text-indigo-600">{visitStats?.gcal_synced ?? 0}</span></div>
      </div>

      <div className="p-4 space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1">Properties</div>
        {properties.length === 0
          ? <p className="text-xs text-ink-3">No properties yet</p>
          : properties.map(p => (
              <button key={p.id} onClick={() => navigate(`/properties/${p.id}`)}
                className="w-full flex items-center gap-2 text-left text-xs text-ink-2 hover:text-ink py-1">
                <Home className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                <span className="truncate">{p.name || p.address}</span>
              </button>
            ))}
      </div>
    </aside>
  )
}
