import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { get, post, put, patch } from '../api'
import Button from '../components/ui/Button'
import ErrorState from '../components/ui/ErrorState'
import JobEditModal from '../components/JobEditModal'
import JobCreateModal from '../components/JobCreateModal'
import CalendarView from '../components/CalendarView'
import { useToast } from '../components/ui/Toast'
import AgendaDay from '../components/schedule/AgendaDay'
import WeekGrid from '../components/schedule/WeekGrid'
import CompleteVisitModal from '../components/schedule/CompleteVisitModal'
import VisitDetailsDrawer from '../components/schedule/VisitDetailsDrawer'
import ScheduleToolbar from '../components/schedule/ScheduleToolbar'
import { AutoAssignModal, FixTimesModal } from '../components/schedule/PowerToolModals'
import { ScheduleHealthStrip, ScheduleBulkBar, ScheduleListView } from '../components/schedule/ScheduleSections'
import { AvailabilityPanel, RecurringPanel } from '../components/schedule/ScheduleTabs'
import { VISIT_STATUS_CONFIG, shortDate, cleanerInitials } from '../components/schedule/constants'
import { useScheduleData } from '../hooks/useScheduleData'
import { useScheduleTools } from '../hooks/useScheduleTools'
import { useScheduleFilters } from '../hooks/useScheduleFilters'
import { useVisitSelection } from '../hooks/useVisitSelection'
import { toLocalYMD, todayYMD } from '../utils/format'

