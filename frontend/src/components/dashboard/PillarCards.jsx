import { Inbox, MessageSquare, CalendarDays, ArrowRight } from 'lucide-react'
import { Skeleton } from '../ui'
import { SOFT_CARD } from './constants'

/**
 * The three pillars the business runs on, as big tappable hero cards at the
 * top of Home: Leads (win the work), Messages (talk to customers), and
 * Schedule (get it done). Each card leads with the one number that matters,
 * a couple of supporting stats, and an optional urgent pill, then routes to
 * its home page. This is the "focused around leads, communication, and
 * scheduling" spine of the redesigned dashboard.
 */

/** One pillar card. `accent` drives the icon chip + hover ring tint; the
 *  gradient wash is a faint theme-aware tint so the card reads as a hero
 *  surface without shouting. */
function Pillar({ icon: Icon, accent, label, value, headline, stats, urgent, onClick, loading }) {
  const A = ACCENTS[accent]
  return (
    <button
      onClick={onClick}
      className={`group relative text-left ${SOFT_CARD} p-5 overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-glass-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${A.ring}`}
    >
      {/* Faint corner wash so each pillar has its own color identity. */}
      <span className={`pointer-events-none absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl opacity-60 ${A.wash}`} />

      <div className="relative flex items-start justify-between gap-3">
        {/* Flat glyph — no tinted icon chip (owner's SaaS-bubble veto). */}
        <Icon className="w-5 h-5 shrink-0 text-ink-3" />
        <span className="flex items-center gap-2">
          {urgent > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-red-600 dark:text-red-300">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" />
              {urgent} urgent
            </span>
          )}
          <ArrowRight className="w-4 h-4 text-ink-3 group-hover:text-ink-2 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>

      <div className="relative mt-4">
        {loading ? (
          <Skeleton className="h-9 w-16" />
        ) : (
          <div className="text-[32px] leading-none font-bold tabular-nums text-ink">{value}</div>
        )}
        <div className="mt-1.5 text-sm font-semibold text-ink">{headline}</div>
        <div className="mt-0.5 text-xs text-ink-3">{label}</div>
      </div>

      {stats?.length > 0 && (
        <div className="relative mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline pt-3">
          {stats.map((s, i) => (
            <span key={i} className="text-[11px] text-ink-3">
              <span className={`font-bold tabular-nums ${s.tone || 'text-ink-2'}`}>{loading ? '—' : s.n}</span>{' '}
              {s.label}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

const ACCENTS = {
  indigo: {
    chip: 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
    wash: 'bg-indigo-400/25',
    ring: 'focus-visible:ring-indigo-500',
  },
  blue: {
    chip: 'bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300',
    wash: 'bg-blue-400/25',
    ring: 'focus-visible:ring-indigo-500',
  },
  emerald: {
    chip: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    wash: 'bg-emerald-400/25',
    ring: 'focus-visible:ring-emerald-500',
  },
}

export function PillarCards({ loading, leads, messages, schedule, navigate }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
      <Pillar
        icon={Inbox}
        accent="indigo"
        loading={loading}
        value={leads.newLeads}
        headline={leads.newLeads === 1 ? 'new lead to quote' : 'new leads to quote'}
        label="Turn inquiries into booked work"
        urgent={leads.newLeads}
        stats={[
          { n: leads.followUp, label: 'to follow up', tone: leads.followUp > 0 ? 'text-amber-600 dark:text-amber-300' : undefined },
          { n: leads.awaiting, label: 'awaiting reply' },
        ]}
        onClick={() => navigate('/requests')}
      />
      <Pillar
        icon={MessageSquare}
        accent="blue"
        loading={loading}
        value={messages.needsReply}
        headline={messages.needsReply === 1 ? 'conversation needs a reply' : 'conversations need a reply'}
        label="Keep customers in the loop"
        urgent={messages.slaBreached}
        stats={[
          { n: messages.slaBreached, label: 'past SLA', tone: messages.slaBreached > 0 ? 'text-red-600 dark:text-red-300' : undefined },
          { n: messages.unassigned, label: 'unassigned' },
        ]}
        onClick={() => navigate('/comms')}
      />
      <Pillar
        icon={CalendarDays}
        accent="emerald"
        loading={loading}
        value={schedule.today}
        headline={schedule.today === 1 ? 'job today' : 'jobs today'}
        label="Keep the crews on track"
        urgent={schedule.needCrew}
        stats={[
          { n: schedule.week, label: 'this week' },
          { n: schedule.needCrew, label: 'need a crew', tone: schedule.needCrew > 0 ? 'text-amber-600 dark:text-amber-300' : undefined },
        ]}
        onClick={() => navigate('/schedule')}
      />
    </div>
  )
}
