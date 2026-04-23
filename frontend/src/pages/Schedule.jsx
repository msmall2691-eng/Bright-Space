import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Calendar, MapPin, User, Clock, Plus, AlertCircle, Home, Building2, Wind } from 'lucide-react'
import { get } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'

const SERVICE_ICONS = {
  residential: { icon: Home, color: 'blue', label: 'Residential' },
  commercial: { icon: Building2, color: 'purple', label: 'Commercial' },
  str_turnover: { icon: Wind, color: 'amber', label: 'STR Turnover' },
  str: { icon: Wind, color: 'amber', label: 'STR' },
}

const STATUS_CONFIG = {
  scheduled: { badge: 'info', label: 'Scheduled' },
  dispatched: { badge: 'success', label: 'Dispatched' },
  in_progress: { badge: 'warning', label: 'In Progress' },
  completed: { badge: 'success', label: 'Completed' },
  cancelled: { badge: 'danger', label: 'Cancelled' },
}

export default function Schedule() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [calendarMode, setCalendarMode] = useState('day')
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState(null)
  const [filterService, setFilterService] = useState('all')

  const activeTab = searchParams.get('tab') || 'calendar'

  useEffect(() => {
    fetchJobs()
  }, [currentDate])

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

  const getJobsForDate = (date) => {
    return jobs.filter((job) => {
      if (!job.scheduled_date) return false
      const jobDate = new Date(job.scheduled_date).toDateString()
      return jobDate === date.toDateString()
    })
  }

  const getTodaysJobs = () => {
    const todaysJobs = getJobsForDate(currentDate)
    if (filterService === 'all') return todaysJobs
    return todaysJobs.filter((job) => {
      const serviceType = job.job_type || job.service_type
      return serviceType === filterService
    })
  }

  const getDayLabel = (date) => {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  }

  const isToday = (date) => {
    const today = new Date()
    return date.toDateString() === today.toDateString()
  }

  const handlePrevDay = () => {
    setCurrentDate(new Date(currentDate.getTime() - 24 * 60 * 60 * 1000))
  }

  const handleNextDay = () => {
    setCurrentDate(new Date(currentDate.getTime() + 24 * 60 * 60 * 1000))
  }

  const getServiceIcon = (serviceType) => {
    const key = serviceType?.toLowerCase() || 'residential'
    return SERVICE_ICONS[key] || SERVICE_ICONS.residential
  }

  const getScheduledTime = (job) => {
    if (job.start_time && job.end_time) {
      return `${job.start_time} - ${job.end_time}`
    }
    return job.start_time || ''
  }

  const hasAssignedCleaner = (job) => {
    return job.cleaner_ids?.length > 0
  }

  const JobCard = ({ job }) => {
    const serviceInfo = getServiceIcon(job.job_type || job.service_type)
    const ServiceIcon = serviceInfo.icon
    const statusConfig = STATUS_CONFIG[job.status] || STATUS_CONFIG.scheduled

    return (
      <div
        onClick={() => setSelectedJob(job)}
        className="p-4 rounded-lg bg-gradient-subtle hover:bg-blue-50 border border-neutral-200/40 cursor-pointer transition-all group hover:shadow-md"
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3 flex-1">
            <div className={`p-2 rounded-lg bg-${serviceInfo.color}-100`}>
              <ServiceIcon className={`w-4 h-4 text-${serviceInfo.color}-600`} />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-neutral-900 text-sm">{job.title || job.job_type}</h4>
              <p className="text-xs text-neutral-600">{serviceInfo.label}</p>
            </div>
          </div>
          <StatusBadge status={statusConfig.badge}>
            {statusConfig.label}
          </StatusBadge>
        </div>

        <div className="space-y-2 text-xs text-neutral-600">
          {job.client_name && (
            <div className="flex items-center gap-2">
              <span className="font-semibold">{job.client_name}</span>
            </div>
          )}
          {job.address && (
            <div className="flex items-center gap-2">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{job.address}</span>
            </div>
          )}
          {getScheduledTime(job) && (
            <div className="flex items-center gap-2">
              <Clock className="w-3 h-3 flex-shrink-0" />
              <span>{getScheduledTime(job)}</span>
            </div>
          )}
        </div>

        {!hasAssignedCleaner(job) && (
          <div className="mt-3 pt-3 border-t border-neutral-200/50">
            <button className="text-xs font-semibold text-blue-600 hover:text-blue-700">
              + Assign cleaner
            </button>
          </div>
        )}

        {hasAssignedCleaner(job) && (
          <div className="mt-3 pt-3 border-t border-neutral-200/50 flex items-center gap-2">
            <User className="w-3 h-3 text-green-600" />
            <span className="text-xs font-semibold text-green-700">{job.cleaner_ids.length} cleaner{job.cleaner_ids.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>
    )
  }

  const todaysJobs = getTodaysJobs()
  const unassignedCount = todaysJobs.filter((j) => !hasAssignedCleaner(j)).length

  return (
    <div className="flex flex-col h-full bg-neutral-50">
      {/* Header */}
      <div className="px-6 py-4 border-b border-neutral-200/40 bg-white shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900">Schedule</h1>
            <p className="text-sm text-neutral-600 mt-1">
              {getDayLabel(currentDate)} · {todaysJobs.length} job{todaysJobs.length !== 1 ? 's' : ''}
            </p>
          </div>
          <Button variant="primary" size="md">
            <Plus className="w-4 h-4 mr-2" />
            New Job
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          {['calendar', 'dispatch', 'recurring'].map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setSearchParams(tab === 'calendar' ? {} : { tab })
              }}
              className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                activeTab === tab || (activeTab === null && tab === 'calendar')
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
              }`}
            >
              {tab === 'calendar' && 'Calendar'}
              {tab === 'dispatch' && 'Dispatch'}
              {tab === 'recurring' && 'Recurring'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {(activeTab === null || activeTab === 'calendar') && (
          <div className="p-6 space-y-6">
            {/* Day Navigation */}
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                {['day', 'week', 'month'].map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setCalendarMode(mode)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                      calendarMode === mode
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                    }`}
                  >
                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex gap-2">
                  <button
                    onClick={handlePrevDay}
                    className="p-2 rounded-lg hover:bg-neutral-100 transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5 text-neutral-600" />
                  </button>
                  <button
                    onClick={handleNextDay}
                    className="p-2 rounded-lg hover:bg-neutral-100 transition-colors"
                  >
                    <ChevronRight className="w-5 h-5 text-neutral-600" />
                  </button>
                </div>
                {isToday(currentDate) && (
                  <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold">
                    Today
                  </span>
                )}
              </div>
            </div>

            {calendarMode === 'day' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Jobs Timeline */}
                <div className="lg:col-span-2 space-y-4">
                  {/* Service Filter */}
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => setFilterService('all')}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                        filterService === 'all'
                          ? 'bg-neutral-900 text-white'
                          : 'bg-white border border-neutral-200 text-neutral-600 hover:border-neutral-300'
                      }`}
                    >
                      All Services
                    </button>
                    {Object.entries(SERVICE_ICONS).map(([key, config]) => (
                      <button
                        key={key}
                        onClick={() => setFilterService(key)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1 ${
                          filterService === key
                            ? `bg-${config.color}-600 text-white`
                            : `bg-white border border-neutral-200 text-neutral-600 hover:border-neutral-300`
                        }`}
                      >
                        <config.icon className="w-4 h-4" />
                        {config.label}
                      </button>
                    ))}
                  </div>

                  {/* Jobs List */}
                  {loading ? (
                    <GlassCard>
                      <div className="text-center py-8 text-neutral-500">Loading jobs...</div>
                    </GlassCard>
                  ) : todaysJobs.length === 0 ? (
                    <GlassCard>
                      <div className="text-center py-12">
                        <Calendar className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                        <p className="text-neutral-500 font-medium">No jobs scheduled</p>
                        <p className="text-sm text-neutral-400 mt-1">for {getDayLabel(currentDate)}</p>
                      </div>
                    </GlassCard>
                  ) : (
                    <>
                      {unassignedCount > 0 && (
                        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-3">
                          <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                          <div className="text-sm text-amber-900">
                            <p className="font-semibold">{unassignedCount} job{unassignedCount !== 1 ? 's' : ''} need{unassignedCount !== 1 ? '' : 's'} assignment</p>
                            <p className="text-xs text-amber-700 mt-1">Assign cleaners before dispatch</p>
                          </div>
                        </div>
                      )}
                      <div className="space-y-3">
                        {todaysJobs.map((job) => (
                          <JobCard key={job.id} job={job} />
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Sidebar */}
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
                      <div className="space-y-4 text-sm">
                        {selectedJob.client_name && (
                          <div>
                            <span className="text-neutral-600 text-xs uppercase font-semibold">Client</span>
                            <p className="font-semibold text-neutral-900 mt-1">{selectedJob.client_name}</p>
                          </div>
                        )}
                        {(selectedJob.title || selectedJob.job_type) && (
                          <div>
                            <span className="text-neutral-600 text-xs uppercase font-semibold">Service</span>
                            <p className="font-semibold text-neutral-900 mt-1">{selectedJob.title || selectedJob.job_type}</p>
                          </div>
                        )}
                        {selectedJob.address && (
                          <div>
                            <span className="text-neutral-600 text-xs uppercase font-semibold">Location</span>
                            <p className="font-semibold text-neutral-900 mt-1">{selectedJob.address}</p>
                          </div>
                        )}
                        {getScheduledTime(selectedJob) && (
                          <div>
                            <span className="text-neutral-600 text-xs uppercase font-semibold">Time</span>
                            <p className="font-semibold text-neutral-900 mt-1">{getScheduledTime(selectedJob)}</p>
                          </div>
                        )}
                        <div>
                          <span className="text-neutral-600 text-xs uppercase font-semibold">Assigned To</span>
                          <p className={`font-semibold mt-1 ${hasAssignedCleaner(selectedJob) ? 'text-green-700' : 'text-amber-700'}`}>
                            {hasAssignedCleaner(selectedJob) ? `${selectedJob.cleaner_ids.length} cleaner${selectedJob.cleaner_ids.length !== 1 ? 's' : ''}` : 'Unassigned'}
                          </p>
                        </div>
                        <div className="pt-2 border-t border-neutral-200/50">
                          <Button variant="primary" size="sm" className="w-full">
                            {hasAssignedCleaner(selectedJob) ? 'Change Cleaners' : 'Assign Cleaner'}
                          </Button>
                        </div>
                      </div>
                    </GlassCard>
                  )}

                  <GlassCard title="Summary">
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-neutral-600">Total Jobs</span>
                        <span className="font-semibold text-neutral-900">{todaysJobs.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-neutral-600">Assigned</span>
                        <span className="font-semibold text-green-700">{todaysJobs.filter((j) => hasAssignedCleaner(j)).length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-neutral-600">Unassigned</span>
                        <span className="font-semibold text-amber-700">{unassignedCount}</span>
                      </div>
                    </div>
                  </GlassCard>
                </div>
              </div>
            )}

            {calendarMode !== 'day' && (
              <div className="flex items-center justify-center h-96 rounded-lg bg-white border border-neutral-200">
                <p className="text-neutral-500">Week & Month views coming next</p>
              </div>
            )}
          </div>
        )}

        {/* Dispatch Tab */}
        {activeTab === 'dispatch' && (
          <div className="p-6">
            <GlassCard title="Dispatch to Connecteam">
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
                  <p className="font-semibold mb-1">Setting up Connecteam...</p>
                  <p>Validating API connection and syncing available team members.</p>
                </div>
              </div>
            </GlassCard>
          </div>
        )}

        {/* Recurring Tab */}
        {activeTab === 'recurring' && (
          <div className="p-6">
            <GlassCard title="Recurring Schedules">
              <div className="space-y-4">
                <Button variant="primary" size="md">
                  <Plus className="w-4 h-4 mr-2" />
                  New Recurring Schedule
                </Button>
                <p className="text-center py-8 text-neutral-500">Loading recurring schedules...</p>
              </div>
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  )
}