export default function Schedule() {
  const { toast, ToastContainer } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  if (searchParams.get('tab') === 'recurring') return <RecurringPanel />
  if (searchParams.get('tab') === 'availability') return <AvailabilityPanel />
  // Three view modes today:
  //   agenda — single-day full-width card stack (default on phone, the
  //            screen a cleaner actually uses in the field)
  //   list   — week, grouped by day, dense rows (desktop-leaning)
  //   month  — CalendarView month grid (desktop-leaning)
  // Stored in the URL via ?view= so reload + bookmarks survive. If the
  // URL is unset we default to agenda on phone viewports and list on
  // desktop — see the useEffect below.
  // Three views: month Calendar (default), a Week time-grid, and single-Day
  // agenda. The old "Week" LIST view (grouped cards, one per day) was dropped
  // when the time-grid Week landed — it was a third overlapping mode against
  // Day and the new grid supersedes it. A stale ?view=list falls back to
  // the calendar.
  const VALID_VIEWS = ['agenda', 'week', 'month']
  const rawView = searchParams.get('view')
  const viewMode = VALID_VIEWS.includes(rawView) ? rawView : 'month'
  const isGoogleOnly = viewMode === 'google'
  const setViewMode = (next) => {
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params, { replace: true })
  }
  const [currentDate, setCurrentDate] = useState(new Date())
  const {
    visits, setVisits,
    jobs, setJobs,
    properties, clients,
    loading, loadError,
    refresh,
    empName,
  } = useScheduleData(currentDate)
  const [showFilters, setShowFilters] = useState(false)  // filters hidden by default; most days show everything
  const [selectedVisit, setSelectedVisit] = useState(null)
  const [showDetails, setShowDetails] = useState(false)
  // Visit drawer: secondary sections (calendar sync status, SMS reminder) fold
  // behind a "More details" toggle so the drawer opens to the essentials.
  const [showVisitMore, setShowVisitMore] = useState(false)
  // Integration audit rows for the open job (Google Calendar push outcomes), so
  // the detail drawer shows the *real* sync result, not just "has an event id".
  const [jobEvents, setJobEvents] = useState([])
  const [completingVisit, setCompletingVisit] = useState(null)
  const [editingJob, setEditingJob] = useState(null)
  const [showJobModal, setShowJobModal] = useState(false)
  const [showNewJob, setShowNewJob] = useState(false)
  const [newJobDate, setNewJobDate] = useState('')

  // Deep-link entry point (e.g. Cmd+K → "Schedule a job"): /schedule?new=1
  // (optionally &date=YYYY-MM-DD) opens Quick-schedule, then strips the params.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setNewJobDate(searchParams.get('date') || '')
      setShowNewJob(true)
      const next = new URLSearchParams(searchParams)
      next.delete('new'); next.delete('date')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])
  // Bumped after any create/edit so the month CalendarView (which holds its own
  // /api/jobs state) refetches and shows the change without a month switch.
  const [calRefresh, setCalRefresh] = useState(0)
  const navigate = useNavigate()
  // The "Hard delete" bulk-cancel toggle was removed alongside its backend
  // endpoint (POST /api/admin/visits/hard-delete) in the Job/Visit unification.
  // Bulk cancel is soft-only now (PATCH /api/jobs/{id} status=cancelled).
  // "Tools" dropdown (declutters the toolbar) — open/close is UI, so it
  // stays here; the actual actions live in useScheduleTools.
  const [toolsOpen, setToolsOpen] = useState(false)

  const {
    gcalSyncing, syncFromGoogle,
    gcalPushing, pushToGoogle,
    fixingSync, fixSync,
    autoAssign, setAutoAssign, previewAutoAssign, runAutoAssign,
    fixTimes, setFixTimes, previewFixTimes, runFixTimes,
  } = useScheduleTools({ toast, refresh })

  const dateStr = toLocalYMD(currentDate)

  const {
    selectedPropertyType, setSelectedPropertyType,
    selectedStatus, setSelectedStatus,
    unassignedOnly, setUnassignedOnly,
    noGcalOnly, setNoGcalOnly,
    noConnecteamOnly, setNoConnecteamOnly,
    filteredVisits, unassignedCount, visitsByDate, scheduleStats,
    currentlyVisibleVisits,
  } = useScheduleFilters({ visits, jobs, properties, viewMode, dateStr })

  const handleEdit = (visit, job, property) => {
    setSelectedVisit({ visit, job, property })
    setShowDetails(true)
  }

  // When the detail drawer opens for a job, pull its Google Calendar audit rows
  // so we can show whether the last push actually landed (and why, if it didn't).
  useEffect(() => {
    const jobId = showDetails ? selectedVisit?.job?.id : null
    if (!jobId) { setJobEvents([]); return }
    let cancelled = false
    get(`/api/integration-events?entity_type=job&entity_id=${jobId}&provider=gcal&limit=20`)
      .then(rows => { if (!cancelled) setJobEvents(Array.isArray(rows) ? rows : []) })
      .catch(err => { if (!cancelled) { console.error('[Schedule] integration-events', err); setJobEvents([]) } })
    return () => { cancelled = true }
  }, [showDetails, selectedVisit?.job?.id])

  const handleDelete = async (visitId) => {
    if (!confirm('Delete this visit?')) return
    try {
      // Job/Visit unification (PR-B): occurrences are the Job row itself now.
      // The visits list still uses `id` as the visit id; when the row is a
      // mapped-job fallback, `job_id` is the real job id — prefer that.
      const v = visits.find(x => x.id === visitId)
      const targetId = v?.job_id ?? visitId
      await patch(`/api/jobs/${targetId}`, { status: 'cancelled' })
      await setVisits(visits.filter(x => x.id !== visitId))
      setShowDetails(false)
    } catch (err) {
      toast.error('Error deleting visit: ' + err.message)
    }
  }

  // Toggle per-job SMS reminder suppression (hybrid model: on by default).
  const handleToggleReminder = async (job, skip) => {
    if (!job?.id) return
    try {
      await put(`/api/jobs/${job.id}/reminder-settings`, { skip_reminder: skip })
      setSelectedVisit(sv => sv ? { ...sv, job: { ...sv.job, skip_sms_reminder: skip } } : sv)
      setJobs(prev => prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id], skip_sms_reminder: skip } } : prev)
      toast.success(skip ? '🔕 Reminder disabled for this booking' : '🔔 Reminder enabled for this booking')
    } catch (err) {
      toast.error('Failed to update reminder: ' + err.message)
    }
  }

  // Persist a job completion (checklist + photo URLs + status=completed) via
  // POST /api/jobs/{id}/complete — one call stamps every field, and Job.status
  // moves with completion (the audit gap the Job/Visit unification closes).
  const handleCompleteVisit = async (visitId, { checklist_results, photos }) => {
    try {
      const v = visits.find(x => x.id === visitId)
      const targetId = v?.job_id ?? visitId
      const updated = await post(`/api/jobs/${targetId}/complete`, {
        checklist_results,
        photos,
      })
      setVisits(visits.map(x => x.id === visitId
        ? { ...x, status: 'completed', checklist_results, photos } : x))
      setCompletingVisit(null)
      setShowDetails(false)
      toast.success('Visit marked complete')
      return updated
    } catch (err) {
      toast.error('Error completing visit: ' + err.message)
      throw err
    }
  }

  const {
    selectedVisitIds, toggleVisitSelect, selectAllVisible,
    clearVisitSelection, bulkDeleteVisits, bulkDeleting,
  } = useVisitSelection({ visits, setVisits, currentlyVisibleVisits, toast })

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
    const start = toLocalYMD(startDate)
    const end = toLocalYMD(endDate)
    // Reload via /api/jobs; downstream code accepts the same shape via the
    // job-as-visit fallback in the main loader.
    const jobsRes = await get(`/api/jobs?date_from=${start}&date_to=${end}`)
    const jobsList = Array.isArray(jobsRes) ? jobsRes : (jobsRes?.items || [])
    setVisits(jobsList.map(j => ({
      ...j,
      job_id: j.id,
      scheduled_date: j.scheduled_date,
      start_time: j.start_time,
      end_time: j.end_time,
      cleaner_ids: j.cleaner_ids || [],
      status: j.status,
    })))
    setCalRefresh(k => k + 1)  // make the month CalendarView refetch its jobs too
  }

  // The Backfill button + coverage banner were removed as part of the
  // Job/Visit unification (PR-B): coverage is trivially 100% once occurrences
  // are just Jobs, so the "N jobs missing visits" surface is dead weight.

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

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-bg">
        <ErrorState
          title="Couldn't load the schedule"
          description="The server didn't respond. Check your connection and try again."
          onRetry={refresh}
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-ink-2">Loading schedule...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-bg">
      {/* Header */}
      <ScheduleToolbar
        viewMode={viewMode}
        onViewChange={setViewMode}
        showDateNav={!isGoogleOnly}
        currentDate={currentDate}
        onPrevWeek={prevWeek}
        onNextWeek={nextWeek}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(o => !o)}
        selectedPropertyType={selectedPropertyType}
        onPropertyTypeChange={setSelectedPropertyType}
        selectedStatus={selectedStatus}
        onStatusChange={setSelectedStatus}
        toolsOpen={toolsOpen}
        onToggleTools={() => setToolsOpen(o => !o)}
        onCloseTools={() => setToolsOpen(false)}
        gcalSyncing={gcalSyncing}
        gcalPushing={gcalPushing}
        onSyncFromGoogle={syncFromGoogle}
        onPushToGoogle={pushToGoogle}
        onPreviewAutoAssign={previewAutoAssign}
        onPreviewFixTimes={previewFixTimes}
        onNewJob={() => { setNewJobDate(dateStr); setShowNewJob(true) }}
        syncAlertCount={(scheduleStats?.notGcal || 0) + (scheduleStats?.notConnecteam || 0)}
        onFixSync={fixSync}
        fixingSync={fixingSync}
        unassignedOnly={unassignedOnly}
        onToggleUnassigned={() => setUnassignedOnly(v => !v)}
        unassignedCount={unassignedCount}
        noConnecteamOnly={noConnecteamOnly}
        onToggleNoConnecteam={() => setNoConnecteamOnly(v => !v)}
        notConnecteamCount={scheduleStats?.notConnecteam || 0}
        noGcalOnly={noGcalOnly}
        onToggleNoGcal={() => setNoGcalOnly(v => !v)}
        notGcalCount={scheduleStats?.notGcal || 0}
      />

      <ScheduleHealthStrip
        stats={scheduleStats}
        onFixSync={fixSync}
        fixingSync={fixingSync}
        onFilterNoGcal={() => setNoGcalOnly(v => !v)}
        onFilterNoConnecteam={() => setNoConnecteamOnly(v => !v)}
        onFilterUnassigned={() => setUnassignedOnly(v => !v)}
        weekLabel={viewMode === 'month' ? 'This month' : 'This week'}
      />

      {/* Selection / bulk-action bar — agenda view only. In month view the
          grid has no per-job checkbox to individually deselect, and the
          "visible" set is the whole week (not just what's rendered), so
          "Select all visible → Cancel N" would mass-cancel jobs the user
          can't see. Keep bulk operations to the list surface where every
          row is individually selectable. */}
      {viewMode === 'agenda' && (
        <ScheduleBulkBar
          visibleCount={currentlyVisibleVisits.length}
          allSelected={currentlyVisibleVisits.length > 0 && currentlyVisibleVisits.every(v => selectedVisitIds.has(v.id))}
          onSelectAllVisible={selectAllVisible}
          selectedCount={selectedVisitIds.size}
          onClear={clearVisitSelection}
          onBulkDelete={bulkDeleteVisits}
          bulkDeleting={bulkDeleting}
        />
      )}

      {/* Render branch: agenda (single-day cards) / list (week, grouped) / month (CalendarView) */}
      {viewMode === 'agenda' ? (
        <AgendaDay
          currentDate={currentDate}
          visits={filteredVisits.filter(v => v.scheduled_date === dateStr)}
          jobs={jobs}
          properties={properties}
          clients={clients}
          onSelect={handleEdit}
          isToday={dateStr === todayYMD()}
          empName={empName}
          onJumpToToday={() => setCurrentDate(new Date())}
        />
      ) : viewMode === 'week' ? (
        <WeekGrid
          currentDate={currentDate}
          filteredVisits={filteredVisits}
          jobs={jobs}
          properties={properties}
          clients={clients}
          empName={empName}
          onOpen={(v) => handleEdit(v, jobs[v.job_id], properties[jobs[v.job_id]?.property_id])}
          onNewJob={(d) => { setNewJobDate(d); setShowNewJob(true) }}
        />
      ) : viewMode === 'month' ? (
        <div className="flex-1 overflow-hidden">
          <CalendarView
            refreshKey={calRefresh}
            onJobClick={(j) => { setEditingJob(jobs[j.id] || j); setShowJobModal(true) }}
            onCreateForDay={(d) => { setNewJobDate(d); setShowNewJob(true) }}
            filters={{
              ...(selectedPropertyType !== 'all' ? { job_type: selectedPropertyType === 'str' ? 'str_turnover' : selectedPropertyType } : {}),
              ...(selectedStatus !== 'all' ? { status: selectedStatus } : {}),
            }}
            toast={toast}
          />
        </div>
      ) : (
      <ScheduleListView
        visitsByDate={visitsByDate}
        jobs={jobs}
        properties={properties}
        clients={clients}
        selectedVisitIds={selectedVisitIds}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onToggleSelect={toggleVisitSelect}
        empName={empName}
      />
      )}

      {/* Visit Details Drawer */}
      <VisitDetailsDrawer
        selectedVisit={showDetails ? selectedVisit : null}
        showMore={showVisitMore}
        onToggleMore={() => setShowVisitMore(v => !v)}
        jobEvents={jobEvents}
        empName={empName}
        onClose={() => setShowDetails(false)}
        onNavigateJob={(jobId) => navigate(`/jobs/${jobId}`)}
        onComplete={(v) => setCompletingVisit(v)}
        onEditJob={handleEditJob}
        onDelete={handleDelete}
        onToggleReminder={handleToggleReminder}
      />

      {/* Job Edit Modal */}
      {showJobModal && (
        <JobEditModal
          job={editingJob}
          properties={Object.values(properties)}
          clients={Object.values(clients)}
          onClose={() => setShowJobModal(false)}
          onSave={handleJobSave}
          notify={(m) => toast.success(m)}
        />
      )}

      {/* Client-first "New Job": pick/create a client + property inline, one-time
          or recurring, residential by default — and it lands on Google Calendar. */}
      {showNewJob && (
        <JobCreateModal
          initialDate={newJobDate || dateStr}
          onClose={() => setShowNewJob(false)}
          onCreated={() => { setShowNewJob(false); handleJobSave() }}
        />
      )}

      {/* Auto-assign turnovers — preview then confirm */}
      <AutoAssignModal
        state={autoAssign}
        onCancel={() => setAutoAssign(null)}
        onRun={runAutoAssign}
        empName={empName}
      />

      {/* Fix missing times — diagnose (shows source) then backfill */}
      <FixTimesModal
        state={fixTimes}
        onCancel={() => setFixTimes(null)}
        onRun={runFixTimes}
      />

      {/* Complete Visit Modal */}
      {completingVisit && (
        <CompleteVisitModal
          visit={completingVisit}
          onClose={() => setCompletingVisit(null)}
          onComplete={(payload) => handleCompleteVisit(completingVisit.id, payload)}
        />
      )}
      <ToastContainer />
    </div>
  )
}
