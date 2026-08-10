import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate, Navigate } from 'react-router-dom'
import { get, post, patch } from '../api'
import Button from '../components/ui/Button'
import ErrorState from '../components/ui/ErrorState'
import JobEditModal from '../components/JobEditModal'
import JobCreateModal from '../components/JobCreateModal'
import CalendarView from '../components/CalendarView'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import AgendaDay from '../components/schedule/AgendaDay'
import AgendaUpcoming from '../components/schedule/AgendaUpcoming'
import AgendaHero from '../components/schedule/AgendaHero'
import DispatchBoard from '../components/schedule/DispatchBoard'
import StickyActionBar from '../components/schedule/StickyActionBar'
import WeekGrid from '../components/schedule/WeekGrid'
import ScheduleSkeleton from '../components/schedule/ScheduleSkeleton'
import CompleteVisitModal from '../components/schedule/CompleteVisitModal'
import VisitDetailsDrawer from '../components/schedule/VisitDetailsDrawer'
import { ComposeModal } from '../components/comms/ComposeModal'
import ScheduleToolbar from '../components/schedule/ScheduleToolbar'
import GoogleCalendarView from '../components/schedule/GoogleCalendarView'
import ScheduleSyncSettings from '../components/schedule/ScheduleSyncSettings'
import { AutoAssignModal, FixTimesModal } from '../components/schedule/PowerToolModals'
import { ScheduleHealthStrip, ScheduleBulkBar } from '../components/schedule/ScheduleSections'
import { AvailabilityPanel } from '../components/schedule/ScheduleTabs'
import { VISIT_STATUS_CONFIG, shortDate, cleanerInitials } from '../components/schedule/constants'
import { useScheduleData } from '../hooks/useScheduleData'
import { useScheduleAnalytics } from '../hooks/useScheduleAnalytics'
import { useScheduleTools } from '../hooks/useScheduleTools'
import { useScheduleFilters } from '../hooks/useScheduleFilters'
import { useVisitSelection } from '../hooks/useVisitSelection'
import { useIsMobile } from '../hooks/useIsMobile'
import { toLocalYMD, todayYMD } from '../utils/format'

