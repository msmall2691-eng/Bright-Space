import { useMemo } from 'react'
import { htmlToText, toLocalYMD } from '../utils/format'
import { contactLabel, fmtMoney, monthStart } from '../components/dashboard/utils'

const SIX_DAYS_MS = 6 * 864e5

/** Derived-data memos for the Dashboard command center.
 *
 *  Takes the raw fetched state (from useDashboardData) plus `t` (today's
 *  ISO date) and `navigate`, and computes every value the tiles render:
 *  money aggregates, the quotes/leads action bucket counts, the lead →
 *  client funnel stages, STR turnover coverage for the next 7 days,
 *  per-cleaner workload, AR aging buckets, the unified attention list,
 *  hidden-overflow counts for the attention tile's "+N more" links, and
 *  the today/week job counts.
 *
 *  Every memo keys off exactly what it needs so the re-render cost stays
 *  low even on this data-heavy page. */
export function useDashboardDerived({
  invoices, followUps, todayVisits,
  overdueConvs, unassignedConvs,
  commsSummary, employees,
  weekJobs, todayJobs,
  summary,
  t,
  navigate,
}) {
  /* ── Money calcs ── */
  const todayRevenue = useMemo(() => invoices
    .filter(i => i.status === 'paid' && (i.paid_at || '').slice(0, 10) === t)
    .reduce((s, i) => s + (i.total || 0), 0), [invoices, t])
  const mtdRevenue = useMemo(() => invoices
    .filter(i => i.status === 'paid' && (i.paid_at || '').slice(0, 10) >= monthStart())
    .reduce((s, i) => s + (i.total || 0), 0), [invoices])
  const outstanding = useMemo(() => invoices
    .filter(i => ['sent', 'overdue'].includes(i.status))
    .reduce((s, i) => s + (i.total || 0), 0), [invoices])
  const pipeline = summary?.quotes?.pipeline_value ?? 0
  const overdueInvoiceCount = invoices.filter(i => i.status === 'overdue').length

  // Quotes & leads that need the owner to do something next — from the
  // server aggregate (counts only; the dashboard never needed the full
  // quote rows).
  const quoteActions = useMemo(() => ({
    awaiting: summary?.quotes?.awaiting ?? 0,
    changes: summary?.quotes?.changes ?? 0,
    toSchedule: summary?.quotes?.to_schedule ?? 0,
    newLeads: summary?.new_leads ?? 0,
    followUp: followUps.length,
  }), [summary, followUps])

  // Lead → client funnel: the conversion pipeline as four ordered stages.
  // "Quoted" = quotes out for response (sent/viewed/changes); "Won" =
  // quotes that became jobs. convRate = won ÷ everyone who entered.
  const funnel = useMemo(() => {
    const quoted = summary?.quotes?.quoted ?? 0
    const accepted = summary?.quotes?.accepted ?? 0
    const won = summary?.quotes?.won ?? 0
    const newLeads = quoteActions.newLeads
    const entered = newLeads + quoted + accepted + won
    const stages = [
      { key: 'new',      label: 'New leads', n: newLeads, tone: { text: 'text-purple-600',  bar: 'bg-purple-500' },
        sub: 'to quote',           onClick: () => navigate('/requests') },
      { key: 'quoted',   label: 'Quoted',    n: quoted,   tone: { text: 'text-blue-600',    bar: 'bg-blue-500' },
        sub: 'awaiting reply',     onClick: () => navigate('/billing?view=quotes&tab=quotes') },
      { key: 'accepted', label: 'Accepted',  n: accepted, tone: { text: 'text-amber-600',   bar: 'bg-amber-500' },
        sub: 'ready to schedule',  onClick: () => navigate('/billing?view=quotes&tab=quotes') },
      { key: 'won',      label: 'Won',       n: won,      tone: { text: 'text-emerald-600', bar: 'bg-emerald-500' },
        sub: 'became jobs',        onClick: () => navigate('/clients') },
    ]
    const convRate = entered > 0 ? Math.round((won / entered) * 100) : 0
    return { stages, convRate }
  }, [summary, quoteActions.newLeads, navigate])

  // STR turnover coverage for the next 7 calendar days (today + 6;
  // weekJobs is fetched with an inclusive +7 end, so clamp here).
  // "Covered" = a cleaner is assigned.
  const turnover = useMemo(() => {
    const sixOut = toLocalYMD(new Date(Date.now() + SIX_DAYS_MS))
    const str = weekJobs.filter(j =>
      j.job_type === 'str_turnover' && j.status !== 'cancelled' &&
      (j.scheduled_date || '').slice(0, 10) <= sixOut)
    const needCrew = str.filter(j => !(j.cleaner_ids && j.cleaner_ids.length > 0))
    return { total: str.length, needCrew: needCrew.length }
  }, [weekJobs])

  // Uncapped breached count from the summary endpoint (the list is
  // limit=20).
  const slaBreached = commsSummary.breached ?? overdueConvs.length

  // Crew workload for the next 7 days: jobs assigned per cleaner + unassigned.
  const crew = useMemo(() => {
    const sixOut = toLocalYMD(new Date(Date.now() + SIX_DAYS_MS))
    const jobs = weekJobs.filter(j => j.status !== 'cancelled' && (j.scheduled_date || '').slice(0, 10) <= sixOut)
    const nameOf = (id) => employees.find(e => String(e.id) === String(id))?.name || `Cleaner ${id}`
    const counts = {}
    let unassigned = 0
    for (const j of jobs) {
      const ids = j.cleaner_ids || []
      if (ids.length === 0) { unassigned++; continue }
      for (const id of ids) counts[id] = (counts[id] || 0) + 1
    }
    const rows = Object.entries(counts)
      .map(([id, n]) => ({ id, name: nameOf(id), n }))
      .sort((a, b) => b.n - a.n)
    return { rows, unassigned, total: jobs.length }
  }, [weekJobs, employees])

  // AR aging buckets — so the operator knows WHO to call this morning.
  // Groups overdue invoices by age: 0-30, 30-60, 60-90, 90+ days.
  const arAging = useMemo(() => {
    const now = Date.now()
    const buckets = { current: [], '30': [], '60': [], '90': [] }
    invoices
      .filter(i => ['sent', 'overdue'].includes(i.status))
      .forEach(i => {
        const due = i.due_date ? new Date(i.due_date).getTime() : null
        if (!due) { buckets.current.push(i); return }
        const daysOverdue = Math.max(0, Math.floor((now - due) / 86400000))
        if (daysOverdue >= 90) buckets['90'].push(i)
        else if (daysOverdue >= 60) buckets['60'].push(i)
        else if (daysOverdue >= 30) buckets['30'].push(i)
        else buckets.current.push(i)
      })
    return buckets
  }, [invoices])

  /* Unified attention list. Each category is capped before pushing so a
     flood of overdue replies can't crowd out late visits or past-due
     invoices. Deduped on conversation id so the same thread can't appear
     as both overdue AND unassigned. */
  const attention = useMemo(() => {
    const items = []
    const seenConvs = new Set()
    const nowHHMM = new Date().toTimeString().slice(0, 5)

    overdueConvs.slice(0, 3).forEach(c => {
      if (seenConvs.has(c.id)) return
      seenConvs.add(c.id)
      items.push({
        key: `od-${c.id}`,
        tone: 'red',
        title: `Overdue reply · ${contactLabel(c)}`,
        sub: htmlToText(c.preview) || 'Awaiting reply',
        action: 'Reply',
        onClick: () => navigate('/comms'),
      })
    })

    todayVisits
      .filter(v => v.status === 'scheduled' && (v.start_time || '').slice(0, 5) < nowHHMM)
      .slice(0, 3)
      .forEach(v => items.push({
        key: `late-${v.id}`,
        tone: 'amber',
        title: `Late start · ${v.title || `Job #${v.id}`}`,
        sub: `${(v.start_time || '').slice(0, 5)} · ${v.property_name || ''}`,
        action: 'Open',
        onClick: () => navigate('/schedule'),
      }))

    unassignedConvs.slice(0, 2).forEach(c => {
      if (seenConvs.has(c.id)) return
      seenConvs.add(c.id)
      items.push({
        key: `un-${c.id}`,
        tone: 'amber',
        title: `Unassigned · ${contactLabel(c)}`,
        sub: htmlToText(c.preview) || '',
        action: 'Assign',
        onClick: () => navigate('/comms'),
      })
    })

    invoices
      .filter(i => i.status === 'overdue')
      .slice(0, 2)
      .forEach(i => items.push({
        key: `inv-${i.id}`,
        tone: 'rose',
        title: `Past-due invoice · ${fmtMoney(i.total)}`,
        sub: `Invoice #${i.id}${i.client_name ? ` · ${i.client_name}` : ''}`,
        action: 'Call',
        onClick: () => navigate(`/invoices/${i.id}`),
        // Inline collect action: NeedsYouNow renders a two-tap "Remind"
        // confirm that emails a payment reminder (POST /invoices/{id}/send).
        // Present here as plain data so the tile owns the network + toast +
        // optimistic dismiss, mirroring how it handles reschedule approvals.
        invoiceId: i.id,
      }))

    return items
  }, [overdueConvs, todayVisits, unassignedConvs, invoices, navigate])

  // Hidden-overflow counts so the CTA can route correctly when the hidden
  // item is a late visit or overdue invoice (which /comms can't surface),
  // not a conversation.
  const hiddenOverdueConvs = Math.max(0, overdueConvs.length - 3)
  const hiddenUnassignedConvs = Math.max(0, unassignedConvs.length - 2)
  const hiddenInvoices = Math.max(0, invoices.filter(i => i.status === 'overdue').length - 2)
  const hiddenLateVisits = Math.max(0, todayVisits.filter(v => v.status === 'scheduled').length - 3)

  // Exclude cancelled jobs — the Schedule/Dispatch views already hide
  // cancelled visits (useScheduleAnalytics/useScheduleFilters), so counting
  // them here made the Dashboard disagree with the Schedule page about
  // whether anything is actually happening today.
  const activeTodayJobs = todayJobs.filter(j => j.status !== 'cancelled')
  const activeWeekJobs = weekJobs.filter(j => j.status !== 'cancelled')

  return {
    todayRevenue, mtdRevenue, outstanding, pipeline, overdueInvoiceCount,
    quoteActions,
    funnel,
    turnover,
    slaBreached,
    crew,
    arAging,
    attention,
    hiddenOverdueConvs, hiddenUnassignedConvs, hiddenInvoices, hiddenLateVisits,
    todayJobs: activeTodayJobs,
    todayCount: activeTodayJobs.length,
    weekCount: activeWeekJobs.length,
  }
}
