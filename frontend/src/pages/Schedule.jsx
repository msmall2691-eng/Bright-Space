import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Calendar, MapPin, User, Users, Clock, Plus, AlertCircle,
  Home, Building2, Wind, RefreshCw, Filter, X, CheckCircle, MessageCircle, Phone,
  Calendar as CalendarIcon, Navigation2, Trash2, Edit2, GripVertical, Zap, LogIn,
  List, Grid3x3, AlignLeft, Wand2, Wrench, ChevronDown
} from 'lucide-react'
import { get, post, put, del } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'
import JobEditModal from '../components/JobEditModal'
import JobCreateModal from '../components/JobCreateModal'
import CalendarView from '../components/CalendarView'
import { useToast } from '../components/ui/Toast'

// Property type colors (STR = amber, residential = blue, commercial = purple)
const PROPERTY_TYPE_CONFIG = {
  str: { color: 'bg-amber-50 border-l-4 border-l-amber-400', badge: 'bg-amber-100 text-amber-700', icon: Wind, label: 'STR' },
  residential: { color: 'bg-blue-50 border-l-4 border-l-blue-400', badge: 'bg-blue-100 text-blue-700', icon: Home, label: 'Residential' },
  commercial: { color: 'bg-purple-50 border-l-4 border-l-purple-400', badge: 'bg-purple-100 text-purple-700', icon: Building2, label: 'Commercial' },
}

const VISIT_STATUS_CONFIG = {
  scheduled:   { label: 'Scheduled',   dot: 'bg-blue-500',    badge: 'info',    pillMobile: 'bg-blue-50 text-blue-700' },
  dispatched:  { label: 'Dispatched',  dot: 'bg-green-500',   badge: 'success', pillMobile: 'bg-green-50 text-green-700' },
  en_route:    { label: 'En Route',    dot: 'bg-cyan-500',    badge: 'info',    pillMobile: 'bg-cyan-50 text-cyan-700' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-500',   badge: 'warning', pillMobile: 'bg-amber-50 text-amber-700' },
  completed:   { label: 'Completed',   dot: 'bg-green-600',   badge: 'success', pillMobile: 'bg-emerald-50 text-emerald-700' },
  no_show:     { label: 'No Show',     dot: 'bg-red-500',     badge: 'danger',  pillMobile: 'bg-red-50 text-red-700' },
  cancelled:   { label: 'Cancelled',   dot: 'bg-ink-3', badge: 'danger',  pillMobile: 'bg-bg-2 text-ink-2' },
}

// Short "Jun 5" style date label for booking check-in/out.
const shortDate = (iso) => {
  if (!iso) return ''
  try {
    return new Date(`${String(iso).slice(0, 10)}T00:00`).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    })
  } catch { return iso }
}

// Airbnb/STR turnover context strip. The /api/jobs response enriches
// str_turnover jobs with `booking` (the reservation that just checked out),
// `next_arrival` (the next reservation), and `is_immediate_turnover` (next
// guest checks in the SAME day → clean fast). Surfacing this on the card is
// what makes the board actually useful for a turnover operation, instead of
// just a generic "Airbnb" tag. Renders nothing for non-turnover jobs.
const TurnoverInfo = ({ job, compact = false }) => {
  if (!job || job.job_type !== 'str_turnover') return null
  const booking = job.booking
  const next = job.next_arrival
  const immediate = job.is_immediate_turnover
  if (!booking && !next && !immediate) return null
  return (
    <div className={`flex items-center gap-2 flex-wrap ${compact ? 'mt-1' : 'mt-2'}`}>
      {immediate && (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700"
          title="Next guest checks in today — same-day turnaround">
          <Zap className="w-2.5 h-2.5" /> Immediate turnover
        </span>
      )}
      {booking?.guest_count > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-3" title="Guests who just checked out">
          <Users className="w-3 h-3" /> {booking.guest_count} guest{booking.guest_count === 1 ? '' : 's'}
        </span>
      )}
      {next?.checkin_date && (
        <span className={`inline-flex items-center gap-1 text-[11px] ${immediate ? 'text-red-600 font-semibold' : 'text-ink-3'}`}
          title="Next guest check-in">
          <LogIn className="w-3 h-3" /> Next: {shortDate(next.checkin_date)}
        </span>
      )}
    </div>
  )
}

// Single-day mobile-first view. Renders the day's visits as full-width
// Embedded Google Calendar view. Shows the real Google Calendar inside the app
// (the same calendar the two-way sync uses). The embed URL comes from Settings
// (an explicit embed URL) or is built from GCAL_RESIDENTIAL_ID server-side.
const GoogleCalendarView = () => {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    get('/api/settings/gcal-embed')
      .then(r => setState({ loading: false, url: r?.embed_url, configured: !!r?.configured }))
      .catch(() => setState({ loading: false, configured: false }))
  }, [])
  if (state.loading) {
    return <div className="flex-1 flex items-center justify-center text-ink-3 text-sm">Loading Google Calendar…</div>
  }
  if (!state.configured || !state.url) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <CalendarIcon className="w-10 h-10 text-ink-3 mx-auto mb-3" />
          <p className="text-sm font-semibold text-ink mb-1">Google Calendar not set up for embedding</p>
          <p className="text-[13px] text-ink-3">
            Add your calendar's embed URL in Settings → Integrations (copy it from Google
            Calendar → Settings → "Integrate calendar"), or set <span className="font-mono">GCAL_RESIDENTIAL_ID</span>.
            The two-way sync still works regardless of this view.
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex-1 bg-panel">
      <iframe
        title="Google Calendar"
        src={state.url}
        className="w-full h-full border-0"
        style={{ minHeight: '70vh' }}
      />
    </div>
  )
}


