/**
 * Me tab — weekly availability editor (crew app Phase 4).
 *
 * Seven rows (Mon–Sun), two chips each (AM / PM). Tap to toggle; explicit
 * Save like the profile card. This is the cleaner telling the office the
 * usual shape of their week — the office sees "usually off Friday
 * afternoons" when assigning, but can always assign anyway (it's a signal,
 * not a block). One-off absences are still a text to the office; this is
 * the recurring pattern.
 */
import { useEffect, useState } from 'react'
import { BadgeCheck, CalendarClock } from 'lucide-react'
import { get, put } from '../../api'

const DAYS = [
  ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'],
  ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun'],
]
const EMPTY_WEEK = Object.fromEntries(DAYS.map(([k]) => [k, []]))
// Sensible starting point when someone has never set a pattern: weekdays
// fully on, weekend off — closer to most of the crew's reality than all-off,
// so the first edit is "turn OFF what doesn't apply".
const DEFAULT_WEEK = { ...EMPTY_WEEK, mon: ['am', 'pm'], tue: ['am', 'pm'], wed: ['am', 'pm'], thu: ['am', 'pm'], fri: ['am', 'pm'] }

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export default function CrewAvailability() {
  const [saved, setSaved] = useState(null)     // server truth (null while loading)
  const [week, setWeek] = useState(null)       // edited copy
  const [neverSet, setNeverSet] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    get('/api/crew/me/availability')
      .then(d => {
        const w = d.week || DEFAULT_WEEK
        setNeverSet(!d.week)
        setSaved(d.week || null)
        setWeek(w)
      })
      .catch(e => setError(e.detail || e.message || 'Could not load availability'))
  }, [])

  useEffect(() => {
    if (!savedFlash) return undefined
    const t = setTimeout(() => setSavedFlash(false), 2000)
    return () => clearTimeout(t)
  }, [savedFlash])

  const toggle = (day, slot) => {
    setWeek(prev => {
      const has = (prev[day] || []).includes(slot)
      const slots = has ? prev[day].filter(s => s !== slot)
        : [...(prev[day] || []), slot].sort()
      return { ...prev, [day]: slots }
    })
  }

  const dirty = week && (neverSet || !same(week, saved))

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const d = await put('/api/crew/me/availability', { week })
      setSaved(d.week); setWeek(d.week); setNeverSet(false); setSavedFlash(true)
    } catch (e) {
      setError(e.detail || e.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  if (error && !week) {
    return <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
  }
  if (!week) return <div className="h-56 rounded-xl bg-bg-2 animate-pulse" />

  return (
    <div className="bg-panel rounded-xl border border-hairline shadow-glass-sm p-4 space-y-3">
      <div>
        <div className="text-sm font-bold text-ink flex items-center gap-1.5">
          <CalendarClock className="w-4 h-4 text-ink-3" /> My weekly availability
        </div>
        <p className="text-[11px] text-ink-3 mt-0.5">
          The office sees this when assigning jobs{neverSet ? " — you haven't saved one yet" : ''}.
          It's a heads-up, not a promise; one-off days off still go through the office.
        </p>
      </div>

      <div className="space-y-1.5">
        {DAYS.map(([key, label]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="w-9 text-[12px] font-semibold text-ink-2">{label}</span>
            <div className="flex-1 grid grid-cols-2 gap-1.5">
              {['am', 'pm'].map(slot => {
                const on = (week[key] || []).includes(slot)
                return (
                  <button key={slot} onClick={() => toggle(key, slot)} disabled={saving}
                    aria-pressed={on}
                    className={`py-1.5 rounded-lg text-[12px] font-semibold border transition-colors ${
                      on
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                        : 'bg-bg border-hairline text-ink-3'}`}>
                    {slot === 'am' ? 'Morning' : 'Afternoon'}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {(dirty || savedFlash) && (
        <button onClick={save} disabled={saving || !dirty}
          className={`w-full text-[13px] font-semibold py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5 ${
            savedFlash && !dirty
              ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/30'
              : 'bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60'}`}>
          {savedFlash && !dirty ? (<><BadgeCheck className="w-4 h-4" /> Saved</>)
            : saving ? 'Saving…' : 'Save availability'}
        </button>
      )}
    </div>
  )
}
