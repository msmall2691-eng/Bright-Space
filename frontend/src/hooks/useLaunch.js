import { useCallback, useEffect, useMemo, useState } from 'react'
import { get, post, patch } from '../api'
import { toast } from '../utils/toastBus'

/** The Launch flow drives ONE deal through the operational pipeline —
 *  Quote → Send → Accept → Schedule → Dispatch — in a single surface, opening
 *  at the deal's current stage. Every step wraps an endpoint that ALREADY
 *  exists; the stepper only sequences existing moves, so the business logic
 *  (and its guards) stays server-side and the risk stays in the UI.
 *
 *  Stage is DETECTED, not stored: we read /api/opportunities/{id}/details and
 *  infer which steps are done from the deal's quotes + jobs. That means the
 *  stepper stays correct even for deals advanced outside it. */

export const LAUNCH_STEPS = ['quote', 'send', 'accept', 'schedule', 'dispatch']

// How far along a quote's status implies the deal is. Mirrors the server's
// quote lifecycle: draft → sent/viewed/changes → accepted → converted.
const QUOTE_RANK = {
  draft: 0, sent: 1, viewed: 1, changes_requested: 1,
  accepted: 2, converted: 3, declined: 0, expired: 0, archived: 0,
}

export function useLaunch(opportunityId) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // /details doesn't expose a job's Connecteam dispatch flag, so a fresh
  // dispatch can't be re-derived from a reload — track it locally so the
  // Dispatch step reflects the action the operator just took.
  const [dispatchedLocally, setDispatchedLocally] = useState(false)

  const load = useCallback(async () => {
    if (!opportunityId) return
    setLoading(true); setError(null)
    try {
      setDetail(await get(`/api/opportunities/${opportunityId}/details`))
    } catch (e) {
      setError(e?.message || 'Failed to load this deal')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { load() }, [load])

  const quotes = detail?.quotes || []
  const jobs = detail?.jobs || []

  // The quote that best represents the deal — the furthest-along one.
  const primaryQuote = useMemo(() => {
    let best = null, bestRank = -1
    for (const q of quotes) {
      const r = QUOTE_RANK[q.status] ?? 0
      if (r >= bestRank) { best = q; bestRank = r }
    }
    return best
  }, [quotes])

  // The job to schedule/dispatch — a scheduled one if present, else any live job.
  const primaryJob = useMemo(() =>
    jobs.find(j => j.scheduled_date && !['cancelled', 'unscheduled'].includes(j.status))
    || jobs.find(j => j.status !== 'cancelled')
    || null, [jobs])

  const steps = useMemo(() => {
    const qs = primaryQuote?.status
    const done = {
      quote: !!primaryQuote,
      send: !!qs && qs !== 'draft',
      accept: qs === 'accepted' || qs === 'converted',
      schedule: !!(primaryJob && primaryJob.scheduled_date && primaryJob.status !== 'unscheduled'),
      // Prefer the durable signal (a job with Connecteam shifts) over the
      // local flag so a reload — or a deal dispatched elsewhere — reflects truth.
      dispatch: dispatchedLocally
        || jobs.some(j => (j.connecteam_shift_ids?.length || 0) > 0 || j.status === 'completed'),
    }
    return LAUNCH_STEPS.map(key => ({ key, done: !!done[key] }))
  }, [primaryQuote, primaryJob, jobs, dispatchedLocally])

  // Open at the first not-yet-done step.
  const currentStep = steps.find(s => !s.done)?.key || 'dispatch'

  const run = async (fn, okMsg) => {
    setBusy(true)
    try {
      await fn()
      if (okMsg) toast.success(okMsg)
      await load()
    } catch (e) {
      toast.error(e?.detail || e?.message || 'That step could not be completed')
      throw e
    } finally {
      setBusy(false)
    }
  }

  const sendQuote = () =>
    run(async () => {
      // send_quote returns 200 with delivered:false (no contact / delivery
      // failure) rather than throwing — so a bare await would toast "sent"
      // for a quote the customer never received. Surface the real outcome.
      const res = await post(`/api/quotes/${primaryQuote.id}/send`, { channel: 'email' })
      if (res && res.delivered === false) {
        throw new Error((res.errors && res.errors.join('; ')) || 'Couldn’t deliver — check the customer’s email or phone.')
      }
    }, 'Quote sent')

  const acceptQuote = () =>
    run(() => post(`/api/quotes/${primaryQuote.id}/accept`, { notify_customer: true }), 'Quote accepted')

  const scheduleJob = (body) =>
    run(() => {
      // Accepting a property-linked quote already created an (unscheduled) job,
      // and convert-to-job is idempotent — it returns that job WITHOUT applying
      // the date/time. So when a job already exists, schedule it directly via
      // the job update endpoint; only fall back to convert-to-job when no job
      // exists yet.
      if (primaryJob) return patch(`/api/jobs/${primaryJob.id}`, body || {})
      return post(`/api/quotes/${primaryQuote.id}/convert-to-job`, body || {})
    }, 'Job scheduled')

  const dispatchJob = () =>
    run(async () => {
      // dispatch_job returns 200 with connecteam.dispatched:false + a reason on
      // a no-op (no crew, Connecteam not configured, inactive job). Only mark
      // the step done when the push actually happened. A resync (already
      // dispatched) returns a different shape with no `dispatched` key — treat
      // that as success (the crew already has it); only an explicit false fails.
      const res = await post(`/api/jobs/${primaryJob.id}/dispatch`, {})
      const ct = res?.connecteam
      if (ct && ct.dispatched === false) {
        throw new Error(ct.reason ? `Crew not notified (${ct.reason.replace(/_/g, ' ')})` : 'Crew dispatch didn’t complete.')
      }
      setDispatchedLocally(true)
    }, 'Sent to crew')

  return {
    detail, loading, error, busy,
    steps, currentStep, primaryQuote, primaryJob,
    reload: load, sendQuote, acceptQuote, scheduleJob, dispatchJob,
  }
}
