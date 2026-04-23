import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Calendar, MapPin, User, Clock, Plus, AlertCircle,
  Home, Building2, Wind, RefreshCw, Filter, X, Zap, Edit2, Trash2, CheckCircle, GripVertical
} from 'lucide-react'
import { get, post, put } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'
import { DndContext } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const SERVICE_CONFIG = {
  residential: { icon: Home, color: 'bg-blue-100 text-blue-700', border: 'border-blue-200', label: 'Residential' },
  commercial: { icon: Building2, color: 'bg-purple-100 text-purple-700', border: 'border-purple-200', label: 'Commercial' },
  str_turnover: { icon: Wind, color: 'bg-amber-100 text-amber-700', border: 'border-amber-200', label: 'STR Turnover' },
  str: { icon: Wind, color: 'bg-amber-100 text-amber-700', border: 'border-amber-200', label: 'STR' },
}

const STATUS_CONFIG = {
  scheduled: { badge: 'info', label: 'Scheduled', dot: 'bg-blue-500' },
  dispatched: { badge: 'success', label: 'Dispatched', dot: 'bg-green-500' },
  in_progress: { badge: 'warning', label: 'In Progress', dot: 'bg-amber-500' },
  completed: { badge: 'success', label: 'Completed', dot: 'bg-green-500' },
  cancelled: { badge: 'danger', label: 'Cancelled', dot: 'bg-red-500' },
}

