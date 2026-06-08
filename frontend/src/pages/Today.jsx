import { useState, useEffect, useCallback } from 'react'
import {
  CalendarCheck, RefreshCw, MapPin, Phone, KeyRound, Car, Clock,
  Play, Check, Navigation2, CheckCircle2,
} from 'lucide-react'
import { get, put } from '../api'
import PageHeader from '../components/ui/PageHeader'
import EmptyState from '../components/ui/EmptyState'

// Service-type palette, consistent with the rest of the app (STR = amber,
// residential = blue, commercial = purple).
const TYPE_BAR = {
  str: 'bg-amber-400', str_turnover: 'bg-amber-400',
  residential: 'bg-blue-400', commercial: 'bg-purple-400',
}
const STATUS_PILL = {
  scheduled:   'bg-blue-50 text-blue-700',
  dispatched:  'bg-green-50 text-green-700',
  en_route:    'bg-cyan-50 text-cyan-700',
  in_progress: 'bg-amber-50 text-amber-700',
  completed:   'bg-emerald-50 text-emerald-700',
  no_show:     'bg-red-50 text-red-700',
  cancelled:   'bg-bg-2 text-ink-3',
}
const STATUS_LABEL = {
  scheduled: 'Scheduled', dispatched: 'Dispatched', en_route: 'En route',
  in_progress: 'In progress', completed: 'Completed', no_show: 'No show', cancelled: 'Cancelled',
}

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const hhmm = (t) => (t || '').slice(0, 5)
const mapsHref = (addr) => `https://maps.google.com/?q=${encodeURIComponent(addr || '')}`

function Toast({ msg }) {
  return (
    <div className="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-50 bg-panel border border-hairline text-ink text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2">
      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />{msg}
    </div>
  )
}

export default function Today() {
  const [visits, setVisits] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [toast, setToast] = useState(null)
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 2800) }

  const load = useCallback(() => {
    const t = todayStr()
    setLoading(true)
    get(`/api/visits?scheduled_date_from=${t}&scheduled_date_to=${t}&limit=200`)
      .then(d => {
        const items = Array.isArray(d) ? d : (d?.items || [])
        // Hide cancelled; order by start time.
        const live = items.filter(v => v.status !== 'cancelled')
          .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
        setVisits(live)
      })
      .catch(err => { console.error('[Today]', err); setVisits([]) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const setStatus = async (v, status) => {
    setBusyId(v.id)
    const body = status === 'completed'
      ? { status, completed_at: new Date().toISOString() }
      : { status }
    try {
      await put(`/api/visits/${v.id}`, body)
      setVisits(vs => vs.map(x => x.id === v.id ? { ...x, status } : x))
      showToast(status === 'completed' ? 'Marked complete ✓' : 'Visit started ✓')
    } catch (e) { showToast(e.message || 'Could not update') }
    setBusyId(null)
  }

  const doneCount = visits.filter(v => v.status === 'completed').length
  const subtitle = loading ? 'Loading…'
    : visits.length === 0 ? new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : `${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · ${visits.length} visit${visits.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} done` : ''}`

  return (
    <div className="min-h-full">
      <PageHeader
        title="Today" subtitle={subtitle} icon={CalendarCheck} iconColor="text-blue-500"
        actions={
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 bg-bg-2 hover:bg-hairline text-ink-2 border border-hairline px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> <span className="hidden sm:inline">Refresh</span>
          </button>
        }
      />

      <div className="px-4 sm:px-8 pb-8 max-w-2xl space-y-3">
        {loading && visits.length === 0 && (
          <div className="space-y-3">
            {[0, 1, 2].map(i => <div key={i} className="h-28 rounded-2xl bg-bg-2 animate-pulse" />)}
          </div>
        )}

        {!loading && visits.length === 0 && (
          <EmptyState icon={CheckCircle2} title="Nothing scheduled today"
            description="When visits are booked for today, they'll show up here with directions, codes, and one-tap start/complete." />
        )}

        {visits.map(v => {
          const p = v.property || {}
          const c = v.client || {}
          const bar = TYPE_BAR[p.property_type] || TYPE_BAR[v.job?.job_type] || 'bg-blue-400'
          const phone = c.phone || p.site_contact_phone
          const done = v.status === 'completed'
          return (
            <div key={v.id} className={`flex items-stretch rounded-2xl border border-hairline bg-panel overflow-hidden ${done ? 'opacity-70' : ''}`}>
              <span className={`w-1.5 shrink-0 ${bar}`} />
              <div className="flex-1 min-w-0 p-3.5">
                {/* Time + status */}
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 text-ink">
                    <Clock className="w-4 h-4 text-ink-3 shrink-0" />
                    <span className="text-[15px] font-bold">{hhmm(v.start_time)}{v.end_time ? `–${hhmm(v.end_time)}` : ''}</span>
                  </div>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_PILL[v.status] || STATUS_PILL.scheduled}`}>
                    {STATUS_LABEL[v.status] || v.status}
                  </span>
                </div>

                {/* Who / where */}
                <p className="text-[15px] font-semibold text-ink truncate">{c.name || v.job?.title || `Visit #${v.id}`}</p>
                {(p.name || p.address) && (
                  <p className="text-[13px] text-ink-3 truncate">{p.name || p.address}</p>
                )}

                {/* Access details */}
                {(p.house_code || p.access_notes || p.parking_notes) && (
                  <div className="mt-2 space-y-1">
                    {p.house_code && (
                      <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
                        <KeyRound className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                        <span className="font-semibold">Code {p.house_code}</span>
                      </div>
                    )}
                    {p.access_notes && (
                      <div className="flex items-start gap-1.5 text-[13px] text-ink-2">
                        <MapPin className="w-3.5 h-3.5 text-ink-3 shrink-0 mt-0.5" />
                        <span>{p.access_notes}</span>
                      </div>
                    )}
                    {p.parking_notes && (
                      <div className="flex items-start gap-1.5 text-[13px] text-ink-2">
                        <Car className="w-3.5 h-3.5 text-ink-3 shrink-0 mt-0.5" />
                        <span>{p.parking_notes}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Quick actions: directions + call */}
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {p.address && (
                    <a href={mapsHref(p.address)} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-1.5 rounded-lg bg-bg-2 text-ink-2 hover:bg-hairline transition-colors">
                      <Navigation2 className="w-3.5 h-3.5" /> Directions
                    </a>
                  )}
                  {phone && (
                    <a href={`tel:${phone}`}
                      className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-1.5 rounded-lg bg-bg-2 text-ink-2 hover:bg-hairline transition-colors">
                      <Phone className="w-3.5 h-3.5" /> Call
                    </a>
                  )}
                </div>

                {/* Start / Complete */}
                {v.status !== 'cancelled' && (
                  <div className="mt-3 flex gap-2">
                    {!done && v.status !== 'in_progress' && (
                      <button onClick={() => setStatus(v, 'in_progress')} disabled={busyId === v.id}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors disabled:opacity-50">
                        <Play className="w-4 h-4" /> Start
                      </button>
                    )}
                    {!done && (
                      <button onClick={() => setStatus(v, 'completed')} disabled={busyId === v.id}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-50">
                        <Check className="w-4 h-4" /> Complete
                      </button>
                    )}
                    {done && (
                      <div className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700">
                        <CheckCircle2 className="w-4 h-4" /> Done
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {toast && <Toast msg={toast} />}
    </div>
  )
}
