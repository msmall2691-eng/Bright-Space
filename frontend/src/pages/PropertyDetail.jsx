import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ChevronLeft, Plus, Edit2, Trash2, MoreVertical, MapPin, Home, Building2, Wind,
  Calendar, Clock, Users, CheckCircle, AlertCircle, Navigation2, ClipboardList, X
} from 'lucide-react'
import { get, patch, post } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
// Normalize API responses — some endpoints return raw arrays, others return
// paginated envelopes like { items, total, limit, offset }.
const toArray = (res) => Array.isArray(res) ? res : (res?.items ?? res?.data ?? [])


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

// Inline checklist editor. Areas + tasks per property.
function ChecklistEditor({ template, onSave }) {
  const [areas, setAreas] = useState(template || [])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newArea, setNewArea] = useState('')
  const [newTasks, setNewTasks] = useState({})

  const addArea = () => {
    if (!newArea.trim()) return
    setAreas(prev => [...prev, { area: newArea.trim(), tasks: [] }])
    setNewArea('')
    setDirty(true)
  }
  const removeArea = (i) => { setAreas(prev => prev.filter((_, j) => j !== i)); setDirty(true) }
  const addTask = (areaIdx) => {
    const text = (newTasks[areaIdx] || '').trim()
    if (!text) return
    setAreas(prev => prev.map((a, i) => i === areaIdx ? { ...a, tasks: [...a.tasks, text] } : a))
    setNewTasks(prev => ({ ...prev, [areaIdx]: '' }))
    setDirty(true)
  }
  const removeTask = (areaIdx, taskIdx) => {
    setAreas(prev => prev.map((a, i) => i === areaIdx ? { ...a, tasks: a.tasks.filter((_, j) => j !== taskIdx) } : a))
    setDirty(true)
  }
  const save = async () => {
    setSaving(true)
    await onSave(areas)
    setSaving(false)
    setDirty(false)
  }

  return (
    <div className="bg-panel border border-hairline rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-semibold text-ink">Cleaning Checklist</h3>
        </div>
        {dirty && (
          <button onClick={save} disabled={saving}
            className="text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-3 py-1 rounded-lg transition-colors">
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>

      {areas.length === 0 && (
        <p className="text-xs text-ink-3 mb-3">No checklist yet. Add areas and tasks below.</p>
      )}

      {areas.map((area, ai) => (
        <div key={ai} className="mb-3 bg-bg rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">{area.area}</span>
            <button onClick={() => removeArea(ai)} className="text-red-400 hover:text-red-600 p-0.5"><X className="w-3 h-3" /></button>
          </div>
          <ul className="space-y-1 mb-2">
            {area.tasks.map((task, ti) => (
              <li key={ti} className="flex items-center justify-between text-xs text-ink-2 pl-2">
                <span>• {task}</span>
                <button onClick={() => removeTask(ai, ti)} className="text-red-400 hover:text-red-600 p-0.5"><X className="w-2.5 h-2.5" /></button>
              </li>
            ))}
          </ul>
          <div className="flex gap-1">
            <input
              value={newTasks[ai] || ''}
              onChange={e => setNewTasks(prev => ({ ...prev, [ai]: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && addTask(ai)}
              placeholder="Add task..."
              className="flex-1 bg-panel border border-hairline rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400"
            />
            <button onClick={() => addTask(ai)} className="text-xs text-blue-600 font-semibold px-2">Add</button>
          </div>
        </div>
      ))}

      <div className="flex gap-1">
        <input
          value={newArea}
          onChange={e => setNewArea(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addArea()}
          placeholder="New area (e.g. Kitchen, Bathrooms)..."
          className="flex-1 bg-panel border border-hairline rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400"
        />
        <button onClick={addArea} className="text-xs text-blue-600 font-semibold px-2 shrink-0">+ Area</button>
      </div>
    </div>
  )
}


// Visit row with optional checklist completion flow. If the property has
// a checklist_template, the visit row shows a "Complete" button that
// expands into a task-by-task checklist with checkboxes. Results save
// to Visit.checklist_results and transition the visit to 'completed'.
function VisitChecklistRow({ visit, checklistTemplate, onComplete }) {
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState(visit.checklist_results || {})
  const [saving, setSaving] = useState(false)

  const template = checklistTemplate || []
  const totalTasks = template.reduce((n, a) => n + (a.tasks?.length || 0), 0)
  const doneTasks = Object.values(results).filter(v => v === 'done').length
  const isCompleted = visit.status === 'completed'

  const toggle = (key) => {
    setResults(prev => ({
      ...prev,
      [key]: prev[key] === 'done' ? 'pending' : 'done',
    }))
  }

  const handleComplete = async () => {
    setSaving(true)
    await onComplete(results)
    setSaving(false)
    setOpen(false)
  }

  return (
    <div className="bg-bg rounded-lg p-3 text-xs">
      <div className="flex items-center justify-between mb-1">
        <div>
          <span className="font-medium text-ink">Visit #{visit.id}</span>
          <span className="text-ink-3 ml-2">{visit.status} • {visit.scheduled_date}</span>
        </div>
        {!isCompleted && totalTasks > 0 && (
          <button
            onClick={() => setOpen(!open)}
            className="text-blue-600 font-semibold hover:text-blue-700"
          >
            {open ? 'Close' : `Complete (${doneTasks}/${totalTasks})`}
          </button>
        )}
        {isCompleted && totalTasks > 0 && (
          <span className="text-emerald-600 font-semibold flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> {doneTasks}/{totalTasks}
          </span>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {template.map((area, ai) => (
            <div key={ai}>
              <div className="text-[11px] font-semibold text-ink-2 uppercase tracking-wide mb-1">{area.area}</div>
              {(area.tasks || []).map((task, ti) => {
                const key = `${area.area}::${task}`
                const done = results[key] === 'done'
                return (
                  <label key={ti} className="flex items-center gap-2 py-0.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={() => toggle(key)}
                      className="w-3.5 h-3.5 rounded border-hairline"
                    />
                    <span className={done ? 'line-through text-ink-3' : 'text-ink-2'}>{task}</span>
                  </label>
                )
              })}
            </div>
          ))}
          <button
            onClick={handleComplete}
            disabled={saving}
            className="w-full mt-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold py-2 rounded-lg transition-colors"
          >
            {saving ? 'Saving...' : 'Mark Visit Complete'}
          </button>
        </div>
      )}
    </div>
  )
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
        setJobs(toArray(jobsRes))
        setVisits(toArray(visitsRes))
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
      <div className="flex items-center justify-center h-screen bg-bg">
        <p className="text-ink-2">Loading property...</p>
      </div>
    )
  }

  if (!property) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <GlassCard>
          <div className="text-center py-12">
            <AlertCircle className="w-12 h-12 text-ink-3 mx-auto mb-3" />
            <p className="text-ink-2">Property not found</p>
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
    if (!Array.isArray(visits)) return []
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
    <div className="flex flex-col h-screen bg-bg">
      {/* Header */}
      <div className="bg-panel border-b border-hairline p-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto">
          {/* Back + Title */}
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => navigate(-1)}
              className="p-2 hover:bg-bg-2 rounded transition-colors -ml-2"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-bold text-ink">{property.name}</h1>
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
              <div className="flex items-center gap-1.5 text-sm text-ink-2 mt-1">
                <MapPin className="w-4 h-4 flex-shrink-0" />
                <span>{property.address}</span>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => navigate(`/schedule?newJob=1&property_id=${propertyId}`)}>
              <Plus className="w-4 h-4 mr-2" />
              New Job
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate(`/properties?edit=${propertyId}`)}>
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

          {/* Cleaning Checklist — editable template per property */}
          <ChecklistEditor
            template={property.checklist_template}
            onSave={async (areas) => {
              await patch(`/api/properties/${propertyId}`, { checklist_template: areas })
              setProperty(prev => ({ ...prev, checklist_template: areas }))
            }}
          />

          {sortedJobs.length === 0 ? (
            <GlassCard>
              <div className="text-center py-12">
                <Calendar className="w-12 h-12 text-ink-3 mx-auto mb-3" />
                <p className="text-ink-2">No jobs scheduled for this property</p>
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
                    className="bg-panel rounded-lg border border-hairline p-4 hover:shadow-md transition-all cursor-pointer"
                    onClick={() => {
                      setSelectedJob(job)
                      setShowJobDetails(true)
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Title + Status */}
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <h3 className="font-semibold text-ink truncate">{job.title}</h3>
                          <span className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${statusConfig.badge}`}>
                            {statusConfig.label}
                          </span>
                        </div>

                        {/* Date + Time */}
                        <div className="flex items-center gap-3 text-sm text-ink-2 mb-2 flex-wrap">
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
                        <div className="flex items-center gap-3 text-xs text-ink-3">
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
                      <p className="text-xs text-ink-2 bg-bg p-2 rounded mt-3 line-clamp-2">
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
          <div className="w-full sm:w-full max-w-2xl bg-panel rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden sm:max-h-[90vh] flex flex-col max-h-[95vh]">
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
                  <label className="text-xs font-semibold text-ink-2 uppercase">Date</label>
                  <p className="text-sm text-ink">{selectedJob.scheduled_date}</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Time</label>
                  <p className="text-sm text-ink">{selectedJob.start_time?.slice(0, 5)} - {selectedJob.end_time?.slice(0, 5)}</p>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Status</label>
                <p className="text-sm text-ink">{JOB_STATUS_CONFIG[selectedJob.status]?.label}</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Job Type</label>
                <p className="text-sm text-ink">{selectedJob.job_type || 'Residential'}</p>
              </div>

              {selectedJob.cleaner_ids?.length > 0 && (
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Assigned Cleaners</label>
                  <p className="text-sm text-ink">{selectedJob.cleaner_ids.length} cleaner{selectedJob.cleaner_ids.length !== 1 ? 's' : ''}</p>
                </div>
              )}

              {selectedJob.notes && (
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Notes</label>
                  <p className="text-sm text-ink whitespace-pre-wrap">{selectedJob.notes}</p>
                </div>
              )}

              {/* Visits for this job */}
              {getJobVisits(selectedJob.id).length > 0 && (
                <div className="pt-4 border-t border-hairline">
                  <label className="text-xs font-semibold text-ink-2 uppercase mb-2 block">Associated Visits</label>
                  <div className="space-y-2">
                    {getJobVisits(selectedJob.id).map((visit) => (
                      <VisitChecklistRow
                        key={visit.id}
                        visit={visit}
                        checklistTemplate={property?.checklist_template}
                        onComplete={async (results) => {
                          await patch(`/api/visits/${visit.id}`, {
                            checklist_results: results,
                            status: 'completed',
                            completed_at: new Date().toISOString(),
                          })
                          setVisits(prev => prev.map(v => v.id === visit.id
                            ? { ...v, checklist_results: results, status: 'completed', completed_at: new Date().toISOString() }
                            : v
                          ))
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-hairline bg-bg p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 justify-end sticky bottom-0">
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
