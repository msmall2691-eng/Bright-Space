import { useState, useEffect } from 'react'
import { Calendar, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { get, post, put, del } from '../../api'
import Button from '../ui/Button'
import GlassCard from '../ui/GlassCard'
import { toast } from '../../utils/toastBus'
import { confirmDialog } from '../../utils/confirmBus'
import EndsPicker from './EndsPicker'

/** Two self-contained tab views for the Schedule page.
 *  - AvailabilityPanel: cleaner time-off entries (CRUD against /api/jobs/time-off).
 *  - RecurringPanel: recurring schedule list + generate/pause + create modal.
 *  Both mount as top-level views (no props) when the ?tab= query param routes
 *  the Schedule page to them, so they own their own data loading. */

export function RecurringCreateModal({ clients, properties, onClose, onCreated }) {
  const [form, setForm] = useState({
    client_id: '',
    property_id: '',
    job_type: 'residential',
    title: '',
    address: '',
    frequency: 'weekly',
    interval_weeks: 1,
    days_of_week: [1],
    day_of_month: 1,
    start_time: '09:00',
    end_time: '11:00',
    generate_weeks_ahead: 8,
    notes: '',
    ends_mode: 'never',
    ends_on: '',
    ends_after_count: 10,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const filteredProps = properties.filter(p => !form.client_id || p.client_id === parseInt(form.client_id))
  const toggleDay = (d) => {
    setForm(f => {
      const has = f.days_of_week.includes(d)
      return { ...f, days_of_week: has ? f.days_of_week.filter(x => x !== d) : [...f.days_of_week, d].sort() }
    })
  }
  const handlePropertyChange = (pid) => {
    const p = properties.find(x => String(x.id) === String(pid))
    setForm(f => ({
      ...f,
      property_id: pid,
      address: p?.address || f.address,
      job_type: p?.property_type === 'commercial' ? 'commercial' : 'residential',
    }))
  }
  const submit = async () => {
    if (!form.client_id) { setError('Pick a client'); return }
    if (!form.title.trim()) { setError('Title is required'); return }
    if (!form.address.trim()) { setError('Address is required'); return }
    if (form.frequency !== 'monthly' && form.days_of_week.length === 0) {
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
      const payload = {
        client_id: parseInt(form.client_id),
        property_id: form.property_id ? parseInt(form.property_id) : null,
        job_type: form.job_type,
        title: form.title.trim(),
        address: form.address.trim(),
        frequency: form.frequency,
        interval_weeks: form.frequency === 'monthly' ? 1 : (parseInt(form.interval_weeks) || 1),
        days_of_week: form.frequency === 'monthly' ? [] : form.days_of_week,
        day_of_week: form.days_of_week[0] || 0,
        day_of_month: form.frequency === 'monthly' ? parseInt(form.day_of_month) : null,
        start_time: form.start_time + ':00',
        end_time: form.end_time + ':00',
        generate_weeks_ahead: parseInt(form.generate_weeks_ahead) || 8,
        notes: form.notes || null,
        ends_mode: form.ends_mode,
        ends_on: form.ends_mode === 'on_date' ? form.ends_on : null,
        ends_after_count: form.ends_mode === 'after_count' ? parseInt(form.ends_after_count) : null,
      }
      await post('/api/recurring', payload)
      onCreated(); onClose()
    } catch (e) {
      setError(e.message || 'Failed to create schedule')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center sm:justify-center">
      <div className="w-full sm:max-w-2xl bg-panel rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[95vh]">
        <div className="flex items-center justify-between bg-gradient-to-r from-blue-500 to-indigo-600 p-4 sm:p-6 text-white">
          <h2 className="text-xl sm:text-2xl font-bold">New recurring schedule</h2>
          <button onClick={onClose} className="p-2 hover:bg-blue-400 rounded"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 sm:p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold mb-1">Client *</label>
              <select value={form.client_id} onChange={e => setForm(f => ({...f, client_id: e.target.value}))} className="w-full px-3 py-2 border border-hairline rounded-lg">
                <option value="">Select a client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Property (optional)</label>
              <select value={form.property_id} onChange={e => handlePropertyChange(e.target.value)} className="w-full px-3 py-2 border border-hairline rounded-lg">
                <option value="">None</option>
                {filteredProps.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Title *</label>
            <input type="text" value={form.title} onChange={e => setForm(f => ({...f, title: e.target.value}))} placeholder="Weekly home clean" className="w-full px-3 py-2 border border-hairline rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Address *</label>
            <input type="text" value={form.address} onChange={e => setForm(f => ({...f, address: e.target.value}))} placeholder="123 Main St, Portland, ME" className="w-full px-3 py-2 border border-hairline rounded-lg" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold mb-1">Frequency</label>
              <select
                value={form.frequency === 'monthly' ? 'monthly' : String(form.interval_weeks || 1)}
                onChange={e => {
                  const v = e.target.value
                  if (v === 'monthly') { setForm(f => ({...f, frequency: 'monthly'})); return }
                  const n = parseInt(v) || 1
                  setForm(f => ({...f, frequency: n === 2 ? 'biweekly' : 'weekly', interval_weeks: n}))
                }}
                className="w-full px-3 py-2 border border-hairline rounded-lg">
                <option value="1">Weekly</option>
                <option value="2">Biweekly (every 2 weeks)</option>
                <option value="3">Every 3 weeks</option>
                <option value="4">Every 4 weeks</option>
                <option value="8">Every 8 weeks</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Type</label>
              <select value={form.job_type} onChange={e => setForm(f => ({...f, job_type: e.target.value}))} className="w-full px-3 py-2 border border-hairline rounded-lg">
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
              </select>
            </div>
          </div>
          {form.frequency === 'monthly' ? (
            <div>
              <label className="block text-sm font-semibold mb-1">Day of month (1-28)</label>
              <input type="number" min="1" max="28" value={form.day_of_month} onChange={e => setForm(f => ({...f, day_of_month: e.target.value}))} className="w-32 px-3 py-2 border border-hairline rounded-lg" />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-semibold mb-1">Day(s) of week</label>
              <div className="flex flex-wrap gap-2">
                {dayLabels.map((label, i) => {
                  const dayNum = (i + 6) % 7
                  const sel = form.days_of_week.includes(dayNum)
                  return (
                    <button key={i} type="button" onClick={() => toggleDay(dayNum)} className={'px-3 py-2 rounded-full border text-sm ' + (sel ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-panel text-ink-2 border-hairline')}>
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold mb-1">Start time</label>
              <input type="time" value={form.start_time} onChange={e => setForm(f => ({...f, start_time: e.target.value}))} className="w-full px-3 py-2 border border-hairline rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">End time</label>
              <input type="time" value={form.end_time} onChange={e => setForm(f => ({...f, end_time: e.target.value}))} className="w-full px-3 py-2 border border-hairline rounded-lg" />
            </div>
          </div>
          <EndsPicker
            value={{ ends_mode: form.ends_mode, ends_on: form.ends_on, ends_after_count: form.ends_after_count }}
            onChange={(next) => setForm(f => ({ ...f, ...next }))}
          />
          <div>
            <label className="block text-sm font-semibold mb-1">Generate weeks ahead</label>
            <input type="number" min="1" max="52" value={form.generate_weeks_ahead} onChange={e => setForm(f => ({...f, generate_weeks_ahead: e.target.value}))} className="w-32 px-3 py-2 border border-hairline rounded-lg" />
            <p className="text-xs text-ink-3 mt-1">How many weeks of future jobs to materialize.</p>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))} rows={2} className="w-full px-3 py-2 border border-hairline rounded-lg" />
          </div>
          {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 rounded text-sm">{error}</div>}
        </div>
        <div className="border-t border-hairline bg-bg p-4 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>{saving ? 'Creating...' : 'Create schedule'}</Button>
        </div>
      </div>
    </div>
  )
}

export function AvailabilityPanel() {
  const [entries, setEntries] = useState([])
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ cleaner_id: '', start_date: '', end_date: '', reason: 'vacation' })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [rows, emps] = await Promise.all([
        get('/api/jobs/time-off'),
        get('/api/dispatch/employees').catch(() => []),
      ])
      setEntries(Array.isArray(rows) ? rows : [])
      setEmployees(Array.isArray(emps) ? emps : [])
    } catch (e) {
      toast.error(e.message || 'Failed to load time off')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const empName = (id) => employees.find(e => String(e.id) === String(id))?.name || `Cleaner ${id}`

  const add = async () => {
    if (!form.cleaner_id || !form.start_date || !form.end_date) {
      toast.error('Pick a cleaner and both dates')
      return
    }
    setSaving(true)
    try {
      await post('/api/jobs/time-off', {
        cleaner_id: String(form.cleaner_id),
        cleaner_name: empName(form.cleaner_id),
        start_date: form.start_date,
        end_date: form.end_date,
        reason: form.reason || null,
      })
      toast.success('Time off added')
      setForm({ cleaner_id: '', start_date: '', end_date: '', reason: 'vacation' })
      await load()
    } catch (e) {
      toast.error(e.message || 'Could not add time off')
    }
    setSaving(false)
  }

  const remove = async (id) => {
    if (!(await confirmDialog('Remove this time-off entry?'))) return
    try {
      await del(`/api/jobs/time-off/${id}`)
      setEntries(entries.filter(e => e.id !== id))
    } catch (e) {
      toast.error(e.message || 'Could not remove')
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-bold text-ink mb-1">Cleaner availability</h1>
      <p className="text-sm text-ink-3 mb-5">
        Mark a cleaner off for a date range. They can't be assigned to jobs on those days
        (override per-job if needed).
      </p>

      <GlassCard className="p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">Cleaner</label>
            <select value={form.cleaner_id} onChange={e => setForm(f => ({ ...f, cleaner_id: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm">
              <option value="">Select…</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">Reason</label>
            <select value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm">
              <option value="vacation">Vacation</option>
              <option value="sick">Sick</option>
              <option value="personal">Personal</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">From</label>
            <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink-3 mb-1">To</label>
            <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm" />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={add} disabled={saving}>
            {saving ? 'Adding…' : 'Add time off'}
          </Button>
        </div>
      </GlassCard>

      {loading ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-3 italic">No upcoming time off scheduled.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map(e => (
            <li key={e.id} className="flex items-center justify-between bg-panel border border-hairline rounded-lg px-3 py-2.5">
              <div>
                <span className="text-sm font-semibold text-ink">{e.cleaner_name || empName(e.cleaner_id)}</span>
                <span className="text-xs text-ink-3 ml-2">{e.start_date} → {e.end_date}</span>
                {e.reason && <span className="text-[11px] text-ink-3 ml-2 capitalize">· {e.reason}</span>}
              </div>
              <button onClick={() => remove(e.id)} className="text-ink-3 hover:text-red-500 p-1" aria-label="Remove">
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function RecurringPanel() {
  const [schedules, setSchedules] = useState([])
  const [clients, setClients] = useState({})
  const [propertiesList, setPropertiesList] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(null)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [sch, cli, props] = await Promise.all([
        get('/api/recurring'),
        // T-06: same as Recurring page — the default 50-cap dropped clients
        // past position 50 from the name-lookup map, so schedules referenced
        // "Client #99" instead of a real name.
        get('/api/clients?limit=1000'),
        get('/api/properties'),
      ])
      const cliArr = Array.isArray(cli) ? cli : (cli.items || [])
      const cliMap = {}
      cliArr.forEach(c => { cliMap[c.id] = c })
      setSchedules(Array.isArray(sch) ? sch : (sch.items || []))
      setClients(cliMap)
      const propsArr = Array.isArray(props) ? props : (props.items || [])
      setPropertiesList(propsArr)
    } catch (e) {
      setError(e.message || 'Failed to load recurring schedules')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleGenerate = async (id) => {
    setGenerating(id)
    try {
      const r = await post(`/api/recurring/${id}/generate`, {})
      await load()
      toast.success(`Generated ${r.jobs_created || 0} new jobs.`)
    } catch (e) {
      toast.error(`Generation failed: ${e.message || e}`)
    } finally {
      setGenerating(null)
    }
  }

  const handleToggleActive = async (s) => {
    try {
      await put(`/api/recurring/${s.id}`, { active: !s.active })
      await load()
    } catch (e) {
      toast.error(`Update failed: ${e.message || e}`)
    }
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-ink">Recurring schedules</h1>
            <p className="text-sm text-ink-3 mt-1">Auto-generates jobs daily. Manual trigger available per schedule.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="w-4 h-4 mr-1" />Refresh</Button>
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}><Plus className="w-4 h-4 mr-1" />New schedule</Button>
          </div>
        </div>
        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 rounded">{error}</div>}
        {loading ? (
          <div className="text-center text-ink-3 py-12">Loading...</div>
        ) : schedules.length === 0 ? (
          <div className="bg-panel border border-hairline rounded-2xl p-10 text-center">
            <Calendar className="w-8 h-8 text-ink-3 mx-auto mb-2" />
            <p className="text-[13px] text-ink-3">No recurring schedules yet</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {schedules.map(s => {
              const client = clients[s.client_id]
              const days = s.days_of_week || [s.day_of_week]
              const dayStr = days.map(d => dayNames[(d + 1) % 7]).join(', ')
              return (
                <li key={s.id} className="bg-panel border border-hairline rounded-2xl p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-base font-semibold text-ink">{s.title || 'Untitled'}</h3>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${s.active ? 'bg-emerald-100 text-emerald-700' : 'bg-bg-2 text-ink-3'}`}>
                          {s.active ? 'Active' : 'Paused'}
                        </span>
                      </div>
                      <p className="text-[13px] text-ink-2">{client?.name || 'Unknown client'} · {s.address}</p>
                      <p className="text-[12px] text-ink-3 mt-1">
                        {s.frequency} · {dayStr} · {s.upcoming_job_count || 0} upcoming job{s.upcoming_job_count === 1 ? '' : 's'} · generates {s.generate_weeks_ahead} weeks ahead
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => handleToggleActive(s)}>
                        {s.active ? 'Pause' : 'Resume'}
                      </Button>
                      <Button variant="primary" size="sm" disabled={generating === s.id || !s.active} onClick={() => handleGenerate(s.id)}>
                        {generating === s.id ? 'Generating...' : 'Generate now'}
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {showCreate && (
        <RecurringCreateModal
          clients={Object.values(clients)}
          properties={propertiesList}
          onClose={() => setShowCreate(false)}
          onCreated={load}
        />
      )}
    </div>
  )
}
