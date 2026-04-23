import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, Calendar, MapPin, User, Clock, Plus, AlertCircle,
  Home, Building2, Wind, RefreshCw, Filter, X, Zap
} from 'lucide-react'
import { get, post } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'

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

export default function Schedule() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [calendarMode, setCalendarMode] = useState('month')
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [selectedJob, setSelectedJob] = useState(null)
  const [filterService, setFilterService] = useState('all')
  const [showFilters, setShowFilters] = useState(false)

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

  const unassignedCount = filteredJobs.filter((j) => !j.cleaner_ids?.length).length

  const getServiceIcon = (serviceType) => {
    const key = serviceType?.toLowerCase() || 'residential'
    return SERVICE_CONFIG[key] || SERVICE_CONFIG.residential
  }

  const JobCard = ({ job, compact = false }) => {
    const service = getServiceIcon(job.job_type || job.service_type)
    const ServiceIcon = service.icon
    const status = STATUS_CONFIG[job.status] || STATUS_CONFIG.scheduled
    const hasAssigned = job.cleaner_ids?.length > 0

    if (compact) {
      return (
        <div
          onClick={() => setSelectedJob(job)}
          className="p-2 rounded-lg bg-gradient-to-r from-white to-neutral-50 border border-neutral-200 hover:border-neutral-300 cursor-pointer transition-all hover:shadow-sm group"
        >
          <div className="flex items-start gap-2">
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
        onClick={() => setSelectedJob(job)}
        className="p-4 rounded-xl bg-gradient-to-br from-white to-neutral-50 border border-neutral-200 hover:border-blue-300 cursor-pointer transition-all hover:shadow-lg hover:shadow-blue-100 group"
      >
        <div className="flex items-start justify-between mb-3">
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
          {job.client_name && (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-neutral-900">{job.client_name}</span>
            </div>
          )}
          {job.address && (
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 flex-shrink-0 text-neutral-400" />
              <span className="truncate">{job.address}</span>
            </div>
          )}
          {job.start_time && (
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 flex-shrink-0 text-neutral-400" />
              <span>{job.start_time}{job.end_time ? ` - ${job.end_time}` : ''}</span>
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
          <Zap className="w-3 h-3 text-neutral-400 group-hover:text-blue-500 transition-colors" />
        </div>
      </div>
    )
  }

  return (
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
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2">
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
                    <div className="space-y-4">
                      {filteredJobs.map((job) => (
                        <JobCard key={job.id} job={job} />
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-4">
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

                  {selectedJob && (
                    <GlassCard title="Job Details">
                      <div className="space-y-3 text-sm">
                        {selectedJob.client_name && (
                          <div>
                            <p className="text-xs uppercase font-semibold text-neutral-500">Client</p>
                            <p className="font-semibold text-neutral-900 mt-1">{selectedJob.client_name}</p>
                          </div>
                        )}
                        {selectedJob.address && (
                          <div>
                            <p className="text-xs uppercase font-semibold text-neutral-500">Location</p>
                            <p className="font-semibold text-neutral-900 mt-1">{selectedJob.address}</p>
                          </div>
                        )}
                        {selectedJob.start_time && (
                          <div>
                            <p className="text-xs uppercase font-semibold text-neutral-500">Time</p>
                            <p className="font-semibold text-neutral-900 mt-1">
                              {selectedJob.start_time}{selectedJob.end_time ? ` - ${selectedJob.end_time}` : ''}
                            </p>
                          </div>
                        )}
                        <div>
                          <p className="text-xs uppercase font-semibold text-neutral-500">Status</p>
                          <p className="font-semibold text-neutral-900 mt-1">
                            {STATUS_CONFIG[selectedJob.status]?.label || 'Scheduled'}
                          </p>
                        </div>
                        <Button variant="primary" size="sm" className="w-full mt-2">
                          {selectedJob.cleaner_ids?.length > 0 ? 'Change Cleaners' : 'Assign Cleaner'}
                        </Button>
                      </div>
                    </GlassCard>
                  )}

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
              <div className="grid grid-cols-7 gap-3">
                {getWeekDays().map((date) => {
                  const dayJobs = getJobsForDate(date).filter((job) => {
                    if (filterService === 'all') return true
                    return (job.job_type || job.service_type) === filterService
                  })
                  return (
                    <div key={date.toDateString()} className="rounded-xl bg-white border border-neutral-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                      <div className={`px-4 py-3 ${isToday(date) ? 'bg-blue-50 border-b border-blue-200' : 'bg-neutral-50 border-b border-neutral-200'}`}>
                        <p className={`font-semibold text-sm ${isToday(date) ? 'text-blue-900' : 'text-neutral-900'}`}>
                          {date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })}
                        </p>
                      </div>
                      <div className="p-2 space-y-1 max-h-64 overflow-y-auto">
                        {dayJobs.length === 0 ? (
                          <p className="text-xs text-neutral-400 text-center py-4">No jobs</p>
                        ) : (
                          dayJobs.map((job) => (
                            <JobCard key={job.id} job={job} compact />
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
                              .map((job) => (
                                <div
                                  key={job.id}
                                  className="text-xs bg-blue-100 text-blue-700 rounded px-2 py-1 truncate font-medium hover:bg-blue-200 transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSelectedJob(job)
                                  }}
                                  title={job.title}
                                >
                                  {job.title}
                                </div>
                              ))}
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
    </div>
  )
}
