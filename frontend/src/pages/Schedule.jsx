import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Calendar, MapPin, User, Clock, Plus, AlertCircle,
  Home, Building2, Wind, RefreshCw, Filter, X, CheckCircle, MessageCircle, Phone,
  Calendar as CalendarIcon, Navigation2, Trash2, Edit2, GripVertical,
  List, Grid3x3, AlignLeft
} from 'lucide-react'
import { get, post, put } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'
import JobEditModal from '../components/JobEditModal'
import CalendarView from '../components/CalendarView'

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
  cancelled:   { label: 'Cancelled',   dot: 'bg-neutral-500', badge: 'danger',  pillMobile: 'bg-zinc-100 text-zinc-600' },
}

// Single-day mobile-first view. Renders the day's visits as full-width
// cards stacked vertically — no grid, no truncation, no horizontal scroll.
// Tap a card to open the existing detail drawer via onSelect (same handler
// the list view's cards use, so detail-panel behavior is identical).
const AgendaDay = ({ currentDate, visits, jobs, properties, clients, onSelect, isToday }) => {
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
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            {isToday ? 'Today' : ''}
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-neutral-900">
            {new Date(`${currentDate.toISOString().split('T')[0]}T00:00`).toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
          </h2>
          {sorted.length > 0 && (
            <p className="text-[12px] text-neutral-500 mt-0.5">
              {sorted.length} job{sorted.length === 1 ? '' : 's'}
              {completed > 0 && ` · ${completed} done`}
            </p>
          )}
        </div>

        {sorted.length === 0 ? (
          <div className="bg-white border border-neutral-200 rounded-2xl p-10 text-center">
            <Calendar className="w-8 h-8 text-neutral-300 mx-auto mb-2" />
            <p className="text-[13px] text-neutral-500">Nothing scheduled for this day</p>
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
                    className={`group w-full text-left flex items-stretch rounded-2xl border bg-white overflow-hidden transition-all active:scale-[0.99] ${
                      isCancelled
                        ? 'border-neutral-200 opacity-60'
                        : 'border-neutral-200 hover:border-neutral-300 hover:shadow-sm'
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
                        <span className="text-[14px] font-bold text-neutral-900 tabular-nums">
                          {startHHMM || '—'}
                          {endHHMM && <span className="text-neutral-400 font-medium"> – {endHHMM}</span>}
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
                          <div className={`text-[14px] font-semibold text-neutral-900 ${isCancelled ? 'line-through' : ''}`}>
                            {job?.title || `Visit ${v.id}`}
                          </div>
                          {property?.address && (
                            <div className="text-[12px] text-neutral-500 mt-0.5">
                              {property.address}
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Meta footer */}
                      <div className="flex items-center gap-3 mt-2 text-[11px] text-neutral-500">
                        {client?.name && (
                          <span className="truncate">{client.name}</span>
                        )}
                        {cleanerCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <User className="w-3 h-3" /> {cleanerCount} cleaner{cleanerCount === 1 ? '' : 's'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <AlertCircle className="w-3 h-3" /> no cleaner
                          </span>
                        )}
                      </div>
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
        selected ? 'bg-blue-50 ring-1 ring-blue-300' : 'bg-white hover:bg-neutral-50'
      } border border-neutral-200`}
      onClick={() => onEdit(visit, job, property)}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => onToggleSelect?.(visit.id, e)}
        onClick={(e) => e.stopPropagation()}
        className="w-3.5 h-3.5 rounded border-neutral-300 cursor-pointer shrink-0"
        data-testid="visit-row-checkbox"
        aria-label="Select visit"
      />

      {/* Start time — fixed width column */}
      <div className="text-[12px] font-semibold text-neutral-900 tabular-nums w-12 shrink-0">
        {visit.start_time?.slice(0, 5) || '—'}
      </div>

      {/* Property type icon */}
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${config.badge}`}>
        <PropertyIcon className="w-3.5 h-3.5" />
      </div>

      {/* Title + property + client on one stacked line */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-neutral-900 truncate">
            {job?.title || `Visit ${visit.id}`}
          </span>
          {isCompleted && <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0" />}
        </div>
        <div className="text-[11px] text-neutral-500 truncate">
          {property?.name || ''}
          {property?.address && <span className="text-neutral-400"> · {property.address}</span>}
          {client?.name && <span className="text-neutral-400"> · {client.name}</span>}
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
      <span className={`sm:hidden inline-flex items-center text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${statusConfig.pillMobile || 'bg-zinc-100 text-zinc-700'}`}>
        {statusConfig.label}
      </span>

      {/* Action buttons — desktop only. Mobile relies on tap-row → detail
          panel, which has its own edit + delete buttons; doubling them up
          here was eating title space and made delete easy to mis-tap. */}
      <div className="hidden sm:flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(visit, job, property) }}
          className="p-1.5 rounded hover:bg-blue-100 text-neutral-400 hover:text-blue-600"
          title="Edit"
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(visit.id) }}
          className="p-1.5 rounded hover:bg-red-100 text-neutral-400 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

export default function Schedule() {
  const [searchParams, setSearchParams] = useSearchParams()
  // Three view modes today:
  //   agenda — single-day full-width card stack (default on phone, the
  //            screen a cleaner actually uses in the field)
  //   list   — week, grouped by day, dense rows (desktop-leaning)
  //   month  — CalendarView month grid (desktop-leaning)
  // Stored in the URL via ?view= so reload + bookmarks survive. If the
  // URL is unset we default to agenda on phone viewports and list on
  // desktop — see the useEffect below.
  const rawView = searchParams.get('view')
  const viewMode = (rawView === 'agenda' || rawView === 'month' || rawView === 'list')
    ? rawView
    : (typeof window !== 'undefined' && window.innerWidth < 768 ? 'agenda' : 'list')
  const setViewMode = (next) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'list') params.delete('view')
    else params.set('view', next)
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
  const [selectedVisit, setSelectedVisit] = useState(null)
  const [showDetails, setShowDetails] = useState(false)
  const [editingJob, setEditingJob] = useState(null)
  const [showJobModal, setShowJobModal] = useState(false)
  const [coverage, setCoverage] = useState(null)
  const [backfilling, setBackfilling] = useState(false)
  const [selectedVisitIds, setSelectedVisitIds] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [hardDelete, setHardDelete] = useState(false)

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
  }, [currentDate])

  // Filter visits
  const filteredVisits = useMemo(() => {
    if (!visits || visits.length === 0) return []

    return visits
      .filter(v => {
        // Always show visits regardless of enrichment data
        if (selectedStatus !== 'all' && v.status !== selectedStatus) {
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

        return true
      })
      .sort((a, b) => {
        // Sort by date, then by time
        const aDate = new Date(`${a.scheduled_date}T${a.start_time}`)
        const bDate = new Date(`${b.scheduled_date}T${b.start_time}`)
        return aDate - bDate
      })
  }, [visits, selectedPropertyType, selectedStatus, jobs, properties])

  // Group by date
  const visitsByDate = useMemo(() => {
    const grouped = {}
    filteredVisits.forEach(v => {
      if (!grouped[v.scheduled_date]) grouped[v.scheduled_date] = []
      grouped[v.scheduled_date].push(v)
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
      alert('Error deleting visit: ' + err.message)
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
  const selectAllVisible = () => {
    setSelectedVisitIds(prev => {
      const visibleIds = filteredVisits.map(v => v.id)
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
        if (failed > 0) alert(`Cancelled ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      }
      setVisits(visits.filter(v => !selectedVisitIds.has(v.id)))
      clearVisitSelection()
    } catch (e) {
      alert('Bulk action failed: ' + (e?.message || 'unknown'))
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
      // Reload coverage check after backfill
      const newCoverage = await get('/api/visits/admin/coverage-check')
      setCoverage(newCoverage)
    } catch (err) {
      console.error('[Schedule] Backfill failed:', err)
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
        <p className="text-neutral-600">Loading schedule...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-50">
      {/* Header */}
      <div className="bg-white border-b border-neutral-200 sticky top-0 z-10 safe-top">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3">
          {/* Single compact row: title · date nav · view toggle · New Job */}
          <div className="flex items-center gap-2 sm:gap-3">
            <h1 className="text-base sm:text-lg font-bold text-neutral-900 shrink-0">Schedule</h1>

            <div className="hidden sm:flex items-center gap-1 ml-1">
              <button onClick={prevWeek} className="p-1 hover:bg-neutral-100 rounded text-neutral-500" aria-label="Previous week">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-semibold text-neutral-700 whitespace-nowrap min-w-[64px] text-center">
                {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <button onClick={nextWeek} className="p-1 hover:bg-neutral-100 rounded text-neutral-500" aria-label="Next week">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1" />

            {/* Agenda / List / Month view toggle. URL-driven via ?view=.
                Agenda is the mobile default; List/Month are desktop-leaning. */}
            <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5">
              <button
                onClick={() => setViewMode('agenda')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  viewMode === 'agenda' ? 'bg-blue-600 text-white' : 'text-neutral-500 hover:bg-neutral-50'
                }`}
                aria-pressed={viewMode === 'agenda'}
                title="Agenda — single day"
              >
                <AlignLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Agenda</span>
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-neutral-500 hover:bg-neutral-50'
                }`}
                aria-pressed={viewMode === 'list'}
                title="List — week grouped by day"
              >
                <List className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">List</span>
              </button>
              <button
                onClick={() => setViewMode('month')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  viewMode === 'month' ? 'bg-blue-600 text-white' : 'text-neutral-500 hover:bg-neutral-50'
                }`}
                aria-pressed={viewMode === 'month'}
                title="Month — calendar grid"
              >
                <Grid3x3 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Month</span>
              </button>
            </div>

            <Button variant="primary" size="sm" className="whitespace-nowrap">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline ml-1.5">New Job</span>
            </Button>
          </div>

          {/* Mobile-only date nav — desktop has it inline above */}
          <div className="sm:hidden flex items-center gap-2 mt-2">
            <button onClick={prevWeek} className="p-1.5 hover:bg-neutral-100 rounded text-neutral-500">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-neutral-700 flex-1 text-center">
              {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            <button onClick={nextWeek} className="p-1.5 hover:bg-neutral-100 rounded text-neutral-500">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Filter chips — compact, only render when active or hover-reveal */}
          <div className="flex items-center gap-1.5 mt-2 overflow-x-auto scrollbar-thin">
            <select
              value={selectedPropertyType}
              onChange={(e) => setSelectedPropertyType(e.target.value)}
              className={`text-[11px] font-medium px-2 py-1 rounded-full border whitespace-nowrap ${
                selectedPropertyType === 'all'
                  ? 'bg-white text-neutral-500 border-neutral-200'
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
                  ? 'bg-white text-neutral-500 border-neutral-200'
                  : 'bg-blue-50 text-blue-700 border-blue-200'
              }`}
            >
              <option value="all">All status</option>
              <option value="scheduled">Scheduled</option>
              <option value="dispatched">Dispatched</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
            </select>
          </div>
        </div>
      </div>

      {/* Coverage banner — only when actually problematic. A 98%/1-missing
          state was triggering a giant warning that operators dismissed and
          ignored, eating prime header real estate. Now: thin pill, only
          renders if coverage drops below 95% AND >2 jobs are unbacked. */}
      {coverage && !coverage.healthy && coverage.coverage_percent < 95 && coverage.jobs_without_visits > 2 && (
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
      <div className="bg-white border-b border-neutral-200 px-4 py-2">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-neutral-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filteredVisits.length > 0 && filteredVisits.every(v => selectedVisitIds.has(v.id))}
              onChange={selectAllVisible}
              className="w-3.5 h-3.5 rounded border-neutral-300 cursor-pointer"
              data-testid="visits-select-all"
            />
            <span>Select all visible ({filteredVisits.length})</span>
          </label>
          {selectedVisitIds.size > 0 && (
            <div className="flex items-center gap-2" data-testid="visits-bulk-actions">
              <span className="text-xs text-neutral-700 font-medium">{selectedVisitIds.size} selected</span>
              <label className="flex items-center gap-1 text-[11px] text-neutral-600 cursor-pointer select-none" title="Permanently remove from database (vs. mark cancelled)">
                <input type="checkbox" checked={hardDelete}
                  onChange={e => setHardDelete(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-neutral-300 cursor-pointer" />
                Hard delete
              </label>
              <button onClick={clearVisitSelection}
                className="text-xs text-neutral-500 hover:text-neutral-700 px-2 py-1 rounded">
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
      ) : (
      <>
      {/* Schedule Grid (list view) */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto p-3 sm:p-4">
          {Object.keys(visitsByDate).length === 0 ? (
            <GlassCard>
              <div className="text-center py-12">
                <CalendarIcon className="w-12 h-12 text-neutral-300 mx-auto mb-3" />
                <p className="text-neutral-600">No visits scheduled for this week</p>
              </div>
            </GlassCard>
          ) : (
            <div className="space-y-4 sm:space-y-6">
              {Object.entries(visitsByDate)
                .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
                .map(([date, dateVisits]) => (
                  <div key={date}>
                    <h2 className="text-base sm:text-lg font-bold text-neutral-900 mb-2 sm:mb-3">
                      {new Date(`${date}T00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
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
                <h2 className="text-lg sm:text-xl font-bold text-neutral-900">Visit Details</h2>
                <button
                  onClick={() => setShowDetails(false)}
                  className="p-2 sm:p-1 hover:bg-neutral-100 rounded active:bg-neutral-200 -mr-2 sm:mr-0"
                >
                  <X className="w-5 sm:w-5 h-5 sm:h-5" />
                </button>
              </div>

              {/* Details */}
              <div className="space-y-3 sm:space-y-4">
                <div>
                  <p className="text-xs font-semibold text-neutral-600 uppercase mb-1">Date & Time</p>
                  <p className="text-sm sm:text-base text-neutral-900">
                    {new Date(`${selectedVisit.visit.scheduled_date}T${selectedVisit.visit.start_time}`).toLocaleDateString('en-US', {
                      weekday: 'short', month: 'short', day: 'numeric'
                    })} @ {selectedVisit.visit.start_time?.slice(0, 5)}
                  </p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-neutral-600 uppercase mb-1">Property</p>
                  <p className="text-sm sm:text-base text-neutral-900">{selectedVisit.property?.name}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-neutral-600 uppercase mb-1">Address</p>
                  <p className="text-sm sm:text-base text-neutral-900 break-words">{selectedVisit.property?.address}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-neutral-600 uppercase mb-1">Client</p>
                  <p className="text-sm sm:text-base text-neutral-900">{selectedVisit.job?.client_name}</p>
                </div>

                <div>
                  <p className="text-xs font-semibold text-neutral-600 uppercase mb-1">Status</p>
                  <StatusBadge status={VISIT_STATUS_CONFIG[selectedVisit.visit.status]?.badge || 'info'}>
                    {VISIT_STATUS_CONFIG[selectedVisit.visit.status]?.label || selectedVisit.visit.status}
                  </StatusBadge>
                </div>

                {selectedVisit.visit.cleaner_ids?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-neutral-600 uppercase mb-1">Assigned Cleaners</p>
                    <p className="text-sm sm:text-base text-neutral-900">{selectedVisit.visit.cleaner_ids.length} cleaner(s)</p>
                  </div>
                )}

                {selectedVisit.visit.gcal_event_id && (
                  <div>
                    <p className="text-xs font-semibold text-neutral-600 uppercase mb-1">Google Calendar</p>
                    <p className="text-sm text-green-700">✅ Synced</p>
                  </div>
                )}

                <div className="border-t border-neutral-200 pt-4 flex flex-col-reverse sm:flex-row gap-2">
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
      {showJobModal && editingJob && (
        <JobEditModal
          job={editingJob}
          properties={Object.values(properties)}
          clients={Object.values(clients)}
          onClose={() => setShowJobModal(false)}
          onSave={handleJobSave}
        />
      )}
    </div>
  )
}
