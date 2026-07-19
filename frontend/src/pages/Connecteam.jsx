import { useEffect, useState } from 'react'
import {
  Clock, Users, Briefcase, CalendarRange, Search, User, Phone, Mail,
  MapPin, Car, StickyNote, Coffee, Sun, AlertTriangle,
} from 'lucide-react'
import { get } from '../api'
import { PageHeader } from '../components/ui'

// Connecteam data hub — read-only views of everything the Connecteam API
// exposes that's useful day-to-day: the team, jobs crew clock into, the
// upcoming schedule, and detailed timesheet punches.

function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
function isoDaysAhead(n) {
  const d = new Date(); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
const fmtTime = (ts, tz) => {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      ...(tz ? { timeZone: tz } : {}),
    })
  } catch { return new Date(ts * 1000).toLocaleString() }
}

const TABS = [
  { id: 'timesheets', icon: Clock, label: 'Timesheets' },
  { id: 'team', icon: Users, label: 'Team' },
  { id: 'jobs', icon: Briefcase, label: 'Jobs' },
  { id: 'schedule', icon: CalendarRange, label: 'Schedule' },
]

export default function Connecteam() {
  const [tab, setTab] = useState('timesheets')
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Connecteam"
        subtitle="Your crew, jobs, schedule, and detailed timesheets — straight from Connecteam."
        icon={Clock}
        iconColor="blue"
      >
        <div className="flex flex-wrap gap-1 bg-bg-2 p-1 rounded-lg w-fit">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                tab === t.id ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
              }`}>
              <t.icon className="w-4 h-4" />{t.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="px-4 sm:px-6 pb-6">
        {tab === 'timesheets' && <TimesheetsTab />}
        {tab === 'team' && <TeamTab />}
        {tab === 'jobs' && <JobsTab />}
        {tab === 'schedule' && <ScheduleTab />}
      </div>
    </div>
  )
}

function useFetch(url, deps) {
  const [state, setState] = useState({ loading: false, data: null, error: '' })
  const run = () => {
    setState({ loading: true, data: null, error: '' })
    get(url).then(d => setState({ loading: false, data: d, error: '' }))
      .catch(e => setState({ loading: false, data: null, error: String(e.message || e) }))
  }
  return [state, run]
}

function Loading() { return <div className="text-sm text-ink-3 p-6 text-center">Loading…</div> }
function ErrorBox({ msg }) {
  return <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl p-4">{msg}</div>
}
function Empty({ msg }) {
  return <div className="text-sm text-ink-3 bg-panel border border-hairline rounded-xl p-6 text-center">{msg}</div>
}

// ── Timesheets (detailed) ──────────────────────────────────────────────────
function TimesheetsTab() {
  const [start, setStart] = useState(isoDaysAgo(14))
  const [end, setEnd] = useState(isoDaysAgo(0))
  const [state, run] = useFetch(`/api/connecteam/timesheets-detailed?start_date=${start}&end_date=${end}`)
  const [open, setOpen] = useState({})

  return (
    <div className="space-y-4">
      <DateBar start={start} end={end} setStart={setStart} setEnd={setEnd} onGo={run} loading={state.loading} />
      {state.error && <ErrorBox msg={state.error} />}
      {state.loading && <Loading />}
      {state.data && (
        state.data.employees.length === 0 ? <Empty msg="No punches in this period." /> : (
          <div className="space-y-3">
            {state.data.employees.map(emp => (
              <div key={emp.employee_id} className="bg-panel border border-hairline rounded-xl overflow-hidden">
                <button onClick={() => setOpen(o => ({ ...o, [emp.employee_id]: !o[emp.employee_id] }))}
                  className="w-full flex items-center justify-between p-4 hover:bg-bg-2/40 transition-colors">
                  <span className="flex items-center gap-2 font-medium text-ink">
                    <User className="w-4 h-4 text-ink-3" />{emp.name}
                  </span>
                  <span className="text-sm"><b className="text-ink">{emp.total_hours}h</b> <span className="text-ink-3">· {emp.shifts.length} shifts</span></span>
                </button>
                <div className="border-t border-hairline divide-y divide-hairline/60">
                  {emp.shifts.map((s, i) => (
                    <div key={i} className="px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="text-ink-2">{fmtTime(s.start, s.timezone)} → {fmtTime(s.end, s.timezone)}</div>
                        <div className="flex items-center gap-3 text-ink-2">
                          {s.job && <span className="flex items-center gap-1"><Briefcase className="w-3.5 h-3.5 text-ink-3" />{s.job}</span>}
                          <span className="font-semibold text-ink">{s.hours}h</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 flex-wrap mt-1 text-xs text-ink-3">
                        {s.breaks_minutes > 0 && <span className="flex items-center gap-1"><Coffee className="w-3 h-3" />{s.breaks_minutes}m break</span>}
                        {s.miles > 0 && <span className="flex items-center gap-1"><Car className="w-3 h-3" />{s.miles} mi</span>}
                        {s.start_location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{s.start_location}</span>}
                        {s.auto_clock_out && <span className="text-amber-400">auto clock-out</span>}
                      </div>
                      {(s.note || s.manager_note) && (
                        <div className="mt-1 text-xs text-ink-3 flex items-start gap-1">
                          <StickyNote className="w-3 h-3 mt-0.5 shrink-0" />
                          <span>{[s.note, s.manager_note].filter(Boolean).join(' · ')}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}
      {!state.data && !state.loading && !state.error && <Empty msg="Pick a range and hit Pull." />}
    </div>
  )
}

// ── Team directory ─────────────────────────────────────────────────────────
function TeamTab() {
  const [state, run] = useFetch('/api/connecteam/team')
  useEffect(() => { run() }, [])
  if (state.loading) return <Loading />
  if (state.error) return <ErrorBox msg={state.error} />
  if (!state.data) return <Loading />
  const members = state.data.members || []
  if (members.length === 0) return <Empty msg="No team members found." />
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {members.map(m => (
        <div key={m.id} className={`bg-panel border border-hairline rounded-xl p-4 ${m.archived ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2 font-medium text-ink">
            <User className="w-4 h-4 text-ink-3 shrink-0" />{m.name}
            {m.archived && <span className="text-xs text-ink-3">(archived)</span>}
          </div>
          {m.role && <div className="text-xs text-ink-3 mt-0.5 ml-6 capitalize">{m.role}</div>}
          <div className="mt-2 space-y-1 text-sm">
            {m.phone && <a href={`tel:${m.phone}`} className="flex items-center gap-1.5 text-ink-2 hover:text-ink"><Phone className="w-3.5 h-3.5 text-ink-3" />{m.phone}</a>}
            {m.email && <a href={`mailto:${m.email}`} className="flex items-center gap-1.5 text-ink-2 hover:text-ink truncate"><Mail className="w-3.5 h-3.5 text-ink-3 shrink-0" /><span className="truncate">{m.email}</span></a>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Jobs ───────────────────────────────────────────────────────────────────
function JobsTab() {
  const [state, run] = useFetch('/api/connecteam/jobs')
  useEffect(() => { run() }, [])
  if (state.loading) return <Loading />
  if (state.error) return <ErrorBox msg={state.error} />
  if (!state.data) return <Loading />
  const jobs = state.data.jobs || []
  if (jobs.length === 0) return <Empty msg="No jobs found in Connecteam." />
  return (
    <div className="bg-panel border border-hairline rounded-xl divide-y divide-hairline/60">
      {jobs.map(j => (
        <div key={j.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
          <span className="flex items-center gap-2 text-ink"><Briefcase className="w-4 h-4 text-ink-3" />{j.name}</span>
          {j.code && <span className="text-xs text-ink-3 font-mono">{j.code}</span>}
        </div>
      ))}
    </div>
  )
}

// ── Schedule ───────────────────────────────────────────────────────────────
function ScheduleTab() {
  const [start, setStart] = useState(isoDaysAgo(0))
  const [end, setEnd] = useState(isoDaysAhead(14))
  const [state, run] = useFetch(`/api/connecteam/schedule?start_date=${start}&end_date=${end}`)
  return (
    <div className="space-y-4">
      <DateBar start={start} end={end} setStart={setStart} setEnd={setEnd} onGo={run} loading={state.loading} />
      {state.error && <ErrorBox msg={state.error} />}
      {state.loading && <Loading />}
      {state.data && (
        state.data.shifts.length === 0 ? <Empty msg="No shifts scheduled in this range." /> : (
          <div className="bg-panel border border-hairline rounded-xl divide-y divide-hairline/60">
            {state.data.shifts.map(s => (
              <div key={s.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-medium text-ink">{s.title || s.job_name || 'Shift'}</span>
                  <span className="text-ink-2">{fmtTime(s.startTimestamp)} → {fmtTime(s.endTimestamp)}</span>
                </div>
                <div className="flex items-center gap-3 flex-wrap mt-1 text-xs text-ink-3">
                  {s.isOpenShift ? <span className="text-amber-400">Open shift</span>
                    : s.assigned_names?.length > 0 ? <span className="flex items-center gap-1"><Users className="w-3 h-3" />{s.assigned_names.join(', ')}</span>
                    : <span>Unassigned</span>}
                  {s.address && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{s.address}</span>}
                  {!s.isPublished && <span className="text-ink-3">(draft)</span>}
                </div>
              </div>
            ))}
          </div>
        )
      )}
      {!state.data && !state.loading && !state.error && <Empty msg="Pick a range and hit Pull." />}
    </div>
  )
}

function DateBar({ start, end, setStart, setEnd, onGo, loading }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label className="block text-xs text-ink-3 mb-1">Start</label>
        <input type="date" value={start} onChange={e => setStart(e.target.value)}
          className="bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
      </div>
      <div>
        <label className="block text-xs text-ink-3 mb-1">End</label>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)}
          className="bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
      </div>
      <button onClick={onGo} disabled={loading}
        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
        <Search className="w-4 h-4" />{loading ? 'Loading…' : 'Pull'}
      </button>
    </div>
  )
}
