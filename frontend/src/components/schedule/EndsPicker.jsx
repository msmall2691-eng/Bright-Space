/** Google-Calendar-style "Ends" picker for recurring schedules: Never / On
 *  date / After N occurrences. Shared by the create form (ScheduleTabs.jsx's
 *  RecurringCreateModal) and the edit form (Recurring.jsx's EditSeriesModal).
 *
 *  `value` is `{ ends_mode, ends_on, ends_after_count }` — the same shape the
 *  backend's sched_to_dict() returns and create/update endpoints expect.
 *  ends_on here is always the user-facing INCLUSIVE last-visit date (the
 *  backend converts to/from the exclusive series_end_date column). */
export default function EndsPicker({ value, onChange }) {
  const mode = value.ends_mode || 'never'
  const set = (patch) => onChange({ ...value, ...patch })

  const defaultOnDate = () => {
    const d = new Date(); d.setDate(d.getDate() + 30)
    return d.toISOString().slice(0, 10)
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-ink-3 mb-1.5">Ends</label>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="radio" name="ends_mode" checked={mode === 'never'}
            onChange={() => set({ ends_mode: 'never' })} />
          Never
        </label>
        <label className="flex items-center gap-2 text-sm text-ink flex-wrap">
          <input type="radio" name="ends_mode" checked={mode === 'on_date'}
            onChange={() => set({ ends_mode: 'on_date', ends_on: value.ends_on || defaultOnDate() })} />
          On
          <input type="date" value={value.ends_on || ''} disabled={mode !== 'on_date'}
            onChange={e => set({ ends_mode: 'on_date', ends_on: e.target.value })}
            className="px-2 py-1 border border-hairline rounded-lg text-sm disabled:opacity-50 disabled:bg-bg-2" />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink flex-wrap">
          <input type="radio" name="ends_mode" checked={mode === 'after_count'}
            onChange={() => set({ ends_mode: 'after_count', ends_after_count: value.ends_after_count || 10 })} />
          After
          <input type="number" min="1" value={value.ends_after_count || ''} disabled={mode !== 'after_count'}
            onChange={e => set({ ends_mode: 'after_count', ends_after_count: e.target.value })}
            className="w-16 px-2 py-1 border border-hairline rounded-lg text-sm disabled:opacity-50 disabled:bg-bg-2" />
          occurrence{Number(value.ends_after_count) === 1 ? '' : 's'}
        </label>
      </div>
    </div>
  )
}