// cards stacked vertically — no grid, no truncation, no horizontal scroll.
// Tap a card to open the existing detail drawer via onSelect (same handler
// the list view's cards use, so detail-panel behavior is identical).
const AgendaDay = ({ currentDate, visits, jobs, properties, clients, onSelect, isToday, empName }) => {
  // Sort by start_time so the day reads top-down chronologically. Visits
  // without a start_time sink to the bottom.
  const sorted = [...(visits || [])].sort((a, b) => {
    const at = (a.start_time || '99:99').slice(0, 5)
    const bt = (b.start_time || '99:99').slice(0, 5)
    return at.localeCompare(bt)
  })
  const completed = sorted.filter(v => v.status === 'completed').length
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-3 pt-3 pb-6">
        {/* Day header */}
        <div className="mb-3 px-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            {isToday ? 'Today' : ''}
          </div>
          <h2 className="text-xl font-bold text-ink tracking-tight">
            {new Date(`${currentDate.toISOString().split('T')[0]}T00:00`).toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
          </h2>
          {sorted.length > 0 && (
            <p className="text-[12px] text-ink-3 mt-0.5">
              {sorted.length} job{sorted.length === 1 ? '' : 's'}
              {completed > 0 && ` · ${completed} done`}
            </p>
          )}
        </div>

        {sorted.length === 0 ? (
          <div className="bg-panel border border-hairline rounded-2xl p-10 text-center">
            <Calendar className="w-8 h-8 text-ink-3 mx-auto mb-2" />
            <p className="text-[13px] text-ink-3">Nothing scheduled for this day</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {sorted.map((v) => {
              const job = jobs[v.job_id]
              const property = properties[job?.property_id]
              const client = clients[job?.client_id]
              const propertyType = property?.property_type || 'residential'
              const typeCfg = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
              const statusCfg = VISIT_STATUS_CONFIG[v.status] || VISIT_STATUS_CONFIG.scheduled
              const TypeIcon = typeCfg.icon
              const startHHMM = (v.start_time || '').slice(0, 5)
              const endHHMM = (v.end_time || '').slice(0, 5)
              const cleanerCount = v.cleaner_ids?.length || 0
              const isCancelled = v.status === 'cancelled'
              return (
                <li key={v.id}>
                  <button
                    onClick={() => onSelect(v, job, property)}
                    className={`group w-full text-left flex items-stretch rounded-2xl border bg-panel overflow-hidden transition-all active:scale-[0.99] ${
                      isCancelled
                        ? 'border-hairline opacity-60'
                        : 'border-hairline hover:border-hairline hover:shadow-sm'
                    }`}
                  >
                    {/* Color bar — job type signal */}
                    <span className={`w-1.5 shrink-0 ${
                      propertyType === 'str' ? 'bg-amber-400'
                      : propertyType === 'commercial' ? 'bg-purple-400'
                      : 'bg-blue-400'
                    }`} />
                    <div className="flex-1 min-w-0 p-3">
                      {/* Time row */}
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[14px] font-bold text-ink tabular-nums">
                          {startHHMM || '—'}
                          {endHHMM && <span className="text-ink-3 font-medium"> – {endHHMM}</span>}
                        </span>
                        <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${statusCfg.pillMobile}`}>
                          {statusCfg.label}
                        </span>
                      </div>
                      {/* Title row */}
                      <div className="flex items-start gap-2 mb-1">
                        <div className={`shrink-0 mt-0.5 w-6 h-6 rounded-md flex items-center justify-center ${typeCfg.badge}`}>
                          <TypeIcon className="w-3 h-3" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-[14px] font-semibold text-ink ${isCancelled ? 'line-through' : ''}`}>
                              {job?.title || `Visit ${v.id}`}
                            </span>
                            {v.ical_source && (
                              <span
                                className="inline-flex items-center text-[10px] font-semibold px-1.5 py-px rounded bg-amber-50 text-amber-700 capitalize"
                                title={`Auto-scheduled from ${v.ical_source} iCal feed`}
                              >
                                {v.ical_source === 'booking_com' ? 'Booking.com' : v.ical_source}
                              </span>
                            )}
                          </div>
                          {property?.address && (
                            <div className="text-[12px] text-ink-3 mt-0.5">
                              {property.address}
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Meta footer */}
                      <div className="flex items-center gap-3 mt-2 text-[11px] text-ink-3">
                        {client?.name && (
                          <span className="truncate">{client.name}</span>
                        )}
                        {cleanerCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 truncate">
                            <User className="w-3 h-3 shrink-0" />
                            {cleanerCount === 1 && empName
                              ? empName(v.cleaner_ids[0])
                              : `${cleanerCount} cleaners`}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <AlertCircle className="w-3 h-3" /> no cleaner
                          </span>
                        )}
                      </div>
                      {/* Airbnb/STR turnover context (guests, immediate flag, next check-in) */}
                      <TurnoverInfo job={job} />
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}


const VisitCard = ({ visit, job, property, client, onEdit, onDelete, onStatusChange, selected, onToggleSelect }) => {
  const propertyType = property?.property_type || 'residential'
  const config = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
  const PropertyIcon = config.icon
  const statusConfig = VISIT_STATUS_CONFIG[visit.status] || VISIT_STATUS_CONFIG.scheduled

  const hasAssigned = visit.cleaner_ids?.length > 0
  const hasGcal = visit.gcal_event_id ? '✅' : ''
  const hasSMS = job?.sms_reminder_sent ? '📲' : ''
  const isCompleted = visit.status === 'completed'

  // Phase 8 redesign: tighter list-row layout. Single horizontal row with
  // time on the left, title + property + status inline, action overflow on
  // the right. ~30% less vertical space, easier to scan.
  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2 sm:px-4 sm:py-2.5 rounded-lg transition-colors cursor-pointer ${
        selected ? 'bg-blue-50 ring-1 ring-blue-300' : 'bg-panel hover:bg-bg'
      } border border-hairline`}
      onClick={() => onEdit(visit, job, property)}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => onToggleSelect?.(visit.id, e)}
        onClick={(e) => e.stopPropagation()}
        className="w-3.5 h-3.5 rounded border-hairline cursor-pointer shrink-0"
        data-testid="visit-row-checkbox"
        aria-label="Select visit"
      />

      {/* Start time — fixed width column */}
      <div className="text-[12px] font-semibold text-ink tabular-nums w-12 shrink-0">
        {visit.start_time?.slice(0, 5) || '—'}
      </div>

      {/* Property type icon */}
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${config.badge}`}>
        <PropertyIcon className="w-3.5 h-3.5" />
      </div>

      {/* Title + property + client on one stacked line */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-ink truncate">
            {job?.title || `Visit ${visit.id}`}
          </span>
          {isCompleted && <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0" />}
          {job?.is_immediate_turnover && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-px rounded bg-red-100 text-red-700 shrink-0"
              title="Same-day turnaround — next guest checks in today">
              <Zap className="w-2.5 h-2.5" /> Immediate
            </span>
          )}
        </div>
        <div className="text-[11px] text-ink-3 truncate">
          {property?.name || ''}
          {property?.address && <span className="text-ink-3"> · {property.address}</span>}
          {client?.name && <span className="text-ink-3"> · {client.name}</span>}
        </div>
      </div>

      {/* Status pill + cleaner indicator */}
      <div className="hidden sm:flex items-center gap-1.5 shrink-0">
        <StatusBadge status={statusConfig.badge} className="text-[10px]">{statusConfig.label}</StatusBadge>
        {hasAssigned ? (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
            <User className="w-2.5 h-2.5" /> {visit.cleaner_ids.length}
          </span>
        ) : (
          <span className="inline-flex items-center text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
            no cleaner
          </span>
        )}
      </div>

      {/* Mobile-only status pill — replaces the bare dot so the status
          is actually legible at a glance. */}
      <span className={`sm:hidden inline-flex items-center text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${statusConfig.pillMobile || 'bg-bg-2 text-ink-2'}`}>
        {statusConfig.label}
      </span>

      {/* Action buttons — desktop only. Mobile relies on tap-row → detail
          panel, which has its own edit + delete buttons; doubling them up
          here was eating title space and made delete easy to mis-tap. */}
      <div className="hidden sm:flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(visit, job, property) }}
          className="p-1.5 rounded hover:bg-blue-100 text-ink-3 hover:text-blue-600"
          title="Edit"
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(visit.id) }}
          className="p-1.5 rounded hover:bg-red-100 text-ink-3 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

function RecurringCreateModal({ clients, properties, onClose, onCreated }) {
  const [form, setForm] = useState({
    client_id: '',
    property_id: '',
    job_type: 'residential',
    title: '',
    address: '',
    frequency: 'weekly',
    days_of_week: [1],
    day_of_month: 1,
    start_time: '09:00',
    end_time: '11:00',
    generate_weeks_ahead: 8,
    notes: '',
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
    setSaving(true); setError('')
    try {
      const payload = {
        client_id: parseInt(form.client_id),
        property_id: form.property_id ? parseInt(form.property_id) : null,
        job_type: form.job_type,
        title: form.title.trim(),
        address: form.address.trim(),
        frequency: form.frequency,
        interval_weeks: form.frequency === 'biweekly' ? 2 : 1,
        days_of_week: form.frequency === 'monthly' ? [] : form.days_of_week,
        day_of_week: form.days_of_week[0] || 0,
        day_of_month: form.frequency === 'monthly' ? parseInt(form.day_of_month) : null,
        start_time: form.start_time + ':00',
        end_time: form.end_time + ':00',
        generate_weeks_ahead: parseInt(form.generate_weeks_ahead) || 8,
        notes: form.notes || null,
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
        <div className="flex items-center justify-between bg-gradient-to-r from-blue-500 to-blue-600 p-4 sm:p-6 text-white">
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
              <select value={form.frequency} onChange={e => setForm(f => ({...f, frequency: e.target.value}))} className="w-full px-3 py-2 border border-hairline rounded-lg">
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly (every 2 weeks)</option>
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
                    <button key={i} type="button" onClick={() => toggleDay(dayNum)} className={'px-3 py-2 rounded-full border text-sm ' + (sel ? 'bg-blue-600 text-white border-blue-600' : 'bg-panel text-ink-2 border-hairline')}>
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
          <div>
            <label className="block text-sm font-semibold mb-1">Generate weeks ahead</label>
            <input type="number" min="1" max="52" value={form.generate_weeks_ahead} onChange={e => setForm(f => ({...f, generate_weeks_ahead: e.target.value}))} className="w-32 px-3 py-2 border border-hairline rounded-lg" />
            <p className="text-xs text-ink-3 mt-1">How many weeks of future jobs to materialize.</p>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))} rows={2} className="w-full px-3 py-2 border border-hairline rounded-lg" />
          </div>
          {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{error}</div>}
        </div>
        <div className="border-t border-hairline bg-bg p-4 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>{saving ? 'Creating...' : 'Create schedule'}</Button>
        </div>
      </div>
    </div>
  )
}

// Default post-clean checklist. Stored per-visit in checklist_results as
// { task: bool }, so adding/removing tasks here only affects new completions.
const DEFAULT_CHECKLIST = [
  'Kitchen cleaned',
  'Bathrooms cleaned',
  'Floors vacuumed/mopped',
  'Trash removed',
  'Surfaces wiped',
  'Final walkthrough',
]

function CompleteVisitModal({ visit, onClose, onComplete }) {
  // Seed from any prior partial completion so re-opening doesn't lose state.
  const [checks, setChecks] = useState(() => {
    const prior = visit.checklist_results || {}
    const seed = {}
    DEFAULT_CHECKLIST.forEach(t => { seed[t] = !!prior[t] })
    // Preserve any custom tasks that were saved previously.
    Object.keys(prior).forEach(t => { if (!(t in seed)) seed[t] = !!prior[t] })
    return seed
  })
  const [photos, setPhotos] = useState(() => (visit.photos || []).join('\n'))
  const [saving, setSaving] = useState(false)

  const toggle = (task) => setChecks(c => ({ ...c, [task]: !c[task] }))
  const doneCount = Object.values(checks).filter(Boolean).length
  const total = Object.keys(checks).length

  const submit = async () => {
    setSaving(true)
    try {
      const photoUrls = photos.split('\n').map(s => s.trim()).filter(Boolean)
      await onComplete({ checklist_results: checks, photos: photoUrls })
    } catch {
      setSaving(false) // keep modal open on error so work isn't lost
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-panel w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline sticky top-0 bg-panel">
          <h3 className="text-base font-bold text-ink">Complete visit</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-bg-2 text-ink-3">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-2 uppercase">Checklist</p>
              <span className="text-xs font-semibold text-ink-3 tabular-nums">{doneCount}/{total}</span>
            </div>
            <div className="space-y-1.5">
              {Object.keys(checks).map(task => (
                <button
                  key={task}
                  type="button"
                  onClick={() => toggle(task)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                    checks[task]
                      ? 'bg-green-50 border-green-200 text-green-800'
                      : 'bg-panel border-hairline text-ink hover:bg-bg'
                  }`}
                >
                  <span className={`w-4 h-4 rounded flex items-center justify-center text-[11px] ${
                    checks[task] ? 'bg-green-500 text-white' : 'border border-hairline'
                  }`}>{checks[task] ? '✓' : ''}</span>
                  {task}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Photo links (optional)</p>
            <textarea
              value={photos}
              onChange={e => setPhotos(e.target.value)}
              rows={3}
              placeholder="One photo URL per line"
              className="w-full px-3 py-2 border border-hairline rounded-lg text-sm placeholder-ink-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
            />
            <p className="text-[11px] text-ink-3 mt-1">Paste links to photos (e.g. from your phone's cloud). Direct upload coming later.</p>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-hairline flex gap-2 sticky bottom-0 bg-panel">
          <Button variant="secondary" size="sm" className="flex-1" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" className="flex-1" onClick={submit} disabled={saving}>
            <CheckCircle className="w-4 h-4 mr-2" />
            {saving ? 'Saving…' : 'Mark complete'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function AvailabilityPanel() {
  const { toast, ToastContainer } = useToast()
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
    if (!confirm('Remove this time-off entry?')) return
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

      {/* Add form */}
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

      {/* List */}
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
      <ToastContainer />
    </div>
  )
}

function RecurringPanel() {
  const { toast, ToastContainer } = useToast()
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
        get('/api/clients'),
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
        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded">{error}</div>}
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
      <ToastContainer />
    </div>
  )
}

export default function Schedule() {
  const { toast, ToastContainer } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  if (searchParams.get('tab') === 'recurring') return <RecurringPanel />
  if (searchParams.get('tab') === 'availability') return <AvailabilityPanel />
  // Three view modes today:
  //   agenda — single-day full-width card stack (default on phone, the
  //            screen a cleaner actually uses in the field)
  //   list   — week, grouped by day, dense rows (desktop-leaning)
  //   month  — CalendarView month grid (desktop-leaning)
  // Stored in the URL via ?view= so reload + bookmarks survive. If the
  // URL is unset we default to agenda on phone viewports and list on
  // desktop — see the useEffect below.
  const VALID_VIEWS = ['agenda', 'list', 'month', 'google']
  const rawView = searchParams.get('view')
  // Schedule is Google-Calendar only: it shows your embedded Google Calendar and
  // nothing else. The native agenda/list/month views remain reachable via an
  // explicit ?view= (kept for debugging/backfill), but the UI defaults to — and
  // stays on — Google. (Note: we intentionally ignore any old localStorage
  // 'schedule_view' so a previously-stuck Month pick doesn't override this.)
  const viewMode = VALID_VIEWS.includes(rawView) ? rawView : 'google'
  const isGoogleOnly = viewMode === 'google'
  const setViewMode = (next) => {
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params, { replace: true })
  }
  const [visits, setVisits] = useState([])
  const [jobs, setJobs] = useState({})
  const [properties, setProperties] = useState({})
  const [clients, setClients] = useState({})
  const [loading, setLoading] = useState(true)
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selectedPropertyType, setSelectedPropertyType] = useState('all')
  const [selectedStatus, setSelectedStatus] = useState('all')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [selectedVisit, setSelectedVisit] = useState(null)
  const [showDetails, setShowDetails] = useState(false)
  const [completingVisit, setCompletingVisit] = useState(null)
  const [editingJob, setEditingJob] = useState(null)
  const [showJobModal, setShowJobModal] = useState(false)
  const [showNewJob, setShowNewJob] = useState(false)
  const navigate = useNavigate()
  const [coverage, setCoverage] = useState(null)
  const [backfilling, setBackfilling] = useState(false)
  const [selectedVisitIds, setSelectedVisitIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [hardDelete, setHardDelete] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  // Auto-assign turnovers: null | { loading } | { preview:{assigned,unassignable} } | { running }
  const [autoAssign, setAutoAssign] = useState(null)
  // Fix-missing-times tool: null | { loading } | { preview } | { running }
  const [fixTimes, setFixTimes] = useState(null)
  const refresh = () => setRefreshKey(k => k + 1)

  // Connecteam roster, so cleaner IDs can be shown as names. Fails to [] silently.
  const [employees, setEmployees] = useState([])
  useEffect(() => {
    get('/api/dispatch/employees').then(r => setEmployees(Array.isArray(r) ? r : [])).catch(() => {})
  }, [])
  const empName = (id) =>
    employees.find(e => String(e.id) === String(id) || String(e.userId) === String(id))?.name
    || `Cleaner ${id}`

  const dateStr = currentDate.toISOString().split('T')[0]

  // Load visits for current week
  useEffect(() => {
    const loadSchedule = async () => {
      setLoading(true)
      try {
        const startDate = new Date(currentDate)
        startDate.setDate(startDate.getDate() - startDate.getDay())
        const endDate = new Date(startDate)
        endDate.setDate(endDate.getDate() + 6)

        const start = startDate.toISOString().split('T')[0]
        const end = endDate.toISOString().split('T')[0]

        const [visitsRes, jobsRes, propsRes, clientsRes, coverageRes] = await Promise.all([
          get(`/api/visits?scheduled_date_from=${start}&scheduled_date_to=${end}&limit=500`).catch(e => {
            console.error('[Schedule] Visits API error:', e)
            return { items: [] }
          }),
          get('/api/jobs').catch(e => {
            console.error('[Schedule] Jobs API error:', e)
            return []
          }),
          get('/api/properties').catch(e => {
            console.error('[Schedule] Properties API error:', e)
            return []
          }),
          get('/api/clients').catch(e => {
            console.error('[Schedule] Clients API error:', e)
            return []
          }),
          get('/api/visits/admin/coverage-check').catch(() => null),
        ])

        // Index jobs, properties, clients for quick lookup
        const jobsMap = {}
        const propsMap = {}
        const clientsMap = {}

        // Parse responses safely
        const jobsList = Array.isArray(jobsRes) ? jobsRes : (jobsRes?.items || [])
        const propsList = Array.isArray(propsRes) ? propsRes : (propsRes?.items || [])
        const clientsList = Array.isArray(clientsRes) ? clientsRes : (clientsRes?.items || [])

        jobsList.forEach(j => jobsMap[j.id] = j)
        propsList.forEach(p => propsMap[p.id] = p)
        clientsList.forEach(c => clientsMap[c.id] = c)

        // Handle paginated or array response format for visits
        const visitsData = Array.isArray(visitsRes) ? visitsRes : (visitsRes?.items || [])

        console.log('[Schedule] Loaded:', { visitsCount: visitsData.length, jobsCount: jobsList.length, propsCount: propsList.length })

        // FALLBACK: If no visits exist, use jobs as visits (they have the same structure)
        // This handles the case where Visit records haven't been created yet
        const displayData = visitsData.length > 0
          ? visitsData
          : jobsList.map(j => ({
              ...j,
              id: `job-${j.id}`,
              job_id: j.id,
              scheduled_date: j.scheduled_date,
              start_time: j.start_time,
              end_time: j.end_time,
              cleaner_ids: j.cleaner_ids || [],
              status: j.status,
            }))

        setVisits(displayData)
        setJobs(jobsMap)
        setProperties(propsMap)
        setClients(clientsMap)
        setCoverage(coverageRes)
      } catch (err) {
        console.error('[Schedule]', err)
      }
      setLoading(false)
    }

    loadSchedule()
  }, [currentDate, refreshKey])

  // Auto-assign: preview (dry-run) the picks, then confirm to apply.
  const previewAutoAssign = async () => {
    setAutoAssign({ loading: true })
    try {
      const res = await post('/api/jobs/auto-assign-turnovers?dry_run=true', {})
      if (!res?.assigned?.length && !res?.unassignable?.length) {
        setAutoAssign(null)
        toast.info('No unassigned turnovers to fill')
        return
      }
      setAutoAssign({ preview: res })
    } catch (e) {
      setAutoAssign(null)
      toast.error(e.message || 'Could not preview auto-assign')
    }
  }

  const runAutoAssign = async () => {
    setAutoAssign(a => ({ ...a, running: true }))
    try {
      const res = await post('/api/jobs/auto-assign-turnovers', {})
      toast.success(`Assigned ${res?.assigned?.length || 0} turnover${(res?.assigned?.length || 0) === 1 ? '' : 's'}`)
      setAutoAssign(null)
      refresh()
    } catch (e) {
      toast.error(e.message || 'Auto-assign failed')
      setAutoAssign(a => ({ ...a, running: false }))
    }
  }

  // Pull the latest from Google Calendar on demand, so edits you make in Google
  // show up here immediately instead of waiting for the ~10-min scheduler tick.
  const [gcalSyncing, setGcalSyncing] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)  // "Tools" dropdown (declutters the toolbar)
  const syncFromGoogle = async () => {
    if (gcalSyncing) return
    setGcalSyncing(true)
    try {
      const r = await post('/api/jobs/sync-gcal', {})
      const c = r?.jobs_created || 0, u = r?.jobs_updated || 0, x = r?.jobs_cancelled || 0
      const parts = []
      if (c) parts.push(`${c} new`)
      if (u) parts.push(`${u} updated`)
      if (x) parts.push(`${x} cancelled`)
      toast.success(parts.length ? `Synced from Google — ${parts.join(', ')}` : 'Synced from Google — up to date')
      refresh()
    } catch (e) {
      toast.error(e.message || 'Google sync failed')
    }
    setGcalSyncing(false)
  }

  // Push BrightBase jobs that don't yet have a Google event up to Google. Fixes
  // the "blank embed" case where jobs were created before Google was connected
  // (or otherwise never pushed) — they have no calendar event to show.
  const [gcalPushing, setGcalPushing] = useState(false)
  const pushToGoogle = async () => {
    if (gcalPushing) return
    setGcalPushing(true)
    try {
      const r = await post('/api/jobs/push-to-gcal', {})
      toast.success(r?.message || `Pushed ${r?.pushed || 0} job(s) to Google`)
      refresh()
    } catch (e) {
      const msg = e?.message || 'Push failed'
      toast.error(/not configured/i.test(msg)
        ? 'Google Calendar isn’t connected on the server (credentials missing)'
        : msg)
    }
    setGcalPushing(false)
  }

  // Diagnose + fix jobs that render with no time ("– –"). Preview (dry-run)
  // surfaces the diagnostic by_source so you can see the cause in-app, then
  // confirm to backfill sensible default times.
  const previewFixTimes = async () => {
    setFixTimes({ loading: true })
    try {
      const [diag, preview] = await Promise.all([
        get('/api/jobs/diagnostics/missing-times').catch(() => null),
        post('/api/jobs/backfill-missing-times?dry_run=true', {}),
      ])
      if (!preview?.count) {
        setFixTimes(null)
        toast.info('All jobs already have times — no fix needed')
        return
      }
      setFixTimes({ preview, bySource: diag?.summary?.by_source || {} })
    } catch (e) {
      setFixTimes(null)
      toast.error(e.message || 'Could not check job times')
    }
  }

  const runFixTimes = async () => {
    setFixTimes(f => ({ ...f, running: true }))
    try {
      const res = await post('/api/jobs/backfill-missing-times', {})
      toast.success(`Set times on ${res?.count || 0} job${(res?.count || 0) === 1 ? '' : 's'}`)
      setFixTimes(null)
      refresh()
    } catch (e) {
      toast.error(e.message || 'Fix failed')
      setFixTimes(f => ({ ...f, running: false }))
    }
  }

  // Filter visits
  const filteredVisits = useMemo(() => {
    if (!visits || visits.length === 0) return []

    return visits
      .filter(v => {
        // Always show visits regardless of enrichment data
        if (selectedStatus === 'all') {
          // 'all' means all active — hide cancelled (see them via the Cancelled option)
          if (v.status === 'cancelled') return false
        } else if (v.status !== selectedStatus) {
          return false
        }

        // Filter by property type if we have the data
        if (selectedPropertyType !== 'all') {
          const job = jobs[v.job_id]
          const prop = properties[job?.property_id]
          if (prop?.property_type !== selectedPropertyType) {
            return false
          }
        }

        // "Needs assignment" filter: no cleaners on an active visit.
        if (unassignedOnly) {
          const unassigned = (v.cleaner_ids?.length || 0) === 0 &&
            v.status !== 'completed' && v.status !== 'cancelled'
          if (!unassigned) return false
        }

        return true
      })
      .sort((a, b) => {
        // Null/empty dates sort last (Unscheduled bucket).
        const aHasDate = !!(a.scheduled_date && String(a.scheduled_date).trim())
        const bHasDate = !!(b.scheduled_date && String(b.scheduled_date).trim())
        if (!aHasDate && !bHasDate) return 0
        if (!aHasDate) return 1
        if (!bHasDate) return -1
        const aDate = new Date(`${a.scheduled_date}T${a.start_time || '09:00'}`)
        const bDate = new Date(`${b.scheduled_date}T${b.start_time || '09:00'}`)
        return aDate - bDate
      })
  }, [visits, selectedPropertyType, selectedStatus, unassignedOnly, jobs, properties])

  // Count of active visits needing a cleaner — drives the "Needs assignment"
  // badge so the operator can see the queue at a glance regardless of filters.
  const unassignedCount = useMemo(() => (
    (visits || []).filter(v => (v.cleaner_ids?.length || 0) === 0 &&
      v.status !== 'completed' && v.status !== 'cancelled').length
  ), [visits])

  // Group by date - null/empty scheduled_date bucket as "unscheduled" so the
  // UI no longer renders "Invalid Date" headers for jobs without a real date.
  const visitsByDate = useMemo(() => {
    const grouped = {}
    filteredVisits.forEach(v => {
      const key = (v.scheduled_date && String(v.scheduled_date).trim()) ? v.scheduled_date : 'unscheduled'
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(v)
    })
    return grouped
  }, [filteredVisits])

  const handleEdit = (visit, job, property) => {
    setSelectedVisit({ visit, job, property })
    setShowDetails(true)
  }

  const handleDelete = async (visitId) => {
    if (!confirm('Delete this visit?')) return
    try {
      await put(`/api/visits/${visitId}`, { status: 'cancelled' })
      await setVisits(visits.filter(v => v.id !== visitId))
      setShowDetails(false)
    } catch (err) {
      toast.error('Error deleting visit: ' + err.message)
    }
  }

  // Toggle per-job SMS reminder suppression (hybrid model: on by default).
  const handleToggleReminder = async (job, skip) => {
    if (!job?.id) return
    try {
      await put(`/api/jobs/${job.id}/reminder-settings`, { skip_reminder: skip })
      setSelectedVisit(sv => sv ? { ...sv, job: { ...sv.job, skip_sms_reminder: skip } } : sv)
      setJobs(prev => prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id], skip_sms_reminder: skip } } : prev)
      toast.success(skip ? '🔕 Reminder disabled for this booking' : '🔔 Reminder enabled for this booking')
    } catch (err) {
      toast.error('Failed to update reminder: ' + err.message)
    }
  }

  // Persist a visit completion (checklist + photo URLs + status=completed).
  // Uses the existing PUT /api/visits/{id} which already accepts these fields.
  const handleCompleteVisit = async (visitId, { checklist_results, photos }) => {
    try {
      const payload = {
        status: 'completed',
        completed_at: new Date().toISOString(),
        checklist_results,
        photos,
      }
      const updated = await put(`/api/visits/${visitId}`, payload)
      setVisits(visits.map(v => v.id === visitId
        ? { ...v, status: 'completed', checklist_results, photos } : v))
      setCompletingVisit(null)
      setShowDetails(false)
      toast.success('Visit marked complete')
      return updated
    } catch (err) {
      toast.error('Error completing visit: ' + err.message)
      throw err
    }
  }

  const toggleVisitSelect = (id, e) => {
    e?.stopPropagation()
    setSelectedVisitIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  // What the operator can actually SEE right now. In agenda mode we show
  // a single day, so "select all visible" must mean that day only — not
  // the whole filtered week (Codex caught this as a P1 on #92: bulk-cancel
  // from agenda could have hit hidden days otherwise).
  const currentlyVisibleVisits = useMemo(() => {
    if (viewMode === 'agenda') {
      return filteredVisits.filter(v => v.scheduled_date === dateStr)
    }
    return filteredVisits
  }, [viewMode, filteredVisits, dateStr])

  const selectAllVisible = () => {
    setSelectedVisitIds(prev => {
      const visibleIds = currentlyVisibleVisits.map(v => v.id)
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id))
      return allSelected ? new Set() : new Set(visibleIds)
    })
  }
  const clearVisitSelection = () => setSelectedVisitIds(new Set())
  const bulkDeleteVisits = async () => {
    const ids = Array.from(selectedVisitIds)
    if (ids.length === 0) return
    const verb = hardDelete ? 'permanently delete' : 'cancel'
    if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${ids.length} visit${ids.length === 1 ? '' : 's'}? ${hardDelete ? 'This removes them from the database entirely.' : 'They will be marked cancelled (status=cancelled).'} `)) return
    setBulkDeleting(true)
    try {
      if (hardDelete) {
        await post('/api/admin/visits/hard-delete', { ids })
      } else {
        const results = await Promise.allSettled(
          ids.map(id => put(`/api/visits/${id}`, { status: 'cancelled' }))
        )
        const failed = results.filter(r => r.status === 'rejected').length
        if (failed > 0) toast.error(`Cancelled ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      }
      setVisits(visits.filter(v => !selectedVisitIds.has(v.id)))
      clearVisitSelection()
    } catch (e) {
      toast.error('Bulk action failed: ' + (e?.message || 'unknown'))
    } finally {
      setBulkDeleting(false)
    }
  }

  const handleEditJob = (job) => {
    setEditingJob(job)
    setShowJobModal(true)
    setShowDetails(false)
  }

  const handleJobSave = async () => {
    // Reload schedule after job edit
    const startDate = new Date(currentDate)
    startDate.setDate(startDate.getDate() - startDate.getDay())
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + 6)
    const start = startDate.toISOString().split('T')[0]
    const end = endDate.toISOString().split('T')[0]
    const visitsRes = await get(`/api/visits?scheduled_date_from=${start}&scheduled_date_to=${end}&limit=500`)
    const visitsData = visitsRes?.items || visitsRes || []
    setVisits(visitsData)
  }

  const handleBackfill = async () => {
    setBackfilling(true)
    try {
      const result = await post('/api/visits/admin/backfill-visits-from-jobs', {})
      // Reload everything so new visits appear immediately
      const newCoverage = await get('/api/visits/admin/coverage-check')
      setCoverage(newCoverage)
      // Re-run the main schedule loader to pick up new visits
      setCurrentDate(new Date(currentDate))
      toast.success(`Backfill complete: ${result.created} visits created, ${result.skipped} already had visits, ${result.skipped_no_date || 0} skipped (no date).${result.errors?.length ? ` ${result.errors.length} errors.` : ''}`)
    } catch (err) {
      console.error('[Schedule] Backfill failed:', err)
      toast.error('Backfill failed: ' + (err?.message || 'unknown error'))
    } finally {
      setBackfilling(false)
    }
  }

  const prevWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() - (viewMode === 'agenda' ? 1 : 7))
    setCurrentDate(d)
  }

  const nextWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() + (viewMode === 'agenda' ? 1 : 7))
    setCurrentDate(d)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-ink-2">Loading schedule...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-bg">
      {/* Header */}
      <div className="bg-panel border-b border-hairline sticky top-0 z-10 safe-top">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3">
          {/* Single compact row: title · date nav · view toggle · New Job */}
          <div className="flex items-center gap-2 sm:gap-3">
            <h1 className="text-base sm:text-lg font-bold text-ink shrink-0">Schedule</h1>

            {!isGoogleOnly && (
              <div className="hidden sm:flex items-center gap-1 ml-1">
                <button onClick={prevWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Previous week">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-semibold text-ink-2 whitespace-nowrap min-w-[64px] text-center">
                  {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <button onClick={nextWeek} className="p-1 hover:bg-bg-2 rounded text-ink-3" aria-label="Next week">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}

            <div className="flex-1" />

            {/* Power tools tucked into one menu to keep the toolbar clean */}
            <div className="relative">
              <Button onClick={() => setToolsOpen(o => !o)} variant="secondary" size="sm" className="whitespace-nowrap"
                title="Calendar sync & maintenance tools">
                <Wrench className="w-4 h-4" />
                <span className="hidden sm:inline ml-1.5">Tools</span>
                <ChevronDown className="w-3 h-3 ml-0.5" />
              </Button>
              {toolsOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setToolsOpen(false)} />
                  <div className="absolute right-0 mt-1 w-56 bg-panel border border-hairline rounded-xl shadow-lg z-50 py-1">
                    <button onClick={() => { setToolsOpen(false); syncFromGoogle() }} disabled={gcalSyncing}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg disabled:opacity-50 transition-colors">
                      <RefreshCw className={`w-4 h-4 ${gcalSyncing ? 'animate-spin' : ''}`} /> {gcalSyncing ? 'Syncing…' : 'Sync from Google'}
                    </button>
                    <button onClick={() => { setToolsOpen(false); pushToGoogle() }} disabled={gcalPushing}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg disabled:opacity-50 transition-colors">
                      <CalendarIcon className="w-4 h-4" /> {gcalPushing ? 'Pushing…' : 'Push to Google'}
                    </button>
                    <div className="my-1 border-t border-hairline" />
                    <button onClick={() => { setToolsOpen(false); previewAutoAssign() }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                      <Wand2 className="w-4 h-4" /> Auto-assign turnovers
                    </button>
                    <button onClick={() => { setToolsOpen(false); previewFixTimes() }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-ink-2 hover:bg-bg transition-colors">
                      <Clock className="w-4 h-4" /> Fix missing times
                    </button>
                  </div>
                </>
              )}
            </div>

            <Button onClick={() => setShowNewJob(true)} variant="primary" size="sm" className="whitespace-nowrap">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline ml-1.5">New Job</span>
            </Button>
          </div>

          {/* Mobile-only date nav — desktop has it inline above */}
          {!isGoogleOnly && (
          <div className="sm:hidden flex items-center gap-2 mt-2">
            <button onClick={prevWeek} className="p-1.5 hover:bg-bg-2 rounded text-ink-3">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-ink-2 flex-1 text-center">
              {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            <button onClick={nextWeek} className="p-1.5 hover:bg-bg-2 rounded text-ink-3">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          )}

          {/* Filter chips — compact, only render when active or hover-reveal */}
          {!isGoogleOnly && (
          <div className="flex items-center gap-1.5 mt-2 overflow-x-auto scrollbar-thin">
            <select
              value={selectedPropertyType}
              onChange={(e) => setSelectedPropertyType(e.target.value)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap ${
                selectedPropertyType === 'all'
                  ? 'bg-panel text-ink-3 border-hairline'
                  : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}
            >
              <option value="all">All types</option>
              <option value="residential">Residential</option>
              <option value="str">STR</option>
              <option value="commercial">Commercial</option>
            </select>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap ${
                selectedStatus === 'all'
                  ? 'bg-panel text-ink-3 border-hairline'
                  : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}
            >
              <option value="all">All status</option>
              <option value="scheduled">Scheduled</option>
              <option value="dispatched">Dispatched</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button
              type="button"
              onClick={() => setUnassignedOnly(v => !v)}
              className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap transition-colors ${
                unassignedOnly
                  ? 'bg-amber-50 text-amber-700 border-amber-300'
                  : 'bg-panel text-ink-3 border-hairline hover:bg-amber-50/40'
              }`}
              title="Show only visits with no cleaner assigned"
            >
              <AlertCircle className="w-3 h-3" />
              Needs assignment
              {unassignedCount > 0 && (
                <span className="tabular-nums font-bold bg-amber-200 text-amber-800 rounded-full px-1.5">
                  {unassignedCount}
                </span>
              )}
            </button>
          </div>
          )}
        </div>
      </div>

      {/* Coverage banner — only when actually problematic. A 98%/1-missing
          state was triggering a giant warning that operators dismissed and
          ignored, eating prime header real estate. Now: thin pill, only
          renders if coverage drops below 95% AND >2 jobs are unbacked. */}
      {!isGoogleOnly && coverage && !coverage.healthy && coverage.coverage_percent < 95 && coverage.jobs_without_visits > 2 && (
        <div className="max-w-7xl mx-auto px-3 sm:px-4 pt-2">
          <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <p className="text-[11px] text-amber-800 truncate">
                {coverage.jobs_without_visits} jobs without visits ({coverage.coverage_percent}% coverage)
              </p>
            </div>
            <button
              onClick={handleBackfill}
              disabled={backfilling}
              className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 disabled:opacity-50 whitespace-nowrap"
            >
              {backfilling ? 'Backfilling…' : 'Backfill →'}
            </button>
          </div>
        </div>
      )}

      {/* Selection / bulk-action bar */}
      {!isGoogleOnly && (
      <div className="bg-panel border-b border-hairline px-4 py-2">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={currentlyVisibleVisits.length > 0 && currentlyVisibleVisits.every(v => selectedVisitIds.has(v.id))}
              onChange={selectAllVisible}
              className="w-3.5 h-3.5 rounded border-hairline cursor-pointer"
              data-testid="visits-select-all"
            />
            <span>Select all visible ({currentlyVisibleVisits.length})</span>
          </label>
          {selectedVisitIds.size > 0 && (
            <div className="flex items-center gap-2" data-testid="visits-bulk-actions">
              <span className="text-xs text-ink-2 font-medium">{selectedVisitIds.size} selected</span>
              <label className="flex items-center gap-1 text-[11px] text-ink-2 cursor-pointer select-none" title="Permanently remove from database (vs. mark cancelled)">
                <input type="checkbox" checked={hardDelete}
                  onChange={e => setHardDelete(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-hairline cursor-pointer" />
                Hard delete
              </label>
              <button onClick={clearVisitSelection}
                className="text-xs text-ink-3 hover:text-ink-2 px-2 py-1 rounded">
                Clear
              </button>
              <button onClick={bulkDeleteVisits} disabled={bulkDeleting}
                data-testid="visits-bulk-delete"
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
                {bulkDeleting
                  ? 'Working...'
                  : `${hardDelete ? 'Hard delete' : 'Cancel'} ${selectedVisitIds.size}`}
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Render branch: agenda (single-day cards) / list (week, grouped) / month (CalendarView) */}
      {viewMode === 'agenda' ? (
        <AgendaDay
          currentDate={currentDate}
          visits={filteredVisits.filter(v => v.scheduled_date === dateStr)}
          jobs={jobs}
          properties={properties}
          clients={clients}
          onSelect={handleEdit}
          isToday={dateStr === new Date().toISOString().split('T')[0]}
          empName={empName}
        />
      ) : viewMode === 'month' ? (
        <div className="flex-1 overflow-hidden">
          <CalendarView
            onJobClick={(j) => setEditingJob(jobs[j.id] || j)}
            filters={{
              ...(selectedPropertyType !== 'all' ? { job_type: selectedPropertyType === 'str' ? 'str_turnover' : selectedPropertyType } : {}),
              ...(selectedStatus !== 'all' ? { status: selectedStatus } : {}),
            }}
          />
        </div>
      ) : viewMode === 'google' ? (
        <GoogleCalendarView />
      ) : (
      <>
      {/* Schedule Grid (list view) */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto p-3 sm:p-4">
          {Object.keys(visitsByDate).length === 0 ? (
            <GlassCard>
              <div className="text-center py-12">
                <CalendarIcon className="w-12 h-12 text-ink-3 mx-auto mb-3" />
                <p className="text-ink-2">No visits scheduled for this week</p>
              </div>
            </GlassCard>
          ) : (
            <div className="space-y-4 sm:space-y-6">
              {Object.entries(visitsByDate)
                .sort(([dateA], [dateB]) => {
                  // "unscheduled" bucket sorts to the bottom.
                  if (dateA === 'unscheduled') return 1
                  if (dateB === 'unscheduled') return -1
                  return dateA.localeCompare(dateB)
                })
                .map(([date, dateVisits]) => (
                  <div key={date}>
                    <h2 className="text-base sm:text-lg font-bold text-ink mb-2 sm:mb-3">
                      {date === 'unscheduled'
                        ? `Unscheduled — pick a date in Edit Job (${dateVisits.length})`
                        : new Date(`${date}T00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                      }
                    </h2>
                    <div className="space-y-2 sm:space-y-3">
                      {dateVisits.map((visit) => (
                        <VisitCard
                          key={visit.id}
                          visit={visit}
                          job={jobs[visit.job_id]}
                          property={properties[jobs[visit.job_id]?.property_id]}
                          client={clients[jobs[visit.job_id]?.client_id]}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          selected={selectedVisitIds.has(visit.id)}
                          onToggleSelect={toggleVisitSelect}
                        />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

      </>
      )}

      {/* Visit Details Drawer */}
      {showDetails && selectedVisit && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center sm:justify-end">
          <GlassCard className="w-full sm:w-96 h-[95vh] sm:h-auto rounded-t-2xl sm:rounded-lg m-0 sm:m-4 overflow-y-auto safe-bottom">
            <div className="p-4 sm:p-6">
              <div className="flex items-center justify-between mb-4 sm:mb-6">
                <h2 className="text-lg sm:text-xl font-bold text-ink">Visit Details</h2>
                <button
                  onClick={() => setShowDetails(false)}
                  className="p-2 sm:p-1 hover:bg-bg-2 rounded active:bg-bg-2 -mr-2 sm:mr-0"
                >
                  <X className="w-5 sm:w-5 h-5 sm:h-5" />
                </button>
              </div>

              {/* Details */}
              <div className="space-y-3 sm:space-y-4">
                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Date & Time</p>
                  <p className="text-sm sm:text-base text-ink">
                    {selectedVisit.visit.scheduled_date && String(selectedVisit.visit.scheduled_date).trim()
                      ? `${new Date(`${selectedVisit.visit.scheduled_date}T${selectedVisit.visit.start_time || '09:00'}`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} @ ${(selectedVisit.visit.start_time || '09:00').slice(0, 5)}`
                      : 'Unscheduled — pick a date in Edit Job'
                    }
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Property</p>
                  <p className="text-sm sm:text-base text-ink">{selectedVisit.property?.name}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Address</p>
                  <p className="text-sm sm:text-base text-ink break-words">{selectedVisit.property?.address}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Client</p>
                  <p className="text-sm sm:text-base text-ink">{selectedVisit.job?.client_name}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Status</p>
                  <StatusBadge status={VISIT_STATUS_CONFIG[selectedVisit.visit.status]?.badge || 'info'}>
                    {VISIT_STATUS_CONFIG[selectedVisit.visit.status]?.label || selectedVisit.visit.status}
                  </StatusBadge>
                </div>

                {/* Airbnb/STR turnover details */}
                {selectedVisit.job?.job_type === 'str_turnover' &&
                  (selectedVisit.job?.booking || selectedVisit.job?.next_arrival || selectedVisit.job?.is_immediate_turnover) && (
                  <div>
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Turnover</p>
                    {selectedVisit.job?.is_immediate_turnover && (
                      <p className="inline-flex items-center gap-1 text-sm font-semibold text-red-700 mb-1">
                        <Zap className="w-3.5 h-3.5" /> Same-day turnaround — next guest arrives today
                      </p>
                    )}
                    <div className="text-sm text-ink space-y-0.5">
                      {selectedVisit.job?.booking?.source && (
                        <p>Source: <span className="capitalize">{selectedVisit.job.booking.source}</span></p>
                      )}
                      {selectedVisit.job?.booking?.guest_count > 0 && (
                        <p>{selectedVisit.job.booking.guest_count} guest(s) checked out</p>
                      )}
                      {selectedVisit.job?.booking?.checkout_date && (
                        <p>Checkout: {shortDate(selectedVisit.job.booking.checkout_date)}</p>
                      )}
                      {selectedVisit.job?.next_arrival?.checkin_date && (
                        <p>Next check-in: {shortDate(selectedVisit.job.next_arrival.checkin_date)}</p>
                      )}
                    </div>
                  </div>
                )}

                {selectedVisit.visit.cleaner_ids?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Assigned Cleaners</p>
                    <p className="text-sm sm:text-base text-ink">{selectedVisit.visit.cleaner_ids.length} cleaner(s)</p>
                  </div>
                )}

                {selectedVisit.visit.gcal_event_id && (
                  <div>
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Google Calendar</p>
                    <p className="text-sm text-green-700">✅ Synced</p>
                  </div>
                )}

                {/* SMS reminder toggle — reminders are on by default; staff can
                    suppress the 24h text for this booking only. */}
                {selectedVisit.visit.status !== 'completed' && selectedVisit.visit.status !== 'cancelled' && (
                  <div className="border-t border-hairline pt-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-ink-2 uppercase mb-0.5">SMS reminder</p>
                      <p className="text-[12px] text-ink-3">
                        {selectedVisit.job?.skip_sms_reminder
                          ? '🔕 Off — no 24h text for this booking'
                          : '🔔 On — client gets a 24h reminder'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleReminder(selectedVisit.job, !selectedVisit.job?.skip_sms_reminder)}
                      className={`text-[12px] font-semibold px-3 py-1.5 rounded-lg border whitespace-nowrap transition-colors ${
                        selectedVisit.job?.skip_sms_reminder
                          ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                          : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      {selectedVisit.job?.skip_sms_reminder ? 'Enable' : 'Disable'}
                    </button>
                  </div>
                )}

                {/* Completion summary, once a visit has been completed */}
                {selectedVisit.visit.status === 'completed' && (selectedVisit.visit.checklist_results || selectedVisit.visit.photos?.length > 0) && (
                  <div className="border-t border-hairline pt-3">
                    <p className="text-xs font-semibold text-ink-2 uppercase mb-1">Completion</p>
                    {selectedVisit.visit.checklist_results && (
                      <ul className="text-sm text-ink space-y-0.5">
                        {Object.entries(selectedVisit.visit.checklist_results).map(([task, done]) => (
                          <li key={task} className="flex items-center gap-1.5">
                            <span className={done ? 'text-green-600' : 'text-ink-3'}>{done ? '✓' : '○'}</span>
                            {task}
                          </li>
                        ))}
                      </ul>
                    )}
                    {selectedVisit.visit.photos?.length > 0 && (
                      <p className="text-sm text-ink mt-1">{selectedVisit.visit.photos.length} photo(s) attached</p>
                    )}
                  </div>
                )}

                <div className="border-t border-hairline pt-4 flex flex-col-reverse sm:flex-row gap-2">
                  {selectedVisit.visit.status !== 'completed' && selectedVisit.visit.status !== 'cancelled' && (
                    <Button
                      variant="primary"
                      size="sm"
                      className="w-full sm:flex-1"
                      onClick={() => setCompletingVisit(selectedVisit.visit)}
                    >
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Complete
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full sm:flex-1"
                    onClick={() => handleEditJob(selectedVisit.job)}
                  >
                    <Edit2 className="w-4 h-4 mr-2" />
                    Edit Job
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    className="w-full sm:flex-1"
                    onClick={() => handleDelete(selectedVisit.visit.id)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Job Edit Modal */}
      {showJobModal && (
        <JobEditModal
          job={editingJob}
          properties={Object.values(properties)}
          clients={Object.values(clients)}
          onClose={() => setShowJobModal(false)}
          onSave={handleJobSave}
        />
      )}

      {/* Client-first "New Job": pick/create a client + property inline, one-time
          or recurring, residential by default — and it lands on Google Calendar. */}
      {showNewJob && (
        <JobCreateModal
          initialDate={dateStr}
          onClose={() => setShowNewJob(false)}
          onCreated={() => { setShowNewJob(false); handleJobSave() }}
        />
      )}

      {/* Auto-assign turnovers — preview then confirm */}
      {autoAssign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => !autoAssign.running && setAutoAssign(null)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="relative w-full max-w-lg max-h-[85vh] bg-panel rounded-2xl shadow-2xl border border-hairline flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
              <div className="flex items-center gap-2.5 min-w-0">
                <Wand2 className="w-5 h-5 text-blue-600 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-ink">Auto-assign turnovers</h2>
                  <p className="text-[12px] text-ink-3 mt-0.5">Available cleaners, balanced by daily load. Review before applying.</p>
                </div>
              </div>
              <button onClick={() => !autoAssign.running && setAutoAssign(null)} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
              {autoAssign.loading ? (
                <div className="py-12 text-center text-[13px] text-ink-3">Finding available cleaners…</div>
              ) : (
                <>
                  {autoAssign.preview?.assigned?.length > 0 ? (
                    <div className="space-y-1.5">
                      {autoAssign.preview.assigned.map(a => (
                        <div key={a.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium text-ink truncate">{a.title}</div>
                            <div className="text-[11px] text-ink-3">{a.date}</div>
                          </div>
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded shrink-0">
                            <User className="w-3 h-3" /> {empName(a.cleaner_id)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-6 text-center text-[13px] text-ink-3">No turnovers could be auto-assigned.</div>
                  )}
                  {autoAssign.preview?.unassignable?.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                      <div className="text-[11px] font-semibold text-amber-700 mb-1">
                        {autoAssign.preview.unassignable.length} couldn’t be filled (no available cleaner)
                      </div>
                      {autoAssign.preview.unassignable.map(u => (
                        <div key={u.job_id} className="text-[11px] text-amber-700/90">{u.title} · {u.date}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="p-4 border-t border-hairline flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAutoAssign(null)} disabled={autoAssign.running}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={runAutoAssign}
                disabled={autoAssign.loading || autoAssign.running || !autoAssign.preview?.assigned?.length}>
                {autoAssign.running ? 'Assigning…' : `Assign ${autoAssign.preview?.assigned?.length || 0}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Fix missing times — diagnose (shows source) then backfill */}
      {fixTimes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => !fixTimes.running && setFixTimes(null)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="relative w-full max-w-lg max-h-[85vh] bg-panel rounded-2xl shadow-2xl border border-hairline flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between px-5 py-4 border-b border-hairline">
              <div className="flex items-center gap-2.5 min-w-0">
                <Clock className="w-5 h-5 text-blue-600 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-ink">Fix missing job times</h2>
                  <p className="text-[12px] text-ink-3 mt-0.5">Jobs showing "– –" get a sensible default (turnovers → property checkout, others → 9:00). Review before applying.</p>
                </div>
              </div>
              <button onClick={() => !fixTimes.running && setFixTimes(null)} className="p-1 text-ink-3 hover:text-ink-2 shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
              {fixTimes.loading ? (
                <div className="py-12 text-center text-[13px] text-ink-3">Checking job times…</div>
              ) : (
                <>
                  {/* Source breakdown — the in-app diagnostic result */}
                  {fixTimes.bySource && Object.keys(fixTimes.bySource).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(fixTimes.bySource).map(([src, n]) => (
                        <span key={src} className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-bg-2 text-ink-2">
                          {src.replace(/_/g, ' ')}: {n}
                        </span>
                      ))}
                    </div>
                  )}
                  {(fixTimes.preview?.jobs || []).map(j => (
                    <div key={j.job_id} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-bg px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{j.title}</div>
                        <div className="text-[11px] text-ink-3">{j.scheduled_date} · {j.source.replace(/_/g, ' ')}</div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-1 rounded shrink-0 tabular-nums">
                        {j.new_start}–{(j.new_end || '').slice(0, 5)}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="p-4 border-t border-hairline flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setFixTimes(null)} disabled={fixTimes.running}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={runFixTimes}
                disabled={fixTimes.loading || fixTimes.running || !fixTimes.preview?.count}>
                {fixTimes.running ? 'Fixing…' : `Fix ${fixTimes.preview?.count || 0}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Visit Modal */}
      {completingVisit && (
        <CompleteVisitModal
          visit={completingVisit}
          onClose={() => setCompletingVisit(null)}
          onComplete={(payload) => handleCompleteVisit(completingVisit.id, payload)}
        />
      )}
      <ToastContainer />
    </div>
  )
}
