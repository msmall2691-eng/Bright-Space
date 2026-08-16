import { useState, useEffect } from 'react'
import {
  Calendar, Clock, Plus, RefreshCw, ChevronLeft, ChevronRight,
  MapPin, Mail, Home,
} from 'lucide-react'
import { get, post } from '../../api'
import {
  MINI_DAYS, MONTH_NAMES, JOB_TYPE_DOT, JOB_TYPE_LABEL, STATUS_PILL,
} from './constants'
import { toLocalYMD } from '../../utils/format'

/** A single Google Calendar event row in the client's linked timeline. */
function GcalEventRow({ ev }) {
  const start = ev.start ? new Date(ev.start) : null
  const end = ev.end ? new Date(ev.end) : null
  const valid = start && !isNaN(start)
  const dotColor = JOB_TYPE_DOT[ev.job_type] || 'bg-indigo-500'
  const isPast = valid && end && !isNaN(end) ? end < new Date() : false
  const timeStr = valid
    ? (ev.all_day
        ? 'All day'
        : start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) +
          (end && !isNaN(end) ? ` – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''))
    : ''
  const invited = (ev.attendees || []).length > 0
  return (
    <a
      href={ev.html_link || undefined}
      target="_blank"
      rel="noopener noreferrer"
      className={`block bg-panel border border-hairline rounded-xl p-4 flex items-start gap-3 transition-colors hover:border-indigo-300 hover:shadow-sm ${isPast ? 'opacity-60' : ''}`}
      title="Open in Google Calendar"
    >
      <div className={`w-1 self-stretch rounded-full shrink-0 ${dotColor}`} />
      <div className="text-center w-12 shrink-0 pt-0.5">
        <div className="text-xs font-bold text-ink-2">
          {valid ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
        </div>
        <div className="text-[10px] text-ink-3">
          {valid ? start.toLocaleDateString('en-US', { weekday: 'short' }) : ''}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-ink truncate">{ev.title}</div>
        <div className="flex items-center gap-2 mt-1 text-xs text-ink-3 flex-wrap">
          {timeStr && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeStr}</span>}
          {ev.job_type && (<><span className="text-[10px] text-ink-3">|</span><span>{JOB_TYPE_LABEL[ev.job_type] || ev.job_type}</span></>)}
        </div>
        {ev.location && (
          <div className="flex items-center gap-1 mt-0.5 text-[11px] text-ink-3 truncate">
            <MapPin className="w-3 h-3 shrink-0" />{ev.location}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <span title="On Google Calendar" className="w-3.5 h-3.5 rounded-full bg-indigo-100 flex items-center justify-center text-[8px] text-indigo-500 font-bold">G</span>
        {invited && <span title="Client is an attendee" className="w-3.5 h-3.5 rounded-full bg-emerald-100 flex items-center justify-center text-[8px] text-emerald-500 font-bold">✓</span>}
      </div>
    </a>
  )
}

export default function ClientCalendarTab({ jobs, upcomingJobs, pastJobs, navigate, clientId, clientEmail, visitStats, gcalReloadKey = 0, onAddAppointment, onEditJob, onChanged, toast }) {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [selectedDate, setSelectedDate] = useState(null)

  // Embedded Google Calendar (the business calendar the sync writes to). Editing
  // happens in the appointment form / Google itself — the embed is read-only by
  // design. The src carries a reload key so add/edit/cancel/invite re-fetch it.
  const [embed, setEmbed] = useState({ loading: true })
  const [localReload, setLocalReload] = useState(0)
  const [invitingId, setInvitingId] = useState(null)
  useEffect(() => {
    get('/api/settings/gcal-embed')
      .then(r => setEmbed({ loading: false, url: r?.embed_url, configured: !!r?.configured }))
      .catch(() => setEmbed({ loading: false, configured: false }))
  }, [])

  // Twenty-style linked timeline: this client's actual Google Calendar events,
  // matched by their email (or our brightbase_client_id tag). This is the
  // source of truth — not local app rows.
  const [gcalEvents, setGcalEvents] = useState({ loading: true, events: [] })
  useEffect(() => {
    if (!clientId) return
    setGcalEvents(s => ({ ...s, loading: true }))
    get(`/api/jobs/client/${clientId}/gcal-events`)
      .then(r => setGcalEvents({ loading: false, ...r, events: r?.events || [] }))
      .catch(e => setGcalEvents({ loading: false, connected: false, events: [], detail: e?.message }))
  }, [clientId, gcalReloadKey, localReload])
  const iframeSrc = embed.url ? `${embed.url}&_=${gcalReloadKey}-${localReload}` : null
  const inviteCustomer = async (jobId) => {
    setInvitingId(jobId)
    try {
      await post(`/api/jobs/${jobId}/invite-client`, {})
      toast?.success?.('Customer invited — added to their calendar')
      onChanged?.()
    } catch (e) { toast?.error?.(e?.message || 'Could not invite customer') }
    setInvitingId(null)
  }

  const todayStr = toLocalYMD(now)

  // Build map of date → jobs for this client
  const jobsByDate = {}
  jobs.forEach(j => {
    if (!j.scheduled_date) return
    if (!jobsByDate[j.scheduled_date]) jobsByDate[j.scheduled_date] = []
    jobsByDate[j.scheduled_date].push(j)
  })

  // Calendar grid math
  const firstDay = new Date(year, month, 1)
  const lastDay  = new Date(year, month + 1, 0)
  const startDow = firstDay.getDay()
  const totalDays = lastDay.getDate()

  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= totalDays; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push(iso)
  }
  while (cells.length % 7 !== 0) cells.push(null)

  const prevMonth = () => { if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1) }
  const nextMonth = () => { if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1) }

  // Jobs to show in the event list below the calendar
  const selectedDayJobs = selectedDate ? (jobsByDate[selectedDate] || []) : null
  const listJobs = selectedDayJobs !== null ? selectedDayJobs : upcomingJobs

  return (
    <div className="max-w-2xl space-y-5">
      {/* Add appointment + embedded Google Calendar */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Google Calendar</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setLocalReload(k => k + 1)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-2 bg-bg-2 hover:bg-hairline transition-colors"
            title="Reload the embed (Google caches new events for a few seconds)">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button onClick={onAddAppointment}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add appointment
          </button>
        </div>
      </div>
      <div className="bg-panel border border-hairline rounded-xl overflow-hidden">
        {embed.loading ? (
          <div className="p-8 text-center text-sm text-ink-3">Loading Google Calendar…</div>
        ) : !embed.configured ? (
          <div className="p-6 text-center text-[13px] text-ink-3">
            Google Calendar isn't set up for embedding yet (Settings → Integrations).
            Appointments you add are still saved straight to Google Calendar.
          </div>
        ) : (
          <iframe title="Google Calendar" src={iframeSrc} className="w-full border-0" style={{ height: '440px' }} />
        )}
      </div>

      {/* Linked Google Calendar events — this client's real events, matched by
          their email (or our brightbase tag). The Twenty-style source of truth. */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">Linked Google Calendar events</h3>
          {gcalEvents.client_email && (
            <span className="text-[10px] text-ink-3">matched by {gcalEvents.client_email}</span>
          )}
        </div>
        {gcalEvents.loading ? (
          <div className="text-center py-8 bg-panel border border-hairline rounded-xl text-sm text-ink-3">Loading events from Google…</div>
        ) : gcalEvents.connected === false ? (
          <div className="text-center py-8 bg-panel border border-hairline rounded-xl px-4">
            <Calendar className="w-7 h-7 mx-auto mb-2 text-ink-3" />
            <p className="text-sm text-ink font-medium inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
              Google Calendar isn't connected
            </p>
            <p className="text-xs text-ink-3 mt-1 max-w-sm mx-auto">
              Connect your work Google account in Settings → Integrations so this client's
              events appear here automatically, linked by their email.
            </p>
            <button onClick={() => navigate('/settings?section=integrations')}
              className="mt-3 text-xs font-semibold text-indigo-600 hover:text-indigo-700">Go to Settings →</button>
          </div>
        ) : (gcalEvents.events || []).length === 0 ? (
          <div className="text-center py-8 bg-panel border border-hairline rounded-xl px-4">
            <Calendar className="w-7 h-7 mx-auto mb-2 text-ink-3" />
            <p className="text-sm text-ink-3">
              No Google Calendar events linked to {gcalEvents.client_email || 'this client'} yet.
            </p>
            {!gcalEvents.client_email && (
              <p className="text-[11px] text-ink-3 mt-1">Add an email to this client so their events link automatically.</p>
            )}
            <button onClick={onAddAppointment}
              className="mt-3 text-xs font-semibold text-indigo-600 hover:text-indigo-700">+ Add appointment</button>
          </div>
        ) : (
          <div className="space-y-2">
            {gcalEvents.events.map(ev => <GcalEventRow key={ev.id} ev={ev} />)}
          </div>
        )}
      </div>

      {/* Two separate facts were living under one "Google Calendar" banner:
          sync state (synced / invites sent, which really is about the
          calendar) and visit-history counts (upcoming / completed /
          cancelled, which aren't — a client with a long-running biweekly
          series can rack up a double-digit cancelled count purely from
          ordinary this-visit-only reschedules, and showing that in red under
          a calendar icon reads as a sync failure that isn't there). Split
          into two quiet hairline rows (owner: no solid tinted banners) so
          "cancelled" reads as visit history, not a calendar alarm. */}
      {visitStats && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-hairline bg-panel text-[12.5px] flex-wrap">
            <Calendar className="w-3.5 h-3.5 text-ink-3 shrink-0" />
            <span className="text-ink-2 font-medium">Google Calendar</span>
            <span className="text-ink-3">·</span>
            <span className="text-ink"><strong>{visitStats.gcal_synced}</strong> synced</span>
            <span className="text-ink-3">·</span>
            <span className="text-ink"><strong>{visitStats.invites_sent}</strong> invites sent</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-hairline bg-panel text-[12.5px] flex-wrap">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-indigo-400" aria-hidden="true" />
            <span className="text-ink-2 font-medium">Visit history</span>
            <span className="text-ink-3">·</span>
            <span className="text-ink"><strong>{visitStats.upcoming}</strong> upcoming</span>
            <span className="text-ink-3">·</span>
            <span className="text-ink"><strong>{visitStats.completed}</strong> completed</span>
            {visitStats.cancelled > 0 && (
              <>
                <span className="text-ink-3">·</span>
                <span className="text-ink-2"><strong>{visitStats.cancelled}</strong> cancelled</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Native fallback — only when Google isn't connected, so the profile is
          never blank. Once connected, the linked Google events above are the
          single source of truth (Twenty-style). */}
      {gcalEvents.connected === false && (<>
      {/* Mini month calendar */}
      <div className="bg-panel border border-hairline rounded-xl p-5">
        {/* Month nav */}
        <div className="flex items-center justify-between mb-3">
          <button onClick={prevMonth} className="p-2 hover:bg-bg-2 rounded-lg text-ink-3 hover:text-ink-2">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-ink-2">{MONTH_NAMES[month]} {year}</span>
          <button onClick={nextMonth} className="p-2 hover:bg-bg-2 rounded-lg text-ink-3 hover:text-ink-2">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {MINI_DAYS.map(d => (
            <div key={d} className="text-center text-[10px] font-medium text-ink-3 py-1">{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((date, i) => {
            if (!date) return <div key={i} className="h-9" />

            const dayNum = parseInt(date.slice(8))
            const isToday = date === todayStr
            const isSelected = date === selectedDate
            const dayJobs = jobsByDate[date] || []
            const hasJobs = dayJobs.length > 0

            return (
              <button
                key={date}
                onClick={() => setSelectedDate(selectedDate === date ? null : date)}
                className={`h-9 flex flex-col items-center justify-center rounded-lg text-xs transition-all relative ${
                  isSelected
                    ? 'bg-indigo-600 text-white'
                    : isToday
                    ? 'bg-blue-500/10 text-blue-600 font-semibold'
                    : hasJobs
                    ? 'hover:bg-bg-2 text-ink-2 font-medium'
                    : 'hover:bg-bg text-ink-3'
                }`}
              >
                {dayNum}
                {/* Job indicator dots */}
                {hasJobs && (
                  <div className="flex gap-0.5 mt-0.5">
                    {dayJobs.slice(0, 3).map((j, idx) => (
                      <span
                        key={idx}
                        className={`w-1 h-1 rounded-full ${isSelected ? 'bg-panel/70' : (JOB_TYPE_DOT[j.job_type] || 'bg-blue-500')}`}
                      />
                    ))}
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 mt-3 pt-3 border-t border-hairline">
          {Object.entries(JOB_TYPE_DOT).map(([type, color]) => (
            <span key={type} className="flex items-center gap-1 text-[10px] text-ink-3">
              <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
              {JOB_TYPE_LABEL[type]}
            </span>
          ))}
        </div>
      </div>

      {/* Event list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">
            {selectedDate
              ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'Upcoming Cleanings'}
          </h3>
          {selectedDate && (
            <button onClick={() => setSelectedDate(null)} className="text-[10px] text-ink-3 hover:text-ink-3">
              Show all upcoming
            </button>
          )}
        </div>

        {listJobs.length === 0 ? (
          <div className="text-center py-10 bg-panel border border-hairline rounded-xl">
            <Calendar className="w-8 h-8 mx-auto mb-2 text-ink-3" />
            <p className="text-sm text-ink-3">
              {selectedDate ? 'No cleanings on this day' : 'No upcoming cleanings'}
            </p>
            <button onClick={() => navigate(`/scheduling?client_id=${clientId}`)}
              className="mt-3 text-xs text-indigo-600 hover:text-indigo-600 font-medium">
              + Schedule a cleaning
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {listJobs.map(j => {
              const dotColor = JOB_TYPE_DOT[j.job_type] || 'bg-blue-500'
              const statusPill = STATUS_PILL[j.status] || STATUS_PILL.scheduled
              const isPast = j.scheduled_date < todayStr

              return (
                <div key={j.id} onClick={() => onEditJob?.(j)}
                  className={`bg-panel border border-hairline rounded-xl p-4 flex items-start gap-3 transition-colors hover:border-blue-300 hover:shadow-sm cursor-pointer ${isPast ? 'opacity-60' : ''}`}
                  title="Click to edit / reschedule / cancel">
                  {/* Color bar */}
                  <div className={`w-1 self-stretch rounded-full shrink-0 ${dotColor}`} />

                  {/* Date block */}
                  <div className="text-center w-12 shrink-0 pt-0.5">
                    <div className="text-xs font-bold text-ink-2">
                      {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                    <div className="text-[10px] text-ink-3">
                      {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                    </div>
                  </div>

                  {/* Job info */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-ink truncate">{j.title}</div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-ink-3">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {j.start_time} – {j.end_time}
                      </span>
                      <span className="text-[10px] text-ink-3">|</span>
                      <span>{JOB_TYPE_LABEL[j.job_type] || j.job_type}</span>
                    </div>
                    {j.property_name && (
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-indigo-500 truncate">
                        <Home className="w-3 h-3 shrink-0" />{j.property_name}
                      </div>
                    )}
                    {j.address && (
                      <div className="flex items-center gap-1 mt-0.5 text-[11px] text-ink-3 truncate">
                        <MapPin className="w-3 h-3 shrink-0" />{j.address}
                      </div>
                    )}
                  </div>

                  {/* Status + indicators */}
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <span className="inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-sm border border-hairline-2 bg-panel font-medium text-ink-2 capitalize">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusPill}`} aria-hidden="true" />
                      {j.status?.replace('_', ' ')}
                    </span>
                    <div className="flex gap-1">
                      {j.gcal_event_id && <span title="On Google Calendar" className="w-3.5 h-3.5 rounded-full bg-indigo-100 flex items-center justify-center text-[8px] text-indigo-500 font-bold">G</span>}
                      {j.calendar_invite_sent && <span title="Invite sent" className="w-3.5 h-3.5 rounded-full bg-emerald-100 flex items-center justify-center text-[8px] text-emerald-500 font-bold">✓</span>}
                      {j.dispatched && <span title="Dispatched" className="w-3.5 h-3.5 rounded-full bg-blue-100 flex items-center justify-center text-[8px] text-blue-500 font-bold">D</span>}
                    </div>
                    {/* Opt-in: email the customer a calendar invite so the event lands on their calendar */}
                    {!isPast && clientEmail && !j.calendar_invite_sent && (
                      <button onClick={(e) => { e.stopPropagation(); inviteCustomer(j.id) }} disabled={invitingId === j.id}
                        className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border border-hairline-2 bg-panel text-ink-2 hover:bg-bg-2 disabled:opacity-50 transition-colors"
                        title={`Invite ${clientEmail} to this event`}>
                        <Mail className="w-2.5 h-2.5" /> {invitingId === j.id ? 'Inviting…' : 'Invite'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      </>)}
    </div>
  )
}
