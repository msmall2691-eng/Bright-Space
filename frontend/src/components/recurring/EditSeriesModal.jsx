import { useMemo, useState } from 'react'
import { patch } from '../../api'
import { useEmployees } from '../../hooks/useEmployees'
import JobCreateModal from '../JobCreateModal'
import EndsPicker from '../schedule/EndsPicker'
import FrequencyPicker from '../schedule/FrequencyPicker'
import Button from '../ui/Button'
import ErrorNote from '../ui/ErrorNote'
import ModalShell from './ModalShell'
import { DAY_LABELS, normalizeEmployee } from './helpers'

export default function EditSeriesModal({ schedule, onClose, onDone }) {
  const [form, setForm] = useState({
    title: schedule.title || '',
    address: schedule.address || '',
    frequency: schedule.frequency || 'weekly',
    // A daily rule with no weekday filter means "every day" — keep that empty
    // rather than seeding Monday, or saving would narrow it to Mondays only.
    days_of_week: (schedule.days_of_week && schedule.days_of_week.length)
      ? schedule.days_of_week
      : (schedule.frequency === 'daily' ? [] : [schedule.day_of_week ?? 0]),
    day_of_month: schedule.day_of_month || 1,
    interval_weeks: schedule.interval_weeks || (schedule.frequency === 'biweekly' ? 2 : 1),
    start_time: (schedule.start_time || '09:00').slice(0, 5),
    end_time: (schedule.end_time || '11:00').slice(0, 5),
    generate_weeks_ahead: schedule.generate_weeks_ahead || 8,
    notes: schedule.notes || '',
    cleaner_ids: schedule.cleaner_ids || [],
    ends_mode: schedule.ends_mode || 'never',
    ends_on: schedule.ends_on || '',
    ends_after_count: schedule.series_end_occurrences || 10,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toggleDay = (d) => setForm(f => {
    const has = f.days_of_week.includes(d)
    const next = has ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d].sort((a, b) => a - b)
    return { ...f, days_of_week: next }
  })
  const { employees } = useEmployees()
  const cleaners = useMemo(
    () => (employees || []).map(normalizeEmployee).filter(c => c.id),
    [employees]
  )
  const toggleCleaner = (id) => setForm(f => {
    const has = f.cleaner_ids.includes(id)
    const next = has ? f.cleaner_ids.filter(x => x !== id) : [...f.cleaner_ids, id]
    return { ...f, cleaner_ids: next }
  })
  const submit = async () => {
    if (!form.title.trim()) { setError('Title required'); return }
    if (!form.address.trim()) { setError('Address required'); return }
    // Daily with no days selected is valid ("every day"); week-based rules need
    // at least one weekday.
    if (form.frequency !== 'monthly' && form.frequency !== 'daily' && form.days_of_week.length === 0) {
      setError('Pick at least one day of week'); return
    }
    if (form.ends_mode === 'on_date' && !form.ends_on) {
      setError('Pick an end date'); return
    }
    if (form.ends_mode === 'after_count' && (!form.ends_after_count || parseInt(form.ends_after_count) < 1)) {
      setError('Occurrence count must be at least 1'); return
    }
    setSaving(true); setError('')
    try {
      // Backend PATCH rejects `days_of_week: []` outright (would silently
      // collapse a multi-day schedule). For a monthly rule, days_of_week
      // is meaningless — omit it entirely so exclude_none drops it server-side.
      const payload = {
        title: form.title.trim(),
        address: form.address.trim(),
        frequency: form.frequency,
        // interval_weeks is the single source of cadence for week-based rules
        // (1=weekly, 2=biweekly, 4=every 4 weeks, 8=every 8 weeks…); the
        // backend ignores it for monthly. The Frequency select keeps it in sync.
        interval_weeks: parseInt(form.interval_weeks) || 1,
        day_of_month: form.frequency === 'monthly' ? parseInt(form.day_of_month) : null,
        start_time: form.start_time + ':00',
        end_time: form.end_time + ':00',
        generate_weeks_ahead: parseInt(form.generate_weeks_ahead) || 8,
        notes: form.notes || null,
        cleaner_ids: form.cleaner_ids,
        // Always send ends_mode (never omit) — update_schedule's PATCH
        // treats a missing key as "don't touch the existing end setting",
        // not "clear it", so the Ends UI must state its choice every save.
        ends_mode: form.ends_mode,
        ends_on: form.ends_mode === 'on_date' ? form.ends_on : null,
        ends_after_count: form.ends_mode === 'after_count' ? parseInt(form.ends_after_count) : null,
      }
      if (form.frequency !== 'monthly') {
        payload.days_of_week = form.days_of_week
      }
      await patch(`/api/recurring/${schedule.id}`, payload)
      onDone()
    } catch (e) {
      setError(e.message || 'Failed to save rule')
      setSaving(false)
    }
  }
  return (
    <ModalShell title="Edit recurring rule" onClose={onClose} wide>
      <div className="p-3 rounded-lg bg-panel border border-hairline text-ink-2 text-[13px] flex gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1.5" aria-hidden="true" />
        <div>
          <div className="font-semibold text-ink">These changes apply to future visits only.</div>
          Visits already on the calendar keep their current time and cleaners.
          To change one specific visit, use “Skip” or “Reschedule” on that row.
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Title</label>
        <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Address</label>
        <input type="text" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <FrequencyPicker value={form} onChange={patch => setForm(f => ({ ...f, ...patch }))} />
      {form.frequency === 'monthly' ? (
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">Day of month (1–28)</label>
          <input type="number" min="1" max="28" value={form.day_of_month}
            onChange={e => setForm(f => ({ ...f, day_of_month: e.target.value }))}
            className="w-32 px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
      ) : (
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">
            {form.frequency === 'daily' ? 'Day(s) of week (optional — blank = every day)' : 'Day(s) of week'}
          </label>
          <div className="flex flex-wrap gap-2">
            {DAY_LABELS.map((lbl, i) => {
              const sel = form.days_of_week.includes(i)
              return (
                <button key={i} type="button" onClick={() => toggleDay(i)}
                  className={'px-3 py-1.5 rounded-md border text-sm ' + (sel
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-panel text-ink-2 border-hairline')}>
                  {lbl}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">Start time</label>
          <input type="time" value={form.start_time}
            onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
            className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink-3 mb-1">End time</label>
          <input type="time" value={form.end_time}
            onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
            className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Crew</label>
        {cleaners.length === 0 ? (
          <p className="text-xs text-ink-3">No cleaners on the roster yet — add your crew on the Crew page.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {cleaners.map(c => {
              const sel = form.cleaner_ids.includes(c.id)
              return (
                <button key={c.id} type="button" onClick={() => toggleCleaner(c.id)}
                  className={'px-3 py-1.5 rounded-md border text-sm ' + (sel
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-panel text-ink-2 border-hairline')}>
                  {c.name}
                </button>
              )
            })}
          </div>
        )}
        <p className="text-[11px] text-ink-3 mt-1.5">
          Changes future-generated visits only, same as the rest of this form —
          crew on visits already on the calendar is untouched.
        </p>
      </div>
      <EndsPicker
        value={{ ends_mode: form.ends_mode, ends_on: form.ends_on, ends_after_count: form.ends_after_count }}
        onChange={(next) => setForm(f => ({ ...f, ...next }))}
      />
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Keep visits scheduled ahead</label>
        <input type="number" min="1" max="52" value={form.generate_weeks_ahead}
          onChange={e => setForm(f => ({ ...f, generate_weeks_ahead: e.target.value }))}
          className="w-32 px-3 py-2 border border-hairline rounded-lg text-sm" />
        <p className="text-xs text-ink-3 mt-1 max-w-md">
          How many weeks of visits are created at a time. With <b>Recurring auto-generate</b> on
          (Settings → Automation) this window rolls forward every day, so you never run out. It’s
          separate from how often the visit repeats above.
        </p>
      </div>
      <div>
        <label className="block text-xs font-semibold text-ink-3 mb-1">Notes</label>
        <textarea value={form.notes} rows={2}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save rule changes'}
        </Button>
      </div>
    </ModalShell>
  )
}

// Shared modal chrome. Matches the fixed-overlay pattern used by JobCreateModal.
