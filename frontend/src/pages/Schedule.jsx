import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Calendar, List, Send, Repeat, Plus, Clock } from 'lucide-react'
import { get } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'

export default function Schedule() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [currentDate, setCurrentDate] = useState(new Date())
  const [viewMode, setViewMode] = useState('calendar') // calendar, list, dispatch, recurring
  const [calendarMode, setCalendarMode] = useState('day') // day, week, month
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedJob, setSelectedJob] = useState(null)

  const activeTab = searchParams.get('tab') || 'calendar'

  useEffect(() => {
    fetchJobs()
  }, [currentDate])

  const fetchJobs = async () => {
    try {
      setLoading(true)
      const response = await get('/api/jobs')
      setJobs(response)
    } catch (err) {
      console.error('Failed to fetch jobs:', err)
    } finally {
      setLoading(false)
    }
  }

  const getDayLabel = (date) => {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  const handlePrevDay = () => {
    setCurrentDate(new Date(currentDate.getTime() - 24 * 60 * 60 * 1000))
  }

  const handleNextDay = () => {
    setCurrentDate(new Date(currentDate.getTime() + 24 * 60 * 60 * 1000))
  }

  const isToday = (date) => {
    const today = new Date()
    return date.toDateString() === today.toDateString()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-neutral-200/40 bg-white/50">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-neutral-900">Schedule</h1>
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
                setViewMode(tab)
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
        {/* Calendar Tab */}
        {(activeTab === null || activeTab === 'calendar') && (
          <div className="p-6 space-y-6">
            {/* View Mode Toggle */}
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
              <div className="flex items-center gap-4">
                <span className={`text-sm font-semibold ${isToday(currentDate) ? 'text-blue-600' : 'text-neutral-600'}`}>
                  {getDayLabel(currentDate)}
                </span>
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
              </div>
            </div>

            {/* Day View */}
            {calendarMode === 'day' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Timeline */}
                <div className="lg:col-span-2">
                  <GlassCard title={`Jobs for ${getDayLabel(currentDate)}`}>
                    {loading ? (
                      <div className="text-center py-8 text-neutral-500">Loading jobs...</div>
                    ) : jobs.length === 0 ? (
                      <div className="text-center py-8 text-neutral-500">No jobs scheduled</div>
                    ) : (
                      <div className="space-y-3">
                        {jobs.map((job) => (
                          <div
                            key={job.id}
                            onClick={() => setSelectedJob(job)}
                            className="p-4 rounded-lg bg-gradient-subtle hover:bg-blue-50 border border-neutral-200/40 cursor-pointer transition-all group"
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex-1">
                                <h4 className="font-semibold text-neutral-900">{job.client_name}</h4>
                                <p className="text-sm text-neutral-600">{job.service_type}</p>
                              </div>
                              {job.status && (
                                <StatusBadge status={job.status === 'scheduled' ? 'info' : 'warning'}>
                                  {job.status}
                                </StatusBadge>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-sm text-neutral-600">
                              {job.scheduled_time && (
                                <div className="flex items-center gap-1">
                                  <Clock className="w-4 h-4" />
                                  {job.scheduled_time}
                                </div>
                              )}
                              {job.property_address && (
                                <div>{job.property_address}</div>
                              )}
                            </div>
                            {!job.cleaner_name && (
                              <div className="mt-3">
                                <button className="text-xs font-medium text-blue-600 hover:text-blue-700">
                                  Assign cleaner
                                </button>
                              </div>
                            )}
                            {job.cleaner_name && (
                              <div className="mt-2 text-xs text-neutral-600">
                                Assigned: <span className="font-semibold">{job.cleaner_name}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </GlassCard>
                </div>

                {/* Quick Actions Sidebar */}
                <div className="space-y-4">
                  <GlassCard title="Quick Actions">
                    <div className="space-y-2">
                      <Button variant="primary" size="md" className="w-full">
                        <Plus className="w-4 h-4 mr-2" />
                        New Job
                      </Button>
                      <Button variant="secondary" size="md" className="w-full">
                        <Repeat className="w-4 h-4 mr-2" />
                        Recurring
                      </Button>
                    </div>
                  </GlassCard>

                  {selectedJob && (
                    <GlassCard title="Job Details">
                      <div className="space-y-3 text-sm">
                        <div>
                          <span className="text-neutral-600">Client</span>
                          <p className="font-semibold text-neutral-900">{selectedJob.client_name}</p>
                        </div>
                        <div>
                          <span className="text-neutral-600">Service</span>
                          <p className="font-semibold text-neutral-900">{selectedJob.service_type}</p>
                        </div>
                        <div>
                          <span className="text-neutral-600">Assigned To</span>
                          <p className="font-semibold text-neutral-900">{selectedJob.cleaner_name || 'Unassigned'}</p>
                        </div>
                        <Button variant="tertiary" size="sm" className="w-full mt-4">
                          Edit Job
                        </Button>
                      </div>
                    </GlassCard>
                  )}
                </div>
              </div>
            )}

            {/* Week & Month placeholders */}
            {calendarMode !== 'day' && (
              <div className="flex items-center justify-center h-96 rounded-lg bg-gradient-subtle border border-neutral-200/40">
                <p className="text-neutral-500">{calendarMode.charAt(0).toUpperCase() + calendarMode.slice(1)} view coming soon</p>
              </div>
            )}
          </div>
        )}

        {/* Dispatch Tab */}
        {activeTab === 'dispatch' && (
          <div className="p-6">
            <GlassCard title="Dispatch">
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
                  <p className="font-semibold mb-1">Connecting to Connecteam...</p>
                  <p>Checking API connection and loading available employees.</p>
                </div>
                <div className="text-center py-8 text-neutral-500">
                  Loading dispatch data...
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
                <div className="text-center py-8 text-neutral-500">
                  Loading recurring schedules...
                </div>
              </div>
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  )
}