const DraggableJobCard = ({ job, isDragging, onEdit, onDelete, compact = false }) => {
  const service = SERVICE_CONFIG[(job.job_type || job.service_type || 'residential').toLowerCase()] || SERVICE_CONFIG.residential
  const ServiceIcon = service.icon
  const status = STATUS_CONFIG[job.status] || STATUS_CONFIG.scheduled
  const hasAssigned = job.cleaner_ids?.length > 0

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: job.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  if (compact) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="p-2 rounded-lg bg-gradient-to-r from-white to-neutral-50 border border-neutral-200 hover:border-neutral-300 cursor-move transition-all hover:shadow-sm group"
      >
        <div className="flex items-start gap-2">
          <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
            <GripVertical className="w-3 h-3 text-neutral-400 mt-1" />
          </div>
          <div className={`p-1.5 rounded ${service.color}`}>
            <ServiceIcon className="w-3 h-3" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-neutral-900 truncate">{job.title}</p>
            <p className="text-xs text-neutral-600 truncate">{job.client_name}</p>
          </div>
          <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${status.dot}`} />
        </div>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="p-4 rounded-xl bg-gradient-to-br from-white to-neutral-50 border border-neutral-200 hover:border-blue-300 cursor-move transition-all hover:shadow-lg hover:shadow-blue-100 group"
    >
      <div className="flex items-start gap-3 mb-3">
        <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing flex-shrink-0">
          <GripVertical className="w-5 h-5 text-neutral-400 mt-0.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-start gap-3 flex-1">
              <div className={`p-2.5 rounded-lg ${service.color}`}>
                <ServiceIcon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-neutral-900">{job.title}</h3>
                <p className="text-sm text-neutral-600">{service.label}</p>
              </div>
            </div>
            <StatusBadge status={status.badge}>{status.label}</StatusBadge>
          </div>

          <div className="space-y-2 text-sm text-neutral-600 mb-3">
            {job.client_name && <p className="font-semibold text-neutral-900">{job.client_name}</p>}
            {job.address && (
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 flex-shrink-0 text-neutral-400" />
                <span className="truncate text-xs">{job.address}</span>
              </div>
            )}
            {job.start_time && (
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 flex-shrink-0 text-neutral-400" />
                <span className="text-xs">{job.start_time}{job.end_time ? ` - ${job.end_time}` : ''}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-neutral-200">
            <div className="flex items-center gap-2">
              {hasAssigned ? (
                <>
                  <User className="w-4 h-4 text-green-600" />
                  <span className="text-xs font-semibold text-green-700">{job.cleaner_ids.length} assigned</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-amber-600" />
                  <span className="text-xs font-semibold text-amber-700">Unassigned</span>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => onEdit(job)}
                className="p-1 rounded hover:bg-blue-50 text-neutral-400 hover:text-blue-600 transition-colors"
                title="Edit"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => onDelete(job.id)}
                className="p-1 rounded hover:bg-red-50 text-neutral-400 hover:text-red-600 transition-colors"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Schedule() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [calendarMode, setCalendarMode] = useState('month')
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [editingJob, setEditingJob] = useState(null)
  const [filterService, setFilterService] = useState('all')
  const [editForm, setEditForm] = useState({
    title: '',
    client_name: '',
    address: '',
    start_time: '',
    end_time: '',
    status: 'scheduled',
  })

  const activeTab = searchParams.get('tab') || 'calendar'

  useEffect(() => {
    fetchJobs()
  }, [])

  const fetchJobs = async () => {
    try {
      setLoading(true)
      const response = await get('/api/jobs')
      setJobs(response || [])
    } catch (err) {
      console.error('Failed to fetch jobs:', err)
      setJobs([])
    } finally {
      setLoading(false)
    }
  }

  const handleEditOpen = (job) => {
    setEditingJob(job)
    setEditForm({
      title: job.title || '',
      client_name: job.client_name || '',
      address: job.address || '',
      start_time: job.start_time || '',
      end_time: job.end_time || '',
      status: job.status || 'scheduled',
    })
  }

  const handleEditSave = async () => {
    try {
      await put(`/api/jobs/${editingJob.id}`, editForm)
      await fetchJobs()
      setEditingJob(null)
    } catch (err) {
      console.error('Failed to update job:', err)
    }
  }

  const handleDeleteJob = async (jobId) => {
    if (confirm('Are you sure you want to delete this job?')) {
      try {
        await post(`/api/jobs/${jobId}/delete`, {})
        await fetchJobs()
      } catch (err) {
        console.error('Failed to delete job:', err)
      }
    }
  }

  const syncGoogleCalendar = async () => {
    setSyncing(true)
    setSyncMessage('')
    try {
      const response = await post('/api/jobs/sync-gcal', {})
      setSyncMessage(`✅ Synced! ${response.synced || 0} jobs from Google Calendar`)
      await fetchJobs()
      setTimeout(() => setSyncMessage(''), 4000)
    } catch (err) {
      setSyncMessage(`❌ ${err.message}`)
      setTimeout(() => setSyncMessage(''), 4000)
    } finally {
      setSyncing(false)
    }
  }

  const handleDragEnd = async (event) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const draggedJob = jobs.find((j) => j.id === active.id)
    if (!draggedJob) return

    console.log(`Dragged job ${active.id} to ${over.id}`)
  }

  const getJobsForDate = (date) => {
    return jobs.filter((job) => {
      if (!job.scheduled_date) return false
      const jobDate = new Date(job.scheduled_date).toDateString()
      return jobDate === date.toDateString()
    })
  }

  const filteredJobs = useMemo(() => {
    const dateJobs = getJobsForDate(currentDate)
    if (filterService === 'all') return dateJobs
    return dateJobs.filter((job) => (job.job_type || job.service_type) === filterService)
  }, [jobs, currentDate, filterService])

  const getDayLabel = (date) => {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  }

  const isToday = (date) => {
    const today = new Date()
    return date.toDateString() === today.toDateString()
  }

  const getDaysInMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay()
  }

  const getMonthDays = () => {
    const days = []
    const firstDay = getFirstDayOfMonth(currentDate)
    const daysInMonth = getDaysInMonth(currentDate)
    for (let i = 0; i < firstDay; i++) days.push(null)
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(new Date(currentDate.getFullYear(), currentDate.getMonth(), i))
    }
    return days
  }

  const getWeekDays = () => {
    const days = []
    const startOfWeek = new Date(currentDate)
    startOfWeek.setDate(currentDate.getDate() - currentDate.getDay())
    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfWeek)
      date.setDate(startOfWeek.getDate() + i)
      days.push(date)
    }
    return days
  }

  const getHourSlots = () => {
    const slots = []
    for (let hour = 8; hour <= 18; hour++) {
      const ampm = hour >= 12 ? 'PM' : 'AM'
      const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
      slots.push({ hour, display: `${displayHour} ${ampm}` })
    }
    return slots
  }

  const unassignedCount = filteredJobs.filter((j) => !j.cleaner_ids?.length).length

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full bg-gradient-to-br from-neutral-50 to-neutral-100">
      {/* Header */}
      <div className="px-6 py-5 bg-white border-b border-neutral-200 sticky top-0 z-20 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-neutral-900">Schedule</h1>
            <p className="text-sm text-neutral-600 mt-1">
              {getDayLabel(currentDate)} · {filteredJobs.length} job{filteredJobs.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={syncGoogleCalendar}
              disabled={syncing}
              title="Sync with Google Calendar"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync'}
            </Button>
            <Button variant="primary" size="md">
              <Plus className="w-4 h-4 mr-2" />
              New Job
            </Button>
          </div>
        </div>

        {syncMessage && (
          <div className={`p-3 rounded-lg text-sm font-medium mb-4 ${
            syncMessage.includes('✅')
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {syncMessage}
          </div>
        )}

        {/* Tabs & Controls */}
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {['day', 'week', 'month'].map((mode) => (
              <button
                key={mode}
                onClick={() => setCalendarMode(mode)}
                className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                  calendarMode === mode
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'bg-white text-neutral-600 border border-neutral-200 hover:border-neutral-300'
                }`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentDate(new Date(currentDate.getTime() - 24 * 60 * 60 * 1000))
              }
              className="p-2 rounded-lg hover:bg-neutral-100 transition-colors"
            >
              <ChevronLeft className="w-5 h-5 text-neutral-600" />
            </button>
            <button
              onClick={() => setCurrentDate(new Date(currentDate.getTime() + 24 * 60 * 60 * 1000))}
              className="p-2 rounded-lg hover:bg-neutral-100 transition-colors"
            >
              <ChevronRight className="w-5 h-5 text-neutral-600" />
            </button>
            {isToday(currentDate) && (
              <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold">Today</span>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {(activeTab === null || activeTab === 'calendar') && (
          <div className="p-6">
            {/* Filters */}
            <div className="mb-6 flex flex-wrap gap-2">
              <button
                onClick={() => setFilterService('all')}
                className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                  filterService === 'all'
                    ? 'bg-neutral-900 text-white'
                    : 'bg-white border border-neutral-200 text-neutral-600 hover:border-neutral-300'
                }`}
              >
                All Services
              </button>
              {Object.entries(SERVICE_CONFIG).map(([key, config]) => {
                const Icon = config.icon
                return (
                  <button
                    key={key}
                    onClick={() => setFilterService(key)}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition-all flex items-center gap-2 ${
                      filterService === key ? config.color : 'bg-white border border-neutral-200 text-neutral-600 hover:border-neutral-300'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {config.label}
                  </button>
                )
              })}
            </div>

            {/* Unassigned Alert */}
            {unassignedCount > 0 && (
              <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-amber-900">
                  <p className="font-semibold">{unassignedCount} job{unassignedCount !== 1 ? 's' : ''} need assignment</p>
                  <p className="text-xs text-amber-700 mt-1">Assign cleaners before dispatch to Google Calendar</p>
                </div>
              </div>
            )}

            {/* Calendar Views */}
            {calendarMode === 'day' && (
              <div className="flex flex-col lg:grid lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-4">
                  {loading ? (
                    <GlassCard>
                      <div className="py-12 text-center text-neutral-500">Loading jobs...</div>
                    </GlassCard>
                  ) : filteredJobs.length === 0 ? (
                    <GlassCard>
                      <div className="py-12 text-center">
                        <Calendar className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                        <p className="text-neutral-500 font-medium">No jobs scheduled</p>
                        <p className="text-sm text-neutral-400 mt-1">for {getDayLabel(currentDate)}</p>
                      </div>
                    </GlassCard>
                  ) : (
                    <>
                      <div className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-2">
                        {filteredJobs.length} Job{filteredJobs.length !== 1 ? 's' : ''} Today
                      </div>
                      <div className="space-y-3">
                        {filteredJobs.map((job) => (
                          <DraggableJobCard
                            key={job.id}
                            job={job}
                            isDragging={false}
                            onEdit={handleEditOpen}
                            onDelete={handleDeleteJob}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="space-y-4 order-first lg:order-last">
                  <GlassCard title="Quick Actions">
                    <div className="space-y-2">
                      <Button variant="primary" size="md" className="w-full">
                        <Plus className="w-4 h-4 mr-2" />
                        New Job
                      </Button>
                      <Button variant="secondary" size="md" className="w-full">
                        <Plus className="w-4 h-4 mr-2" />
                        New Recurring
                      </Button>
                    </div>
                  </GlassCard>

                  <GlassCard title="Summary">
                    <div className="space-y-3 text-sm">
                      <div className="flex justify-between items-center">
                        <span className="text-neutral-600">Total Jobs</span>
                        <span className="font-semibold text-neutral-900 text-lg">{filteredJobs.length}</span>
                      </div>
                      <div className="flex justify-between items-center border-t border-neutral-200 pt-3">
                        <span className="text-neutral-600">Assigned</span>
                        <span className="font-semibold text-green-700">
                          {filteredJobs.filter((j) => j.cleaner_ids?.length).length}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-neutral-600">Unassigned</span>
                        <span className="font-semibold text-amber-700">{unassignedCount}</span>
                      </div>
                    </div>
                  </GlassCard>
                </div>
              </div>
            )}

            {calendarMode === 'week' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
                {getWeekDays().map((date) => {
                  const dayJobs = getJobsForDate(date).filter((job) => {
                    if (filterService === 'all') return true
                    return (job.job_type || job.service_type) === filterService
                  })
                  return (
                    <div key={date.toDateString()} className="rounded-xl bg-white border border-neutral-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                      <div
                        className={`px-4 py-3 cursor-pointer transition-colors ${
                          isToday(date) ? 'bg-blue-50 border-b border-blue-200' : 'bg-neutral-50 border-b border-neutral-200 hover:bg-neutral-100'
                        }`}
                        onClick={() => {
                          setCurrentDate(date)
                          setCalendarMode('day')
                        }}
                      >
                        <p className={`font-semibold text-sm ${isToday(date) ? 'text-blue-900' : 'text-neutral-900'}`}>
                          {date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })}
                        </p>
                      </div>
                      <div className="p-2 space-y-1 max-h-64 overflow-y-auto">
                        {dayJobs.length === 0 ? (
                          <p className="text-xs text-neutral-400 text-center py-4">No jobs</p>
                        ) : (
                          dayJobs.map((job) => (
                            <DraggableJobCard
                              key={job.id}
                              job={job}
                              compact
                              isDragging={false}
                              onEdit={handleEditOpen}
                              onDelete={handleDeleteJob}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {calendarMode === 'month' && (
              <div>
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                    <div key={day} className="text-center font-semibold text-xs text-neutral-600 py-3">
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {getMonthDays().map((date, idx) => (
                    <div
                      key={idx}
                      className={`min-h-28 rounded-lg border transition-all cursor-pointer ${
                        date
                          ? isToday(date)
                            ? 'bg-blue-50 border-blue-300 shadow-md'
                            : 'bg-white border-neutral-200 hover:border-neutral-300 hover:shadow-sm'
                          : 'bg-neutral-50 border-transparent'
                      }`}
                      onClick={() => {
                        if (date) {
                          setCurrentDate(date)
                          setCalendarMode('day')
                        }
                      }}
                    >
                      {date && (
                        <div className="p-2 h-full flex flex-col">
                          <p className="text-xs font-semibold text-neutral-900 mb-2">{date.getDate()}</p>
                          <div className="flex-1 space-y-1 overflow-hidden">
                            {getJobsForDate(date)
                              .filter((job) => {
                                if (filterService === 'all') return true
                                return (job.job_type || job.service_type) === filterService
                              })
                              .slice(0, 3)
                              .map((job) => {
                                const service = SERVICE_CONFIG[(job.job_type || job.service_type || 'residential').toLowerCase()] || SERVICE_CONFIG.residential
                                return (
                                  <div
                                    key={job.id}
                                    className={`text-xs rounded px-2 py-1 truncate font-medium hover:opacity-80 transition-opacity cursor-pointer ${service.color}`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleEditOpen(job)
                                    }}
                                    title={job.title}
                                  >
                                    {job.title}
                                  </div>
                                )
                              })}
                            {getJobsForDate(date).length > 3 && (
                              <p className="text-xs text-neutral-500 px-2 font-medium">
                                +{getJobsForDate(date).length - 3} more
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'dispatch' && (
          <div className="p-6">
            <GlassCard title="Dispatch to Connecteam">
              <div className="text-center py-12 text-neutral-500">Coming soon...</div>
            </GlassCard>
          </div>
        )}

        {activeTab === 'recurring' && (
          <div className="p-6">
            <GlassCard title="Recurring Schedules">
              <div className="text-center py-12 text-neutral-500">Coming soon...</div>
            </GlassCard>
          </div>
        )}

      </div>

      {/* Edit Modal */}
      {editingJob && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-auto">
            <div className="sticky top-0 bg-white border-b border-neutral-200 p-6 flex items-center justify-between">
              <h2 className="text-xl font-bold text-neutral-900">Edit Job</h2>
              <button
                onClick={() => setEditingJob(null)}
                className="p-2 rounded-lg hover:bg-neutral-100 transition-colors"
              >
                <X className="w-5 h-5 text-neutral-600" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-2">Job Title</label>
                <input
                  type="text"
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  className="w-full px-4 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-2">Client Name</label>
                <input
                  type="text"
                  value={editForm.client_name}
                  onChange={(e) => setEditForm({ ...editForm, client_name: e.target.value })}
                  className="w-full px-4 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-2">Address</label>
                <input
                  type="text"
                  value={editForm.address}
                  onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                  className="w-full px-4 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-neutral-700 mb-2">Start Time</label>
                  <input
                    type="time"
                    value={editForm.start_time}
                    onChange={(e) => setEditForm({ ...editForm, start_time: e.target.value })}
                    className="w-full px-4 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-neutral-700 mb-2">End Time</label>
                  <input
                    type="time"
                    value={editForm.end_time}
                    onChange={(e) => setEditForm({ ...editForm, end_time: e.target.value })}
                    className="w-full px-4 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-2">Status</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  className="w-full px-4 py-2 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="scheduled">Scheduled</option>
                  <option value="dispatched">Dispatched</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>

              <div className="flex gap-3 pt-4 border-t border-neutral-200">
                <Button variant="secondary" size="md" className="flex-1" onClick={() => setEditingJob(null)}>
                  Cancel
                </Button>
                <Button variant="primary" size="md" className="flex-1" onClick={handleEditSave}>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Save Changes
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </DndContext>
  )
}
