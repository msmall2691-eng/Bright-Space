import { useState, useEffect, useRef } from 'react'
import { UserCircle2, Check, ChevronDown } from 'lucide-react'
import { get } from '../../api'

// Module-level cache so opening the picker on every thread doesn't refetch the
// (small, rarely-changing) staff list each time.
let _assigneeCache = null

/**
 * Assignee picker for a conversation (Phase F): pick a real teammate to own the
 * thread instead of a free-text name. Shows the current assignee; the dropdown
 * lists staff from /api/comms/assignees plus an Unassign option. Calls
 * onAssign(user | null).
 */
export function AssigneePicker({ currentName, currentId, onAssign }) {
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState(_assigneeCache || [])
  const ref = useRef(null)

  useEffect(() => {
    if (_assigneeCache) return
    get('/api/comms/assignees')
      .then(rows => { _assigneeCache = Array.isArray(rows) ? rows : []; setPeople(_assigneeCache) })
      .catch(() => setPeople([]))
  }, [])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pick = (user) => { setOpen(false); onAssign(user) }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)}
        title="Assign this conversation"
        className={`text-[12px] font-medium px-2.5 py-2 rounded-xl transition-all flex items-center gap-1.5 ${
          currentName ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'bg-bg-2 text-ink-3 hover:bg-hairline'
        }`}>
        <UserCircle2 className="w-3.5 h-3.5" />
        <span className="max-w-[90px] truncate">{currentName || 'Assign'}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-52 max-h-64 overflow-y-auto rounded-xl border border-hairline bg-panel shadow-lg z-30 py-1">
          <button onClick={() => pick(null)}
            className="w-full text-left px-3 py-2 text-[12px] text-ink-2 hover:bg-bg-2 flex items-center gap-2">
            <span className="w-3.5 h-3.5 shrink-0" />
            Unassigned
            {!currentId && <Check className="w-3.5 h-3.5 text-blue-500 ml-auto" />}
          </button>
          {people.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-ink-3">No staff found</div>
          ) : (
            people.map(p => (
              <button key={p.id} onClick={() => pick(p)}
                className="w-full text-left px-3 py-2 text-[12px] text-ink hover:bg-bg-2 flex items-center gap-2">
                <UserCircle2 className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                <span className="truncate">{p.name}</span>
                {currentId === p.id && <Check className="w-3.5 h-3.5 text-blue-500 ml-auto" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