export default function Schedule() {
  const [searchParams, setSearchParams] = useSearchParams()
  // Read early (not just at the bottom where the tab panels early-return) so
  // it can gate useScheduleData below — the recurring/availability panels
  // own their own data loading and never read `visits`/`jobs`, so the
  // schedule-week fetch + its 45s poll would otherwise run continuously in
  // the background the whole time an operator sits on one of those tabs
  // (Codex review on the July-2026 audit #5 fix).
  const tab = searchParams.get('tab')
  // Four view modes today:
  //   agenda   — mobile-first day, hero on top + AgendaDay cards (default on phone)
  //   dispatch — desktop 3-column ops board: unassigned / timeline / crews (default on desktop)
  //   week     — week time-grid, dense rows
  //   month    — CalendarView month grid (reference view)
  // Stored in the URL via ?view= so reload + bookmarks survive.
  //
  // Landing default depends on viewport: agenda on phones, dispatch on
  // desktop. The old "always default to month" landed a dispatcher on a
  // grid of "10:00" pills with no context — the July audit called it out.
  const VALID_VIEWS = ['agenda', 'dispatch', 'week', 'month', 'upcoming', 'google']
  const rawView = searchParams.get('view')
  const isMobile = useIsMobile(768)
  // Remember the last view the operator chose so it sticks between visits —
  // a month-first admin lands back on month, a dispatcher on dispatch — rather
  // than always resetting to the viewport default.
  let remembered = null
  try { remembered = localStorage.getItem('bb_schedule_view') } catch { /* ignore */ }
  const viewMode = VALID_VIEWS.includes(rawView)
    ? rawView
    : (VALID_VIEWS.includes(remembered) ? remembered : (isMobile ? 'agenda' : 'dispatch'))
  const setViewMode = (next) => {
    try { localStorage.setItem('bb_schedule_view', next) } catch { /* ignore */ }
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params, { replace: true })
  }

  // currentDate is stored in the URL as ?date=YYYY-MM-DD so a reload keeps
  // the user where they were — the audit called out that reloads jump back
  // to today and CalendarView's own month state could disagree with the
  // page anchor. A missing / invalid param falls back to today.
  const rawDate = searchParams.get('date')
  const initialDate = (() => {
    if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      const d = new Date(`${rawDate}T12:00`)
      if (!Number.isNaN(d.getTime())) return d
    }
    return new Date()
  })()
  const [currentDate, _setCurrentDate] = useState(initialDate)
  const setCurrentDate = (next) => {
    _setCurrentDate(next)
    const params = new URLSearchParams(searchParams)
    const y = next.getFullYear()
    const m = String(next.getMonth() + 1).padStart(2, '0')
    const d = String(next.getDate()).padStart(2, '0')
    params.set('date', `${y}-${m}-${d}`)
    setSearchParams(params, { replace: true })
  }
  const {
    visits, setVisits,
    jobs, setJobs,
    properties, clients,
    loading, loadError,
    refresh,
    employees, empName,
    range: dataRange,
  } = useScheduleData(currentDate, viewMode, { enabled: !tab })

  // Stable array of jobs for CalendarView. Deriving it inline
  // (Object.values(jobs)) produced a fresh array every render, so CalendarView's
  // "re-seed from parentJobs" effect fired constantly and reverted an in-flight
  // optimistic drag. Memoize on the jobs map so it only changes on real data
  // changes (a refetch or an applyLocalMove patch).
  const parentJobs = useMemo(() => Object.values(jobs || {}), [jobs])

  // Analytics for the dispatch surfaces (mobile hero + desktop board).
  // Purely derived — a filter chip toggle doesn't re-fire this because it
  // reads visits/jobs, not the filtered subset.
  const {
    weekDates, loadByDate, todayVisits, todayStats,
    crewLoad, unassignedToday,
  } = useScheduleAnalytics({ visits, jobs, currentDate, employees })
  const [showFilters, setShowFilters] = useState(false)  // filters hidden by default; most days show everything
  // Guest-stay (Airbnb/VRBO iCal) overlay on the month calendar — off by
  // default; it tinted nearly every cell and crowded out the actual jobs.
  // Persisted (unlike the other filter chips) because it's a display
  // preference, not a query narrowing this session's view.
  const [showGuestStays, setShowGuestStays] = useState(() => {
    return localStorage.getItem('schedule-show-guest-stays') === 'true'
  })
  const toggleGuestStays = () => {
    setShowGuestStays(v => {
      const next = !v
      localStorage.setItem('schedule-show-guest-stays', String(next))
      return next
    })
  }
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
  // Inline "message the customer" composer opened from the visit drawer:
  // { clientId, to, channel } or null. Contact is resolved here (the drawer
  // only has the client's name), so the composer opens pre-addressed.
  const [messagingClient, setMessagingClient] = useState(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [newJobDate, setNewJobDate] = useState('')
  // Optional seed for the create modal — set by WeekGrid's click-empty-slot
  // handler so a click at 10:15 opens the modal already pointed at 10:15.
  const [newJobStartTime, setNewJobStartTime] = useState('')

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
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false)

  const {
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

  // Optimistic sync into the parent's visit/job state so subsequent renders
  // keep a dragged block (WeekGrid) or a dragged-to-assign visit
  // (DispatchBoard) showing the new value without waiting for a full
  // refetch. Shared by both since both patch a Job's fields locally the
  // same way — WeekGrid passes {scheduled_date, start_time, end_time},
  // DispatchBoard passes {cleaner_ids}.
  const applyLocalMove = (jobId, next) => {
    setVisits(prev => prev.map(v =>
      v.job_id === jobId || v.id === jobId ? { ...v, ...next } : v
    ))
    // Also patch the jobs MAP so CalendarView's parentJobs reflects the move —
    // otherwise its re-seed effect (which reads the jobs map) snaps a dragged
    // chip back to the old day on the next render/poll.
    setJobs(prev => (prev && prev[jobId]) ? { ...prev, [jobId]: { ...prev[jobId], ...next } } : prev)
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
    if (!(await confirmDialog('Delete this visit?'))) return
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
      await patch(`/api/jobs/${job.id}/reminder-settings`, { skip_reminder: skip })
      setSelectedVisit(sv => sv ? { ...sv, job: { ...sv.job, skip_sms_reminder: skip } } : sv)
      setJobs(prev => prev[job.id] ? { ...prev, [job.id]: { ...prev[job.id], skip_sms_reminder: skip } } : prev)
      toast.success(skip ? '🔕 Reminder disabled for this booking' : '🔔 Reminder enabled for this booking')
    } catch (err) {
      toast.error('Failed to update reminder: ' + err.message)
    }
  }

  // Push (or re-sync) the assigned crew to Connecteam — the explicit
  // hand-off. POST /jobs/{id}/dispatch creates a shift per cleaner (or
  // re-syncs if already dispatched). We optimistically flip the drawer's
  // hand-off chip to "sent" by seeding connecteam_shift_ids with one
  // placeholder per assigned cleaner, then refresh() reconciles with the
  // real shift ids from the backend.
  const [dispatchingJobId, setDispatchingJobId] = useState(null)
  const handleDispatch = async (job) => {
    if (!job?.id || dispatchingJobId != null) return
    const cleanerCount = (job.cleaner_ids || []).length
    setDispatchingJobId(job.id)
    try {
      await post(`/api/jobs/${job.id}/dispatch`, {})
      const optimisticShifts = Array.from({ length: Math.max(cleanerCount, 1) }, (_, i) => `pending-${i}`)
      setSelectedVisit(sv => sv && sv.job?.id === job.id
        ? { ...sv, job: { ...sv.job, connecteam_shift_ids: optimisticShifts } } : sv)
      setJobs(prev => prev[job.id]
        ? { ...prev, [job.id]: { ...prev[job.id], connecteam_shift_ids: optimisticShifts } } : prev)
      toast.success('Sent to crew')
      refresh()
    } catch (err) {
      toast.error('Couldn’t notify the crew: ' + (err?.detail || err?.message || 'try again'))
    } finally {
      setDispatchingJobId(null)
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
    bulkShiftVisits, bulkShifting,
  } = useVisitSelection({
    visits, setVisits, currentlyVisibleVisits, toast,
    // Shifted visits land on a different date — the month grid caches its
    // own jobs list keyed off calRefresh, so bump it the same way a job
    // save/delete does (handleJobSave above) to pick up the moved jobs.
    onAfterShift: () => setCalRefresh(k => k + 1),
  })

  const handleEditJob = (job) => {
    setEditingJob(job)
    setShowJobModal(true)
    setShowDetails(false)
  }

  // Open the inline composer pre-addressed to this visit's customer. The drawer
  // only carries the client's name, so resolve phone/email from the loaded
  // clients map here and prefer SMS when there's a number, else email.
  const handleMessageClient = (job) => {
    if (!job?.client_id) return
    const c = clients?.[job.client_id]
      || Object.values(clients || {}).find(x => String(x.id) === String(job.client_id))
    const phone = (c?.phone || '').trim()
    const email = (c?.email || '').trim()
    if (!phone && !email) {
      toast.error(`No phone or email on file for ${c?.name || 'this client'}.`)
      return
    }
    setMessagingClient({
      clientId: c?.id ?? job.client_id,
      to: phone || email,
      channel: phone ? 'sms' : 'email',
    })
  }

  // Audit §17: don't re-hit the API for the whole week + month on every
  // save. Modals now hand back an {action, jobId, job} envelope and we
  // patch local state directly. An arg-less call is treated as "the
  // modal didn't tell us what happened" → fall back to the old refetch
  // so nothing regresses if a caller isn't wired to the new shape.
  const visitFromJob = (j) => ({
    ...j,
    job_id: j.id,
    scheduled_date: j.scheduled_date,
    start_time: j.start_time,
    end_time: j.end_time,
    cleaner_ids: j.cleaner_ids || [],
    status: j.status,
  })

  const handleJobSave = async (envelope) => {
    if (envelope && envelope.action && envelope.jobId != null) {
      if (envelope.action === 'delete') {
        setVisits(prev => prev.filter(v => (v.job_id ?? v.id) !== envelope.jobId))
      } else if (envelope.job) {
        const asVisit = visitFromJob(envelope.job)
        setVisits(prev => {
          const idx = prev.findIndex(v => (v.job_id ?? v.id) === envelope.jobId)
          if (idx === -1) return [...prev, asVisit]
          const next = prev.slice()
          next[idx] = { ...next[idx], ...asVisit }
          return next
        })
      }
      // The month grid holds its own jobs list; bump the refresh key so it
      // reconciles with the DB. We still avoid the week refetch — that
      // used to be the expensive call.
      setCalRefresh(k => k + 1)
      return
    }
    // Legacy path: no envelope (older callers). Refetch the week.
    const startDate = new Date(currentDate)
    startDate.setDate(startDate.getDate() - startDate.getDay())
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + 6)
    const start = toLocalYMD(startDate)
    const end = toLocalYMD(endDate)
    const jobsRes = await get(`/api/jobs?date_from=${start}&date_to=${end}`)
    const jobsList = Array.isArray(jobsRes) ? jobsRes : (jobsRes?.items || [])
    setVisits(jobsList.map(visitFromJob))
    setCalRefresh(k => k + 1)
  }

  // The Backfill button + coverage banner were removed as part of the
  // Job/Visit unification (PR-B): coverage is trivially 100% once occurrences
  // are just Jobs, so the "N jobs missing visits" surface is dead weight.

  const prevWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() - ((viewMode === 'agenda' || viewMode === 'dispatch') ? 1 : 7))
    setCurrentDate(d)
  }

  const nextWeek = () => {
    const d = new Date(currentDate)
    d.setDate(d.getDate() + ((viewMode === 'agenda' || viewMode === 'dispatch') ? 1 : 7))
    setCurrentDate(d)
  }

  // These used to be early returns at the very top of the component, before
  // most of the hooks above ran — a Rules-of-Hooks violation (a different
  // number of hooks fires depending on ?tab=), which crashes the page the
  // moment client-side navigation lands here with a different ?tab= than
  // the previous render. Every hook above now always runs; the tab check
  // only decides what to render, same as the loadError branch below.
  // `tab` itself is read up top (see useScheduleData's `enabled` option above).
  // Recurring management was consolidated onto the dedicated /recurring page
  // (which now owns creating a series too) — this legacy tab just forwards
  // there so the two surfaces stop confusing people. Safe as an early return:
  // it sits below every hook, same as the availability/loadError branches.
  if (tab === 'recurring') return <Navigate to="/recurring" replace />
  if (tab === 'availability') return <AvailabilityPanel />

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-bg">
        <ErrorState
          title="Couldn't load the schedule"
          description="The server didn't respond. Check your connection and try again."
          onRetry={refresh}
        />
      </div>
    )
  }

  // Audit §12: don't blank the whole page during first-load. The toolbar
  // and health strip stay visible; only the content area shows a skeleton
  // so the user sees which view/date/filters they're on while data lands.
  // Follow-up nav to a new week within the same session doesn't hit this
  // branch — useScheduleData surfaces the loading flag only when there's
  // no cached data yet.

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* The sticky ScheduleToolbar is the page's top bar — it carries its own
          "Schedule" title, the view switcher, date nav, filters, tools, and
          New Job. We used to stack a separate PageHeader above it, but that was
          a whole redundant bar of top space above the calendar (this page is
          calendar-first). Dropped it so month view gets the vertical room. */}
      <ScheduleToolbar
        viewMode={viewMode}
        onViewChange={setViewMode}
        showDateNav={true}
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
        onPreviewAutoAssign={previewAutoAssign}
        onPreviewFixTimes={previewFixTimes}
        onOpenSyncSettings={() => setSyncSettingsOpen(true)}
        onNewJob={() => { setNewJobDate(dateStr); setShowNewJob(true) }}
        healthRefreshKey={calRefresh}
        onSyncForced={refresh}
        unassignedOnly={unassignedOnly}
        onToggleUnassigned={() => setUnassignedOnly(v => !v)}
        unassignedCount={unassignedCount}
        noConnecteamOnly={noConnecteamOnly}
        onToggleNoConnecteam={() => setNoConnecteamOnly(v => !v)}
        notConnecteamCount={scheduleStats?.notConnecteam || 0}
        noGcalOnly={noGcalOnly}
        onToggleNoGcal={() => setNoGcalOnly(v => !v)}
        notGcalCount={scheduleStats?.notGcal || 0}
        showGuestStays={showGuestStays}
        onToggleGuestStays={toggleGuestStays}
      />

      <ScheduleHealthStrip
        stats={scheduleStats}
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
          onBulkShift={bulkShiftVisits}
          bulkShifting={bulkShifting}
        />
      )}

      {/* Render branch: agenda (mobile day + hero) / dispatch (desktop
          3-column board) / week (time-grid) / month (CalendarView).
          Loading skeleton lives before the branch so the toolbar + health
          strip stay live during initial load — audit §12. Once visits
          arrive (even an empty week), the real branch takes over so
          filters/empty-states get to render. */}
      {loading && (visits?.length ?? 0) === 0 ? (
        <ScheduleSkeleton viewMode={viewMode} />
      ) : viewMode === 'agenda' ? (
        <div className="flex-1 overflow-auto flex flex-col">
          <AgendaHero
            currentDate={currentDate}
            todayVisits={todayVisits}
            todayStats={todayStats}
            unassignedToday={unassignedToday}
            weekDates={weekDates}
            loadByDate={loadByDate}
            jobs={jobs}
            properties={properties}
            isToday={dateStr === todayYMD()}
            onDateSelect={setCurrentDate}
            onFocusUnassigned={() => setUnassignedOnly(v => !v)}
          />
          <div className="flex-1 min-h-0">
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
              hideHeader
            />
          </div>
          <StickyActionBar
            onNewJob={() => { setNewJobDate(dateStr); setShowNewJob(true) }}
          />
        </div>
      ) : viewMode === 'dispatch' ? (
        <DispatchBoard
          currentDate={currentDate}
          todayVisits={todayVisits}
          todayStats={todayStats}
          unassignedToday={unassignedToday}
          crewLoad={crewLoad}
          jobs={jobs}
          properties={properties}
          clients={clients}
          empName={empName}
          onOpen={handleEdit}
          onLocalMove={applyLocalMove}
          toast={toast}
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
          onNewJob={(d) => { setNewJobDate(d); setNewJobStartTime(''); setShowNewJob(true) }}
          onNewSlot={({ date, start_time }) => {
            setNewJobDate(date)
            setNewJobStartTime(start_time)
            setShowNewJob(true)
          }}
          onLocalMove={applyLocalMove}
          onRefresh={refresh}
          toast={toast}
        />
      ) : viewMode === 'upcoming' ? (
        <AgendaUpcoming
          refreshKey={calRefresh}
          onSelect={handleEdit}
          onCreateForDay={(d) => { setNewJobDate(d); setShowNewJob(true) }}
          propertyTypeFilter={selectedPropertyType}
          statusFilter={selectedStatus}
        />
      ) : viewMode === 'month' ? (
        <div className="flex-1 overflow-hidden">
          <CalendarView
            refreshKey={calRefresh}
            /* Audit §7 unify: month click routes through handleEdit so it
               opens the same VisitDetailsDrawer as agenda + week, instead
               of jumping straight to JobEditModal. The drawer keeps an
               always-visible "Edit" button, so power users can still
               reach the edit modal in one more click, but the default
               behavior is the same across every schedule surface. Jobs
               and visits are the same entity post-unification, so `j`
               satisfies both slots. */
            onJobClick={(j) => handleEdit(
              j,
              jobs[j.id] || j,
              properties[j.property_id]
            )}
            onCreateForDay={(d) => { setNewJobDate(d); setShowNewJob(true) }}
            onLocalMove={applyLocalMove}
            onRefresh={refresh}
            filters={{
              ...(selectedPropertyType !== 'all' ? { job_type: selectedPropertyType === 'str' ? 'str_turnover' : selectedPropertyType } : {}),
              ...(selectedStatus !== 'all' ? { status: selectedStatus } : {}),
            }}
            toast={toast}
            /* Audit §16 fetch consolidation: hand the already-fetched jobs +
               range to CalendarView so it can skip its own /api/jobs
               request when parentRange covers its month grid. Its Prev/Next
               month buttons call onMonthChange(date) so useScheduleData
               refetches at the new range instead of CalendarView keeping a
               parallel dataset. */
            parentJobs={parentJobs}
            parentRange={dataRange}
            onMonthChange={(d) => setCurrentDate(d)}
            anchorDate={currentDate}
            showGuestStays={showGuestStays}
          />
        </div>
      ) : viewMode === 'google' ? (
        /* Google Calendar embedded in-app — use it as the schedule surface
           directly. Self-contained (its own month/nav), so the BrightBase
           date-nav is hidden for this view. */
        <GoogleCalendarView reloadKey={calRefresh} />
      ) : null /* VALID_VIEWS is fully covered above; no fallback branch needed */}

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
        onDispatch={handleDispatch}
        dispatchingJobId={dispatchingJobId}
        onMessageClient={handleMessageClient}
      />

      {/* Inline customer message composer (opened from the visit drawer) */}
      {messagingClient && (
        <ComposeModal
          clients={Object.values(clients)}
          initialTo={messagingClient.to}
          initialChannel={messagingClient.channel}
          clientId={messagingClient.clientId}
          onClose={() => setMessagingClient(null)}
          onSent={() => { setMessagingClient(null); toast.success('Message sent') }}
        />
      )}

      {/* Job Edit Modal */}
      {showJobModal && (
        <JobEditModal
          job={editingJob}
          properties={Object.values(properties)}
          clients={Object.values(clients)}
          onClose={() => setShowJobModal(false)}
          onSave={handleJobSave}
          notify={(m, opts) => toast.success(m, opts)}
        />
      )}

      {/* Client-first "New Job": pick/create a client + property inline, one-time
          or recurring, residential by default — and it lands on Google Calendar. */}
      {showNewJob && (
        <JobCreateModal
          initialDate={newJobDate || dateStr}
          initialStartTime={newJobStartTime || null}
          onClose={() => { setShowNewJob(false); setNewJobStartTime('') }}
          onCreated={() => { setShowNewJob(false); setNewJobStartTime(''); handleJobSave() }}
        />
      )}

      <ScheduleSyncSettings open={syncSettingsOpen} onClose={() => setSyncSettingsOpen(false)} />

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
    </div>
  )
}
