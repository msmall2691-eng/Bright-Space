import { Phone, Mail, MapPin, Calendar, Pencil, Trash2 } from 'lucide-react'
import { displayContactName } from '../../utils/display'
import { STATUS_COLORS, avatarColor } from './constants'

/** Card-view row for a single client — a dense, packable card (two-up on
 *  wide) matching the Customer 360 rhythm: avatar + record-link name, one
 *  quiet dot+word status, a single line of phone/email/city meta, and the
 *  quick Schedule / edit / delete actions that reveal on hover (always
 *  visible on touch). Row click navigates to the client profile; the
 *  checkbox and action buttons stop propagation. Edit opens the slide-in
 *  form (where the full field set lives); Delete confirms via the global
 *  dialog. */
export function ClientCardRow({ c, selected, toggleSelect, setJobClient, navigate, openEdit, deleteClient }) {
  const name = displayContactName(c)
  return (
    <div onClick={() => navigate(`/clients/${c.id}`)}
      className={`group flex items-center gap-3 bg-panel border rounded-lg px-3 py-2.5 cursor-pointer transition-colors min-w-0 ${selected ? 'border-hairline-2 bg-bg-2' : 'border-hairline hover:border-hairline-2 hover:bg-bg-2/40'}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => toggleSelect(c.id, e)}
        onClick={(e) => e.stopPropagation()}
        className="bb-check block shrink-0"
        data-testid="client-row-checkbox"
        aria-label={`Select ${c.name}`}
      />
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
        <span className="text-[11px] font-bold">{name[0]?.toUpperCase()}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-ink truncate group-hover:text-indigo-600 transition-colors">{name}</span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-3 capitalize shrink-0 ml-auto">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`} aria-hidden="true" />
            {c.status}
          </span>
        </div>
        <div className="flex items-center gap-x-3 mt-0.5 min-w-0">
          {c.phone && <span className="text-[11px] text-ink-3 flex items-center gap-1 shrink-0"><Phone className="w-3 h-3 shrink-0" />{c.phone}</span>}
          {c.email && <span className="text-[11px] text-ink-3 flex items-center gap-1 min-w-0"><Mail className="w-3 h-3 shrink-0" /><span className="truncate">{c.email}</span></span>}
          {c.city && <span className="text-[11px] text-ink-3 flex items-center gap-1 shrink-0"><MapPin className="w-3 h-3 shrink-0" />{c.city}</span>}
          {!c.phone && !c.email && !c.city && <span className="text-[11px] text-ink-3">No contact details</span>}
        </div>
      </div>
      {/* Quick actions — quiet at rest on pointer devices, revealed on hover
          or keyboard focus; always visible on touch where there's no hover. */}
      <div className="flex items-center gap-0.5 shrink-0 opacity-100 shell:opacity-0 shell:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button onClick={(e) => { e.stopPropagation(); setJobClient(c) }}
          title={`Schedule a job for ${name}`}
          aria-label={`Schedule ${c.name}`}
          className="inline-flex items-center justify-center w-9 h-9 shell:w-7 shell:h-7 rounded-md text-ink-3 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors">
          <Calendar className="w-4 h-4" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); openEdit(c) }}
          title={`Edit ${name}`}
          aria-label={`Edit ${c.name}`}
          className="inline-flex items-center justify-center w-9 h-9 shell:w-7 shell:h-7 rounded-md text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors">
          <Pencil className="w-4 h-4" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); deleteClient(c.id) }}
          title={`Delete ${name}`}
          aria-label={`Delete ${c.name}`}
          className="inline-flex items-center justify-center w-9 h-9 shell:w-7 shell:h-7 rounded-md text-ink-3 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
