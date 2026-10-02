import { useEffect, useState } from 'react'
import { get } from '../../api'

/**
 * StandingCleanerField — designate ONE cleaner to do this rental's turnovers.
 *
 * Every turnover the property's iCal feed generates becomes a targeted offer
 * only that cleaner sees, grouped for them in My Properties and claimable in one
 * tap. It stays an OFFER — everyone on the book is a subcontractor, so the
 * cleaner accepts and the office approves; nobody is assigned
 * (brightbase-marketplace Rule 0). Empty = nobody designated, and turnovers are
 * created unassigned exactly as before. Design language: plain select, quiet
 * helper line, no bubbles.
 */
export default function StandingCleanerField({ value, onChange, className = '' }) {
  const [roster, setRoster] = useState(null)

  useEffect(() => {
    get('/api/crew/roster')
      .then(r => setRoster((r || []).filter(u => u.cleaner_id && u.status !== 'disabled')))
      .catch(() => setRoster([]))
  }, [])

  return (
    <div>
      <label className="block text-xs text-ink-3 mb-1">Standing cleaner — does every turnover here</label>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        className={className}
        data-testid="standing-cleaner-select">
        <option value="">No one — turnovers go unassigned</option>
        {(roster || []).map(u => (
          <option key={u.cleaner_id} value={u.cleaner_id}>{u.full_name || u.cleaner_id}</option>
        ))}
      </select>
      <p className="text-[10.5px] text-ink-3 mt-1">
        Each new turnover is offered to them to accept — offered, never assigned. Access codes stay hidden until they take the job.
      </p>
    </div>
  )
}
