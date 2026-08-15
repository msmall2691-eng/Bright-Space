import { Phone, Mail, MapPin, Calendar, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import { displayContactName } from '../../utils/display'
import { STATUS_COLORS, avatarColor } from './constants'

/** Card-view row for a single client — avatar + name + status pill,
 *  inline phone/email/city, selection checkbox, and the quick
 *  "Schedule a job" / edit / delete actions. Row-level click navigates
 *  to the client profile; checkbox and the action buttons stop
 *  propagation. Edit opens the slide-in form (which is also where the
 *  full field set lives); Delete confirms via the global dialog. */
export function ClientCardRow({ c, selected, toggleSelect, setJobClient, navigate, openEdit, deleteClient }) {
  return (
    <div onClick={() => navigate(`/clients/${c.id}`)}
      className={`flex items-center gap-3 sm:gap-4 bg-panel border rounded-xl p-3 sm:p-3.5 cursor-pointer transition-all group ${selected ? 'border-blue-400 bg-blue-50/40' : 'border-hairline hover:border-hairline'}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => toggleSelect(c.id, e)}
        onClick={(e) => e.stopPropagation()}
        className="w-4 h-4 rounded border-hairline cursor-pointer shrink-0"
        data-testid="client-row-checkbox"
        aria-label={`Select ${c.name}`}
      />
      <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
        <span className="text-[12px] font-bold">{displayContactName(c)[0]?.toUpperCase()}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-[13px] font-medium text-ink truncate">{displayContactName(c)}</div>
          <span className={`sm:hidden text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium shrink-0 ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
        </div>
        <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap">
          {c.phone && <span className="text-[11px] text-ink-3 flex items-center gap-1"><Phone className="w-3 h-3 shrink-0" />{c.phone}</span>}
          {c.email && <span className="text-[11px] text-ink-3 flex items-center gap-1 min-w-0 max-w-full"><Mail className="w-3 h-3 shrink-0" /><span className="truncate">{c.email}</span></span>}
          {c.city && <span className="text-[11px] text-ink-3 flex items-center gap-1"><MapPin className="w-3 h-3 shrink-0" />{c.city}</span>}
        </div>
      </div>
      <span className={`hidden sm:inline-flex text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium shrink-0 ${STATUS_COLORS[c.status] || STATUS_COLORS.inactive}`}>{c.status}</span>
      <button onClick={(e) => { e.stopPropagation(); setJobClient(c) }}
        title={`Schedule a job for ${displayContactName(c)}`}
        aria-label={`Schedule ${c.name}`}
        className="inline-flex items-center justify-center w-11 h-11 sm:w-7 sm:h-7 rounded-lg text-ink-3 hover:text-blue-600 hover:bg-blue-50 transition-colors shrink-0">
        <Calendar className="w-4 h-4" />
      </button>
      <button onClick={(e) => { e.stopPropagation(); openEdit(c) }}
        title={`Edit ${displayContactName(c)}`}
        aria-label={`Edit ${c.name}`}
        className="inline-flex items-center justify-center w-11 h-11 sm:w-7 sm:h-7 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors shrink-0">
        <Pencil className="w-4 h-4" />
      </button>
      <button onClick={(e) => { e.stopPropagation(); deleteClient(c.id) }}
        title={`Delete ${displayContactName(c)}`}
        aria-label={`Delete ${c.name}`}
        className="inline-flex items-center justify-center w-11 h-11 sm:w-7 sm:h-7 rounded-lg text-ink-3 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors shrink-0">
        <Trash2 className="w-4 h-4" />
      </button>
      <ChevronRight className="w-4 h-4 text-ink-3 group-hover:text-ink-3 transition-colors shrink-0" />
    </div>
  )
}
