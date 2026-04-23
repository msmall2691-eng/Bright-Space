import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Calendar, MapPin, User, Clock, Plus, AlertCircle,
  Home, Building2, Wind, RefreshCw, Filter, X, CheckCircle, MessageCircle, Phone,
  Calendar as CalendarIcon, Navigation2, Trash2, Edit2, GripVertical
} from 'lucide-react'
import { get, post, put } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'
import JobEditModal from '../components/JobEditModal'

// Property type colors (STR = amber, residential = blue, commercial = purple)
const PROPERTY_TYPE_CONFIG = {
  str: { color: 'bg-amber-50 border-l-4 border-l-amber-400', badge: 'bg-amber-100 text-amber-700', icon: Wind, label: 'STR' },
  residential: { color: 'bg-blue-50 border-l-4 border-l-blue-400', badge: 'bg-blue-100 text-blue-700', icon: Home, label: 'Residential' },
  commercial: { color: 'bg-purple-50 border-l-4 border-l-purple-400', badge: 'bg-purple-100 text-purple-700', icon: Building2, label: 'Commercial' },
}

const VISIT_STATUS_CONFIG = {
  scheduled: { label: 'Scheduled', dot: 'bg-blue-500', badge: 'info' },
  dispatched: { label: 'Dispatched', dot: 'bg-green-500', badge: 'success' },
  en_route: { label: 'En Route', dot: 'bg-cyan-500', badge: 'info' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-500', badge: 'warning' },
  completed: { label: 'Completed', dot: 'bg-green-600', badge: 'success' },
  no_show: { label: 'No Show', dot: 'bg-red-500', badge: 'danger' },
  cancelled: { label: 'Cancelled', dot: 'bg-neutral-500', badge: 'danger' },
}

const VisitCard = ({ visit, job, property, client, onEdit, onDelete, onStatusChange }) => {
  const propertyType = property?.property_type || 'residential'
  const config = PROPERTY_TYPE_CONFIG[propertyType] || PROPERTY_TYPE_CONFIG.residential
  const PropertyIcon = config.icon
  const statusConfig = VISIT_STATUS_CONFIG[visit.status] || VISIT_STATUS_CONFIG.scheduled

  const hasAssigned = visit.cleaner_ids?.length > 0
  const hasGcal = visit.gcal_event_id ? '✅' : ''
  const hasSMS = job?.sms_reminder_sent ? '📲' : ''
  const isCompleted = visit.status === 'completed'

  return (
    <div
      className={`p-3 sm:p-4 rounded-lg transition-all cursor-pointer hover:shadow-md active:shadow-sm active:bg-opacity-75 ${config.color}`}
      onClick={() => onEdit(visit, job, property)}
    >
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        {/* Left: Icon + Property Type */}
        <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
          <div className={`p-2 rounded flex-shrink-0 ${config.badge}`}>
            <PropertyIcon className="w-4 h-4" />
          </div>

          <div className="flex-1 min-w-0">
            {/* Title + Time */}
            <div className="flex items-baseline gap-2 mb-1">
              <h4 className="text-sm sm:text-base font-semibold text-neutral-900 truncate">{job?.title || `Visit ${visit.id}`}</h4>
              {isCompleted && <CheckCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-green-600 flex-shrink-0" />}
            </div>

            {/* Property + Client */}
            <p className="text-xs text-neutral-600 mb-1.5 sm:mb-2 truncate">
              <span className="truncate">{property?.name && <span>{property.name}</span>}
              {client?.name && <span> • {client.name}</span>}</span>
            </p>

            {/* Time + Address */}
            <div className="space-y-0.5 sm:space-y-1">
              <div className="flex items-center gap-1 sm:gap-1.5 text-xs text-neutral-600">
                <Clock className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                <span className="font-medium">{visit.start_time?.slice(0, 5)}</span>
              </div>
              {property?.address && (
                <div className="flex items-center gap-1 sm:gap-1.5 text-xs text-neutral-600">
                  <MapPin className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                  <span className="truncate">{property.address}</span>
                </div>
              )}
            </div>

            {/* Integration Status Chips */}
            <div className="flex gap-1 mt-1.5 sm:mt-2">
              {hasGcal && <span className="text-xs sm:text-sm" title="GCal synced">{hasGcal}</span>}
              {hasSMS && <span className="text-xs sm:text-sm" title="SMS sent">{hasSMS}</span>}
              <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${statusConfig.dot}`} />
            </div>
          </div>
        </div>

        {/* Right: Status + Cleaner + Actions */}
        <div className="flex flex-col items-end gap-1.5 sm:gap-2 flex-shrink-0">
          <StatusBadge status={statusConfig.badge} className="text-xs sm:text-sm">{statusConfig.label}</StatusBadge>

          {hasAssigned && (
            <div className="flex items-center gap-1 text-xs font-semibold text-neutral-600 bg-green-50 px-2 py-1 rounded">
              <User className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
              <span>{visit.cleaner_ids.length}</span>
            </div>
          )}

          {!hasAssigned && (
            <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-1 rounded">
              ⚠️
            </span>
          )}

          {/* Action Buttons */}
          <div className="flex gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(visit, job, property) }}
              className="p-2 sm:p-1 rounded hover:bg-blue-200 sm:hover:bg-blue-100 text-neutral-400 hover:text-blue-600 transition-colors active:bg-blue-200 -m-1 sm:m-0 min-w-9 min-h-9 sm:min-w-auto sm:min-h-auto flex items-center justify-center"
              title="Edit"
            >
              <Edit2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(visit.id) }}
              className="p-2 sm:p-1 rounded hover:bg-red-200 sm:hover:bg-red-100 text-neutral-400 hover:text-red-600 transition-colors active:bg-red-200 -m-1 sm:m-0 min-w-9 min-h-9 sm:min-w-auto sm:min-h-auto flex items-center justify-center"
              title="Delete"
            >
              <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Schedule() {
  const [searchParams, setSearchParams] = useSearchParams()
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

        const [visitsRes, jobsRes, propsRes, clientsRes] = await Promise.all([
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

  const prevWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() - 7)
    setCurrentDate(d)
  }

  const nextWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() + 7)
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
      <div className="bg-white border-b border-neutral-200 p-3 sm:p-4 sticky top-0 z-10 safe-top">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between gap-2 mb-3 sm:mb-4">
            <h1 className="text-xl sm:text-2xl font-bold text-neutral-900">Schedule</h1>
            <Button variant="primary" size="sm" className="whitespace-nowrap">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline ml-2">New Job</span>
            </Button>
          </div>

          {/* Week Navigation */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mb-0">
            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              <button
                onClick={prevWeek}
                className="p-2 sm:p-2 hover:bg-neutral-100 rounded active:bg-neutral-200 min-w-10 min-h-10 flex items-center justify-center"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <p className="text-xs sm:text-sm font-semibold text-neutral-700 whitespace-nowrap">
                {new Date(currentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
              </p>
              <button
                onClick={nextWeek}
                className="p-2 sm:p-2 hover:bg-neutral-100 rounded active:bg-neutral-200 min-w-10 min-h-10 flex items-center justify-center"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            {/* Filters - Stack on mobile */}
            <div className="flex gap-2 flex-wrap">
              <select
                value={selectedPropertyType}
                onChange={(e) => setSelectedPropertyType(e.target.value)}
                className="px-2 py-2 sm:px-3 sm:py-2 border border-neutral-200 rounded-lg text-xs sm:text-sm bg-white flex-1 min-w-[100px] active:bg-neutral-50"
              >
                <option value="all">All Types</option>
                <option value="residential">Residential</option>
                <option value="str">STR</option>
                <option value="commercial">Commercial</option>
              </select>

              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="px-2 py-2 sm:px-3 sm:py-2 border border-neutral-200 rounded-lg text-xs sm:text-sm bg-white flex-1 min-w-[100px] active:bg-neutral-50"
              >
                <option value="all">All Status</option>
                <option value="scheduled">Scheduled</option>
                <option value="dispatched">Dispatched</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Schedule Grid */}
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
                        />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>

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
