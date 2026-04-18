import { useState, useEffect } from 'react'
import { Plus, X, RefreshCw, Calendar, CheckCircle, MapPin, Home, AlertCircle } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get, post, patch } from "../api"


const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const FREQ_LABELS = { weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Monthly' }

const EMPTY = {
  client_id: '', property_id: '', job_type: 'residential', title: '', address: '',
  frequency: 'biweekly', days_of_week: [0], day_of_month: 1,
  start_time: '09:00', end_time: '12:00', generate_weeks_ahead: 8, notes: ''
}

export default function Recurring() {
  console.log('[Recurring] rendered')
  const [schedules, setSchedules] = useState([])
  const [clients, setClients] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [generating, setGenerating] = useState(null)
  const [genResult, setGenResult] = useState(null)
  const [clientProperties, setClientProperties] = useState([])

  const load = () =>
    get('/api/recurring').then(setSchedules).catch(err => console.error("[Recurring]", err))

  useEffect(() => {
    load()
    get('/api/clients?status=active').then(setClients).catch(err => console.error("[Recurring]", err))
  }, [])

  // Load properties when client changes
  useEffect(() => {
    if (!form.client_id) { setClientProperties([]); return }
    get(`/api/properties?client_id=${form.client_id}`)
      .then(props => {
        setClientProperties(Array.isArray(props) ? props : [])
        // If only one property, auto-select it
        if (props.length === 1 && !form.property_id) {
          setForm(f => ({ ...f, property_id: props[0].id, address: props[0].address || f.address }))
        }
      })
      .catch(() => setClientProperties([]))
  }, [form.client_id])

  const clientName = (id) => clients.find(c => c.id === id)?.name || `Client #${id}`

  const selectProperty = (prop) => {
    setForm(f => ({
      ...f,
      property_id: prop.id,
      address: [prop.address, prop.city, prop.state].filter(Boolean).join(', '),
      job_type: prop.property_type === 'commercial' ? 'commercial'
              : prop.property_type === 'str'        ? 'str_turnover'
              : 'residential',
    }))
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const method = selected ? 'PATCH' : 'POST'
      const url = selected ? `/api/recurring/${selected.id}` : '/api/recurring'
      const body = {
        ...form,
        client_id: parseInt(form.client_id),
        property_id: form.property_id ? parseInt(form.property_id) : null,
        days_of_week: (form.days_of_week || [0]).map(Number),
        day_of_week: (form.days_of_week || [0]).map(Number)[0] ?? 0,
        day_of_month: form.frequency === 'monthly' ? parseInt(form.day_of_month) : null,
        generate_weeks_ahead: parseInt(form.generate_weeks_ahead),
      }
      selected ? await patch(url, body) : await post(url, body)
      await load()
      setShowForm(false)
      setSelected(null)
    } catch (e) {
      setSaveError(e.message || 'Something went wrong — check your connection and try again.')
    }
    setSaving(false)
  }

  const generateJobs = async (id) => {
    setGenerating(id)
    setGenResult(null)
    const data = await post(`/api/recurring/${id}/generate`)
    setGenResult({ id, ...data })
    setGenerating(null)
    await load()
  }

  const generateAll = async () => {
    setGenerating('all')
    setGenResult(null)
    const data = await post('/api/recurring/generate-all')
    setGenResult({ id: 'all', ...data })
    setGenerating(null)
    await load()
  }

  const toggleActive = async (s) => {
    await patch(`/api/recurring/${s.id}`, { active: !s.active })
    load()
  }

  const openEdit = (s) => {
    setSelected(s)
    setForm({ ...s, property_id: s.property_id || '', days_of_week: s.days_of_week || [s.day_of_week ?? 0] })
    setShowForm(true)
  }
  const openNew = () => { setSelected(null); setForm(EMPTY); setShowForm(true) }

  const active = schedules.filter(s => s.active)
  const inactive = schedules.filter(s => !s.active)

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-lg font-semibold text-zinc-900 flex-1">Recurring Schedules</h2>
          {schedules.length > 0 && (
            <button onClick={generateAll} disabled={generating === 'all'}
              className="flex items-center gap-2 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-4 py-2 rounded-lg text-sm transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${generating === 'all' ? 'animate-spin' : ''}`} />
              Generate All
            </button>
          )}
          <button onClick={openNew}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Schedule
          </button>
        </div>

        {/* Result banner */}
        {genResult && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 rounded-xl p-3 mb-4 text-sm">
            <CheckCircle className="w-4 h-4 shrink-0" />
            {genResult.jobs_created} job{genResult.jobs_created !== 1 ? 's' : ''} generated
            {genResult.schedules_processed != null ? ` across ${genResult.schedules_processed} schedules` : ''}
            <button onClick={() => setGenResult(null)} className="ml-auto opacity-60 hover:opacity-100">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="overflow-y-auto flex-1 scrollbar-thin space-y-6">
          {active.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 font-medium mb-3 uppercase tracking-wide">
                Active — {active.length} schedule{active.length !== 1 ? 's' : ''}
              </p>
              <div className="space-y-2">
                {active.map(s => (
                  <ScheduleCard key={s.id} s={s} clientName={clientName} generating={generating}
                    onEdit={() => openEdit(s)} onGenerate={() => generateJobs(s.id)} onToggle={() => toggleActive(s)} />
                ))}
              </div>
            </div>
          )}

          {inactive.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 font-medium mb-3 uppercase tracking-wide">Paused</p>
              <div className="space-y-2 opacity-60">
                {inactive.map(s => (
                  <ScheduleCard key={s.id} s={s} clientName={clientName} generating={generating}
                    onEdit={() => openEdit(s)} onGenerate={() => generateJobs(s.id)} onToggle={() => toggleActive(s)} />
                ))}
              </div>
            </div>
          )}

          {schedules.length === 0 && (
            <div className="text-center py-20">
              <Calendar className="w-12 h-12 mx-auto mb-3 text-zinc-600" />
              <div className="text-zinc-600 font-medium mb-1">No recurring schedules yet</div>
              <div className="text-zinc-600 text-sm mb-5 max-w-xs mx-auto">
                Set up weekly, biweekly, or monthly schedules and BrightBase will auto-generate job visits.
              </div>
              <button onClick={openNew} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors">
                Create First Schedule
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Form panel */}
      {showForm && (
        <div className="fixed inset-0 z-40 bg-white flex flex-col sm:static sm:inset-auto sm:z-auto sm:w-96 sm:border-l sm:border-zinc-200 sm:shrink-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200">
            <h2 className="font-semibold text-zinc-900">{selected ? 'Edit Schedule' : 'New Schedule'}</h2>
            <button onClick={() => { setShowForm(false); setSelected(null) }} className="text-zinc-500 hover:text-zinc-900">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">

            {/* Client */}
            <div>
              <label className="block text-xs text-zinc-700 font-medium mb-1">Client *</label>
              <select value={form.client_id}
                onChange={e => setForm(f => ({ ...f, client_id: e.target.value, property_id: '', address: '' }))}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none">
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Property picker */}
            {form.client_id && (
              <div>
                <label className="block text-xs text-zinc-700 font-medium mb-1">Property</label>
                {clientProperties.length === 0 ? (
                  <p className="text-xs text-zinc-600 px-1">No properties found for this client</p>
                ) : (
                  <div className="space-y-1.5">
                    {clientProperties.map(p => (
                      <button key={p.id}
                        onClick={() => selectProperty(p)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors border ${
                          parseInt(form.property_id) === p.id
                            ? 'bg-sky-50 border-sky-200 text-sky-800'
                            : 'bg-zinc-100 border-zinc-200 text-zinc-600 hover:bg-zinc-200 hover:border-zinc-300'
                        }`}>
                        <Home className="w-3.5 h-3.5 shrink-0 opacity-60" />
                        <div className="min-w-0">
                          <div className="text-xs font-medium truncate">{p.name}</div>
                          {p.address && <div className="text-[10px] text-zinc-600 truncate">{p.address}</div>}
                        </div>
                      </button>
                    ))}
                    <button
                      onClick={() => setForm(f => ({ ...f, property_id: '' }))}
                      className={`w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                        !form.property_id ? 'bg-sky-50 border-sky-200 text-sky-800' : 'text-zinc-600 border-transparent hover:text-zinc-900'
                      }`}>
                      + Enter address manually
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Address — shown when no property selected or manual entry */}
            <div>
              <label className="block text-xs text-zinc-700 font-medium mb-1">Service Address *</label>
              <input value={form.address || ''} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                placeholder="Full address"
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-blue-700" />
            </div>

            {/* Service type */}
            <div>
              <label className="block text-xs text-zinc-700 font-medium mb-1">Service Type</label>
              <div className="flex gap-2">
                {[['residential','Residential'],['commercial','Commercial'],['str_turnover','STR']].map(([val, label]) => (
                  <button key={val} onClick={() => setForm(f => ({ ...f, job_type: val }))}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${form.job_type === val ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div>
              <label className="block text-xs text-zinc-700 font-medium mb-1">Schedule Title *</label>
              <input value={form.title || ''} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Biweekly Home Clean"
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-blue-700" />
            </div>

            {/* Frequency */}
            <div>
              <label className="block text-xs text-zinc-700 font-medium mb-1">Frequency</label>
              <div className="flex gap-2">
                {['weekly', 'biweekly', 'monthly'].map(f => (
                  <button key={f} onClick={() => setForm(fm => ({ ...fm, frequency: f }))}
                    className={`flex-1 py-1.5 rounded-lg text-xs capitalize transition-colors ${form.frequency === f ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* Day */}
            {form.frequency === 'monthly' ? (
              <div>
                <label className="block text-xs text-zinc-700 font-medium mb-1">Day of Month</label>
                <input type="number" min="1" max="28" value={form.day_of_month || 1}
                  onChange={e => setForm(f => ({ ...f, day_of_month: e.target.value }))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none" />
              </div>
            ) : (
              <div>
                <label className="block text-xs text-zinc-700 font-medium mb-1">Days of Week <span className="text-zinc-600 normal-case font-normal">(select multiple)</span></label>
                <div className="grid grid-cols-7 gap-1">
                  {DAYS_SHORT.map((d, i) => {
                    const selected = (form.days_of_week || []).includes(i)
                    return (
                      <button key={i} onClick={() => setForm(f => {
                        const cur = f.days_of_week || []
                        return { ...f, days_of_week: selected ? cur.filter(x => x !== i) : [...cur, i].sort() }
                      })}
                        className={`py-1.5 rounded-lg text-xs font-medium transition-colors ${selected ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}>
                        {d}
                      </button>
                    )
                  })}
                </div>
                {(form.days_of_week || []).length === 0 && (
                  <p className="text-xs text-red-600 mt-1">Select at least one day</p>
                )}
              </div>
            )}

            {/* Times */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-zinc-700 font-medium mb-1">Start</label>
                <input type="time" value={form.start_time || '09:00'} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-zinc-700 font-medium mb-1">End</label>
                <input type="time" value={form.end_time || '12:00'} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                  className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none" />
              </div>
            </div>

            {/* Generate ahead */}
            <div>
              <label className="block text-xs text-zinc-700 font-medium mb-1">Generate jobs how far ahead?</label>
              <select value={form.generate_weeks_ahead} onChange={e => setForm(f => ({ ...f, generate_weeks_ahead: e.target.value }))}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none">
                {[4, 6, 8, 12, 16, 26].map(w => <option key={w} value={w}>{w} weeks</option>)}
              </select>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs text-zinc-700 font-medium mb-1">Notes</label>
              <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none resize-none" />
            </div>
          </div>

          <div className="p-6 border-t border-zinc-200 space-y-3">
            {saveError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-xs">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {saveError}
              </div>
            )}
            <button onClick={save} disabled={saving || !form.client_id || !form.title || !form.address}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-100 disabled:text-zinc-600 disabled:cursor-not-allowed px-4 py-2.5 rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving...' : selected ? 'Save Changes' : 'Create & Generate Jobs'}
            </button>
          </div>
        </div>
      )}

      <AgentWidget
        pageContext="recurring"
        prompts={[
          'Which clients don\'t have recurring schedules?',
          'Generate all recurring jobs for the next month',
          'Show me my recurring revenue breakdown',
        ]}
      />
    </div>
  )
}

function ScheduleCard({ s, clientName, generating, onEdit, onGenerate, onToggle }) {
  const typeColors = {
    residential: 'text-blue-700 bg-blue-50 border-blue-200',
    commercial:  'text-green-700 bg-green-50 border-green-200',
    str_turnover: 'text-amber-700 bg-amber-50 border-amber-200',
  }
  const freqColor = {
    weekly: 'text-purple-700', biweekly: 'text-blue-500', monthly: 'text-orange-700'
  }

  return (
    <div className="bg-white border border-zinc-200 hover:border-zinc-300 rounded-xl p-4 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-medium text-zinc-900 text-sm">{s.title}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${typeColors[s.job_type] || typeColors.residential}`}>
              {s.job_type === 'str_turnover' ? 'STR' : s.job_type}
            </span>
          </div>
          <div className="text-xs text-zinc-600 mb-1">{clientName(s.client_id)}</div>
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <span className={`font-medium ${freqColor[s.frequency] || 'text-zinc-600'}`}>
              {FREQ_LABELS[s.frequency] || s.frequency}
            </span>
            <span className="text-zinc-600">
              {s.frequency !== 'monthly'
                ? (s.days_of_week?.length > 1
                    ? s.days_of_week.map(d => DAYS_SHORT[d]).join(', ')
                    : `${DAYS_SHORT[s.days_of_week?.[0] ?? s.day_of_week]}s`)
                : `day ${s.day_of_month}`}
            </span>
            <span className="text-zinc-600">{s.start_time}–{s.end_time}</span>
          </div>
          {s.address && (
            <div className="flex items-center gap-1 text-[10px] text-zinc-600 mt-1 truncate">
              <MapPin className="w-2.5 h-2.5 shrink-0" />{s.address}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onGenerate} disabled={!!generating}
            title="Generate upcoming jobs"
            className="flex items-center gap-1 text-xs bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${generating === s.id ? 'animate-spin' : ''}`} />
            Generate
          </button>
          <button onClick={onEdit}
            className="text-xs text-zinc-600 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 px-2.5 py-1.5 rounded-lg transition-colors">
            Edit
          </button>
          <button onClick={onToggle}
            className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors ${s.active ? 'bg-red-50 text-red-700 hover:bg-red-100 border border-red-200' : 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'}`}>
            {s.active ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>
    </div>
  )
}
