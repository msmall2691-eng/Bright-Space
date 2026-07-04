import { Calendar } from 'lucide-react'
import InlineSelect from '../InlineSelect'
import { displayContactName } from '../../utils/display'
import { STATUS_OPTIONS, avatarColor } from './constants'

/** Configurable table columns for the Clients table view.
 *
 *  Each entry has `id`, `label`, and `render(c, h)` — the second
 *  argument is a bag of page-level helpers (currently updateStatus
 *  + setJobClient) so the JSX registry stays free of closures and
 *  can be imported as a plain module. The leading selection
 *  checkbox is fixed and lives outside this registry. A saved
 *  view stores an ordered list of the visible column ids. */
export const CLIENT_COLUMNS = [
  { id: 'name', label: 'Name', render: (c) => (
    <div className="flex items-center gap-2.5">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
        <span className="text-[10px] font-bold">{displayContactName(c)[0]?.toUpperCase()}</span>
      </div>
      <span className="text-[13px] font-medium text-ink truncate">{displayContactName(c)}</span>
    </div>
  ) },
  { id: 'phone', label: 'Phone', render: (c) => <span className="text-[12px] text-ink-3">{c.phone || '—'}</span> },
  { id: 'email', label: 'Email', render: (c) => <span className="text-[12px] text-ink-3 truncate block max-w-[200px]">{c.email || '—'}</span> },
  { id: 'city', label: 'City', render: (c) => <span className="text-[12px] text-ink-3">{c.city || '—'}</span> },
  { id: 'state', label: 'State', render: (c) => <span className="text-[12px] text-ink-3">{c.state || '—'}</span> },
  { id: 'source', label: 'Source', render: (c) => <span className="text-[12px] text-ink-3">{c.source || '—'}</span> },
  { id: 'created', label: 'Added', render: (c) => <span className="text-[12px] text-ink-3">{c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}</span> },
  { id: 'status', label: 'Status', render: (c, h) => (
    <div className="flex items-center gap-2">
      <InlineSelect value={c.status} options={STATUS_OPTIONS} onSelect={(s) => h.updateStatus(c, s)} />
      <button onClick={(e) => { e.stopPropagation(); h.setJobClient(c) }}
        title={`Schedule a job for ${displayContactName(c)}`} aria-label={`Schedule ${c.name}`}
        className="inline-flex items-center justify-center w-6 h-6 rounded-md text-ink-3 hover:text-blue-600 hover:bg-blue-50 transition-colors">
        <Calendar className="w-3.5 h-3.5" />
      </button>
    </div>
  ) },
]
