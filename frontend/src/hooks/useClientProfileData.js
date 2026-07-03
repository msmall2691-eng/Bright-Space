import { useState, useEffect, useCallback } from 'react'
import { get } from '../api'

/**
 * Owns every piece of server-driven state on the client profile: the client
 * record, its related collections (jobs / quotes / invoices / messages / emails
 * / properties / schedules / opportunities / activities / visit stats / linked
 * gcal events), the bulk load pipeline, and the derived values every tab uses
 * (revenue, outstanding, upcoming/past jobs, unified activity feed).
 *
 * The parent page still owns UI state — active tab, form draft, form-showing
 * booleans, banners, modal open-state — and mutations that need to touch both
 * the domain and the UI (saveField, saveProp, saveQuickContact, sendSms).
 * `setClient` is exposed so those mutations can echo their PATCH response back
 * into the cache without going through a full reload.
 *
 * Returns a stable set of state, callbacks, and derived values.
 */
export function useClientProfileData(id) {
  const [client, setClient] = useState(null)
  const [jobs, setJobs] = useState([])
  const [quotes, setQuotes] = useState([])
  const [invoices, setInvoices] = useState([])
  const [messages, setMessages] = useState([])
  const [emails, setEmails] = useState([])
  const [properties, setProperties] = useState([])
  const [schedules, setSchedules] = useState([])
  const [opportunities, setOpportunities] = useState([])
  const [activities, setActivities] = useState([])
  const [visitStats, setVisitStats] = useState(null)
  const [profileVisits, setProfileVisits] = useState({ upcoming: [], past: [] })
  const [timelineEvents, setTimelineEvents] = useState([])

  const load = useCallback(async () => {
    try {
      // Load client first (blocking) so the profile can render.
      const profile = await get(`/api/clients/${id}/profile`).catch(() => null)
      const c = profile || await get(`/api/clients/${id}`)
      setClient(c)
      if (profile?.visit_stats) setVisitStats(profile.visit_stats)
      if (profile?.upcoming_visits || profile?.past_visits) {
        setProfileVisits({
          upcoming: profile.upcoming_visits || [],
          past: profile.past_visits || [],
        })
      }

      // Load the related collections in parallel — none are on the critical path.
      Promise.all([
        get(`/api/jobs?client_id=${id}`).then(j => setJobs(Array.isArray(j) ? j : [])).catch(() => {}),
        get(`/api/quotes?client_id=${id}`).then(q => setQuotes(Array.isArray(q) ? q : [])).catch(() => {}),
        get(`/api/invoices?client_id=${id}`).then(inv => setInvoices(Array.isArray(inv) ? inv : [])).catch(() => {}),
        // Unified, contact-linked comms: emails + SMS matched by client_id OR
        // the client's email/phone (server-side), split by channel here.
        get(`/api/comms/client/${id}`).then(r => {
          const all = Array.isArray(r?.messages) ? r.messages : []
          setMessages(all.filter(m => m.channel === 'sms'))
          setEmails(all.filter(m => m.channel === 'email').reverse())  // newest first
        }).catch(() => {}),
        get(`/api/properties?client_id=${id}`).then(props => setProperties(Array.isArray(props) ? props : [])).catch(() => {}),
        get(`/api/recurring?client_id=${id}`).then(scheds => setSchedules(Array.isArray(scheds) ? scheds : [])).catch(() => {}),
        get(`/api/opportunities?client_id=${id}`).then(opps => setOpportunities(Array.isArray(opps) ? opps : [])).catch(() => {}),
        get(`/api/activities?client_id=${id}&limit=50`).then(acts => setActivities(Array.isArray(acts) ? acts : [])).catch(() => {}),
        // Linked Google Calendar events — interleaved into the unified timeline.
        get(`/api/jobs/client/${id}/gcal-events`).then(r => setTimelineEvents(Array.isArray(r?.events) ? r.events : [])).catch(() => {}),
      ])
    } catch (e) {
      console.error('[useClientProfileData load]', e)
    }
  }, [id])

  const reloadActivities = useCallback(async () => {
    try {
      const acts = await get(`/api/activities?client_id=${id}&limit=50`)
      setActivities(Array.isArray(acts) ? acts : [])
    } catch { /* non-fatal */ }
  }, [id])

  const reloadProperties = useCallback(async () => {
    const props = await get(`/api/properties?client_id=${id}`)
    const arr = Array.isArray(props) ? props : []
    setProperties(arr)
    return arr
  }, [id])

  useEffect(() => { load() }, [load])

  // ── Derived values every tab reads ────────────────────────────────────────

  const totalRevenue = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (i.total || 0), 0)
  const outstanding = invoices.filter(i => ['sent', 'overdue'].includes(i.status)).reduce((s, i) => s + (i.total || 0), 0)

  // Upcoming and past cleanings.
  // Null-safe: some jobs (legacy / unscheduled) have a null scheduled_date —
  // calling .localeCompare on null used to crash the whole profile page.
  const todayStr = new Date().toISOString().slice(0, 10)
  const upcomingJobs = jobs
    .filter(j => j.scheduled_date && j.scheduled_date >= todayStr && j.status !== 'cancelled')
    .sort((a, b) => (a.scheduled_date || '').localeCompare(b.scheduled_date || '') || (a.start_time || '').localeCompare(b.start_time || ''))
  const pastJobs = jobs
    .filter(j => (j.scheduled_date && j.scheduled_date < todayStr) || j.status === 'cancelled')
    .sort((a, b) => (b.scheduled_date || '').localeCompare(a.scheduled_date || ''))

  // Build the unified activity feed. `activityLogVisible` drops entries that
  // duplicate a row we're already showing from a sibling collection:
  //   - `email_received`: emails are already surfaced through the `emails` list.
  //   - `job_*`: jobs are already surfaced through the `jobs` list — UNLESS the
  //     activity was emitted by the GCal source (event created/updated/cancelled
  //     in Google Calendar) or it's a single-occurrence visit skip. Those add
  //     real signal that isn't visible from the job row alone.
  const JOB_SHADOWED_TYPES = new Set([
    'job_created', 'job_scheduled', 'job_started', 'job_completed', 'job_cancelled',
  ])
  const activityLogVisible = activities.filter(a => {
    if (a.activity_type === 'email_received') return false
    if (JOB_SHADOWED_TYPES.has(a.activity_type)) {
      const fromGcal = a.extra_data?.source === 'gcal'
      const visitSkip = a.extra_data?.single_occurrence === true
      return fromGcal || visitSkip
    }
    return true
  })
  const allActivity = [
    ...jobs.map(j => ({ type: 'job', date: j.created_at, data: j })),
    ...quotes.map(q => ({ type: 'quote', date: q.created_at, data: q })),
    ...invoices.map(i => ({ type: 'invoice', date: i.created_at, data: i })),
    ...messages.map(m => ({ type: 'message', date: m.created_at, data: m })),
    ...opportunities.map(o => ({ type: 'opportunity', date: o.created_at, data: o })),
    ...activityLogVisible.map(a => ({ type: 'activity_log', date: a.created_at, data: a })),
    ...emails.map(e => ({ type: 'email', date: e.created_at, data: e })),
    // Real Google Calendar events linked by email. Skip ones that mirror an app
    // job (they already appear as a 'job' item) to avoid double entries.
    ...timelineEvents.filter(ev => !ev.job_id).map(ev => ({ type: 'gcal_event', date: ev.start, data: ev })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  return {
    // Domain state
    client, setClient,
    jobs, quotes, invoices, messages, emails,
    properties, schedules, opportunities,
    visitStats, profileVisits, timelineEvents,

    // Data-loading callbacks
    load, reloadActivities, reloadProperties,

    // Derived
    totalRevenue, outstanding,
    upcomingJobs, pastJobs,
    allActivity,
  }
}
