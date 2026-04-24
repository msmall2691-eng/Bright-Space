import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ChevronLeft, Plus, Edit2, Trash2, MoreVertical, MapPin, Home, Building2, Wind,
  Calendar, Clock, Users, CheckCircle, AlertCircle, Navigation2
} from 'lucide-react'
import { get, patch, post } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'

const PROPERTY_TYPE_CONFIG = {
  residential: { label: 'Residential', badge: 'bg-blue-100 text-blue-700', icon: Home },
  commercial: { label: 'Commercial', badge: 'bg-purple-100 text-purple-700', icon: Building2 },
  str: { label: 'STR', badge: 'bg-amber-100 text-amber-700', icon: Wind },
}

const JOB_STATUS_CONFIG = {
  scheduled: { label: 'Scheduled', dot: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700' },
  dispatched: { label: 'Dispatched', dot: 'bg-green-500', badge: 'bg-green-100 text-green-700' },
  in_progress: { label: 'In Progress', dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Completed', dot: 'bg-green-600', badge: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Cancelled', dot: 'bg-red-500', badge: 'bg-red-100 text-red-700' },
}

export default function PropertyDetail() {
  const { propertyId } = useParams()
  const navigate = useNavigate()
  
  const [property, setProperty] = useState(null)
  const [jobs, setJobs] = useState([])
  const [visits, setVisits] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedJob, setSelectedJob] = useState(null)
  const [showJobDetails, setShowJobDetails] = useState(false)

  // Load property, jobs, and visits
  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        const [propRes, jobsRes, visitsRes] = await Promise.all([
          get(`/api/properties/${propertyId}`).catch(() => null),
          get(`/api/jobs?property_id=${propertyId}`).catch(() => []),
          get(`/api/visits?limit=500`).catch(() => []),
        ])

        setProperty(propRes)
        setJobs(jobsRes || [])
        setVisits(visitsRes || [])
      } catch (err) {
        console.error('[PropertyDetail]', err)
        setError('Failed to load property details')
      }
      setLoading(false)
    }

    if (propertyId) loadData()
  }, [propertyId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-neutral-50">
        <p className="text-neutral-600">Loading property...</p>
      </div>
    )
  }

  if (!property) {
    return (
      <div className="flex items-center justify-center h-screen bg-neutral-50">
        <GlassCard>
          <div className="text-center py-12">
            <AlertCircle className="w-12 h-12 text-neutral-300 mx-auto mb-3" />
            <p className="text-neutral-600">Property not found</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/properties')}
              className="mt-4"
            >
              Back to Properties
            </Button>
          </div>
        </GlassCard>
      </div>
    )
  }

  const propertyTypeConfig = PROPERTY_TYPE_CONFIG[property.property_type] || PROPERTY_TYPE_CONFIG.residential
  const PropertyIcon = propertyTypeConfig.icon

  // Get visits for each job
  const getJobVisits = (jobId) => {
    return visits.filter(v => v.job_id === jobId)
  }

  // Sort jobs by scheduled_date
  const sortedJobs = [...jobs].sort((a, b) => {
    if (a.scheduled_date !== b.scheduled_date) {
      return a.scheduled_date > b.scheduled_date ? 1 : -1
    }
    return a.start_time > b.start_time ? 1 : -1
  })

  return (
    <div className="flex flex-col h-screen bg-neutral-50">
      {/* Header */}
      <div className="bg-white border-b border-neutral-200 p-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto">
          {/* Back + Title */}
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => navigate(-1)}
              className="p-2 hover:bg-neutral-100 rounded transition-colors -ml-2"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-bold text-neutral-900">{property.name}</h1>
          </div>

          {/* Property Info */}
          <div className="flex items-start gap-3 mb-4">
            <div className={`p-2 rounded ${propertyTypeConfig.badge}`}>
              <PropertyIcon className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2 py-1 rounded text-xs font-medium ${propertyTypeConfig.badge}`}>
                  {propertyTypeConfig.label}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-sm text-neutral-600 mt-1">
                <MapPin className="w-4 h-4 flex-shrink-0" />
                <span>{property.address}</span>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <Button variant="primary" size="sm">
              <Plus className="w-4 h-4 mr-2" />
              New Job
            </Button>
            <Button variant="secondary" size="sm">
              <Edit2 className="w-4 h-4 mr-2" />
              Edit Property
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
              {error}
            </div>
          )}

          {sortedJobs.length === 0 ? (
            <GlassCard>
              <div className="text-center py-12">
                <Calendar className="w-12 h-12 text-neutral-300 mx-auto mb-3" />
                <p className="text-neutral-600">No jobs scheduled for this property</p>
                <Button variant="primary" size="sm" className="mt-4">
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Job
                </Button>
              </div>
            </GlassCard>
          ) : (
            <div className="space-y-3">
              {sortedJobs.map((job) => {
                const jobVisits = getJobVisits(job.id)
                const statusConfig = JOB_STATUS_CONFIG[job.status] || JOB_STATUS_CONFIG.scheduled
                const hasCleaners = job.cleaner_ids?.length > 0

                return (
                  <div
                    key={job.id}
                    className="bg-white rounded-lg border border-neutral-200 p-4 hover:shadow-md transition-all cursor-pointer"
                    onClick={() => {
                      setSelectedJob(job)
                      setShowJobDetails(true)
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Title + Status */}
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <h3 className="font-semibold text-neutral-900 truncate">{job.title}</h3>
                          <span className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${statusConfig.badge}`}>
                            {statusConfig.label}
                          </span>
                        </div>

                        {/* Date + Time */}
                        <div className="flex items-center gap-3 text-sm text-neutral-600 mb-2 flex-wrap">
                          <div className="flex items-center gap-1">
                            <Calendar className="w-4 h-4 flex-shrink-0" />
                            <span>{job.scheduled_date}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Clock className="w-4 h-4 flex-shrink-0" />
                            <span>{job.start_time?.slice(0, 5)} - {job.end_time?.slice(0, 5)}</span>
                          </div>
                        </div>

                        {/* Cleaners + Visits */}
                        <div className="flex items-center gap-3 text-xs text-neutral-500">
                          {hasCleaners && (
                            <div className="flex items-center gap-1">
                              <Users className="w-3 h-3 flex-shrink-0" />
                              <span>{job.cleaner_ids.length} cleaner{job.cleaner_ids.length !== 1 ? 's' : ''}</span>
                            </div>
                          )}
                          {jobVisits.length > 0 && (
                            <div className="flex items-center gap-1">
                              <Navigation2 className="w-3 h-3 flex-shrink-0" />
                              <span>{jobVisits.length} visit{jobVisits.length !== 1 ? 's' : ''}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Status Indicator */}
                      <div className={`w-3 h-3 rounded-full flex-shrink-0 ${statusConfig.dot}`} />
                    </div>

                    {/* Job Notes (if any) */}
                    {job.notes && (
                      <p className="text-xs text-neutral-600 bg-neutral-50 p-2 rounded mt-3 line-clamp-2">
                        {job.notes}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Job Details Drawer */}
      {showJobDetails && selectedJob && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 flex items-end sm:items-center sm:justify-center">
          <div className="w-full sm:w-full max-w-2xl bg-white rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden sm:max-h-[90vh] flex flex-col max-h-[95vh]">
            {/* Header */}
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 p-4 sm:p-6 text-white flex items-center justify-between">
              <div>
                <h2 className="text-xl sm:text-2xl font-bold">{selectedJob.title}</h2>
                <p className="text-xs sm:text-sm text-blue-100">Job #{selectedJob.id}</p>
              </div>
              <button
                onClick={() => setShowJobDetails(false)}
                className="p-2 hover:bg-blue-400 rounded transition-colors -mr-2 sm:mr-0"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 p-4 sm:p-6 space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-neutral-600 uppercase">Date</label>
                  <p className="text-sm text-neutral-900">{selectedJob.scheduled_date}</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-neutral-600 uppercase">Time</label>
                  <p className="text-sm text-neutral-900">{selectedJob.start_time?.slice(0, 5)} - {selectedJob.end_time?.slice(0, 5)}</p>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Status</label>
                <p className="text-sm text-neutral-900">{JOB_STATUS_CONFIG[selectedJob.status]?.label}</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Job Type</label>
                <p className="text-sm text-neutral-900">{selectedJob.job_type || 'Residential'}</p>
              </div>

              {selectedJob.cleaner_ids?.length > 0 && (
                <div>
                  <label className="text-xs font-semibold text-neutral-600 uppercase">Assigned Cleaners</label>
                  <p className="text-sm text-neutral-900">{selectedJob.cleaner_ids.length} cleaner{selectedJob.cleaner_ids.length !== 1 ? 's' : ''}</p>
                </div>
              )}

              {selectedJob.notes && (
                <div>
                  <label className="text-xs font-semibold text-neutral-600 uppercase">Notes</label>
                  <p className="text-sm text-neutral-900 whitespace-pre-wrap">{selectedJob.notes}</p>
                </div>
              )}

              {/* Visits for this job */}
              {getJobVisits(selectedJob.id).length > 0 && (
                <div className="pt-4 border-t border-neutral-200">
                  <label className="text-xs font-semibold text-neutral-600 uppercase mb-2 block">Associated Visits</label>
                  <div className="space-y-2">
                    {getJobVisits(selectedJob.id).map((visit) => (
                      <div key={visit.id} className="bg-neutral-50 rounded p-2 text-xs">
                        <p className="font-medium text-neutral-900">Visit #{visit.id}</p>
                        <p className="text-neutral-600">{visit.status} • {visit.scheduled_date}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-neutral-200 bg-neutral-50 p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 justify-end sticky bottom-0">
              <Button variant="secondary" onClick={() => setShowJobDetails(false)} className="w-full sm:w-auto">
                Close
              </Button>
              <Button variant="primary" className="w-full sm:w-auto flex items-center gap-2">
                <Edit2 className="w-4 h-4" />
                Edit Job
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
