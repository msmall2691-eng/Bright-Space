/**
 * Home's four snapshot boxes — "a full snapshot of all important aspects".
 *
 * Money & hours today · Crew today · Turnover feeds · Recurring series.
 *
 * These are PURE VIEWS. Every number arrives inside the board payload
 * (`data.snapshot`, built by backend/services/board_snapshot.py), so four
 * boxes cost zero extra requests — Home already fetches /api/dashboard/board
 * once (brightbase-economy: one fetch per screen per need).
 *
 * Design: the same quiet chrome as the other Home widgets — hairline card,
 * a 6px semantic dot, 11px sentence-case labels, plain ink numbers. No pills,
 * no tinted banners, no count bubbles. Every name that identifies a record
 * (a house, a series, a cleaner's day) links to it.
 *
 * Each box renders NOTHING when its subject doesn't exist for this business
 * (no short-term-rental feeds, no recurring series). An empty box on Home is
 * a permanent piece of furniture that never tells you anything.
 */
import { Link } from 'react-router-dom'

/* ── shared chrome ────────────────────────────────────────────────────────── */

function Box({ dot = 'bg-indigo-500', title, right, children }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <h2 className="text-[11px] font-medium text-ink-3">{title}</h2>
        {right != null && (
          <span className="ml-auto text-[11px] tabular-nums text-ink-3">{right}</span>
        )}
      </header>
      {children}
    </section>
  )
}

/** One quiet stat: big plain number, small sentence-case label underneath. */
function Stat({ label, value, sub, tone = 'text-ink', className = '' }) {
  return (
    <div className={`min-w-0 px-3.5 py-2.5 ${className}`}>
      <div className={`text-[19px] font-semibold leading-none tabular-nums ${tone}`}>{value}</div>
      <div className="mt-1 truncate text-[11px] text-ink-3">{label}</div>
      {sub ? <div className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</div> : null}
    </div>
  )
}

// `touch-none` clears the global 44px min-height index.css puts on every <a>
// (a mobile tap-target rule). These links sit inside two-line rows that are
// already a comfortable target; without the opt-out each one-line link
// inflates its row to 44px and the card sprouts a dead band underneath.
const RECORD_LINK = 'touch-none truncate text-[13px] text-ink no-underline hover:text-indigo-600'
const META_LINK = 'touch-none shrink-0 truncate text-[11px] text-ink-3 no-underline hover:text-indigo-600'

function Row({ children }) {
  return <div className="flex items-baseline gap-2 px-3.5 py-2">{children}</div>
}

function Foot({ children }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline px-3.5 py-2">
      {children}
    </div>
  )
}

function FootLink({ to, children }) {
  return (
    <Link to={to}
      className="touch-sm inline-flex items-center text-[11px] text-ink-2 no-underline hover:text-indigo-600">
      {children}
    </Link>
  )
}

/* ── 1. Money & hours today ───────────────────────────────────────────────── */

export function MoneyToday({ snap }) {
  if (!snap) return null
  const { collected, collected_label, invoiced_label, hours_label,
          on_clock, visits_done, visits_total } = snap

  // Before the first job of the day there is no money, no hours and no
  // finished visits — a 2x2 grid of zeroes taking a full card to say
  // "nothing yet". One quiet line says the same thing.
  const quiet = !collected && !snap.invoiced && !snap.hours && !visits_total
  if (quiet) {
    return (
      <Box dot="bg-ink-3" title="Today">
        <p className="px-3.5 py-2.5 text-[12px] text-ink-3">
          Nothing booked and nothing collected yet today.
        </p>
      </Box>
    )
  }

  return (
    <Box dot="bg-emerald-500" title="Today">
      {/* 2×2 so the four numbers read as one glance, not a list to scan.
          Borders are per-cell rather than `divide-*`: on a grid, divide-x/y
          paint a left border on the first cell of every row. */}
      <div className="grid grid-cols-2">
        <Stat className="border-b border-r border-hairline"
          label="Collected" value={collected_label}
          tone={collected > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink'} />
        <Stat className="border-b border-hairline"
          label="Billed today" value={invoiced_label} />
        {/* An open punch has no duration yet, so it is reported, never added. */}
        <Stat className="border-r border-hairline"
          label="Crew hours" value={hours_label}
          sub={on_clock ? `${on_clock} still on the clock` : null} />
        <Stat label={visits_total ? 'Visits done' : 'Visits'}
          value={visits_total ? `${visits_done}/${visits_total}` : '—'}
          sub={visits_total ? null : 'nothing booked'} />
      </div>
    </Box>
  )
}

/* ── 2. Crew today ────────────────────────────────────────────────────────── */

export function CrewToday({ snap }) {
  if (!snap) return null
  const { working, working_total, off, off_total, pending_requests, unassigned_today } = snap
  if (!working_total && !off_total && !unassigned_today && !pending_requests) return null

  return (
    <Box title="Crew today"
      right={working_total ? `${working_total} working` : 'nobody scheduled'}>
      <div className="divide-y divide-hairline">
        {working.map(c => (
          <Row key={`on-${c.cleaner_id}`}>
            <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-emerald-500" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{c.name}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-ink-3">
              {c.done ? `${c.done}/${c.jobs} done` : `${c.jobs} ${c.jobs === 1 ? 'job' : 'jobs'}`}
            </span>
          </Row>
        ))}
        {off.map(c => (
          <Row key={`off-${c.cleaner_id}`}>
            <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-amber-500" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{c.name}</span>
            <span className="shrink-0 truncate text-[11px] text-ink-3">{c.reason}</span>
          </Row>
        ))}
        {working_total > working.length && (
          <Row>
            <span className="text-[11px] text-ink-3">
              +{working_total - working.length} more working
            </span>
          </Row>
        )}
      </div>

      {(unassigned_today > 0 || pending_requests > 0) && (
        <Foot>
          {unassigned_today > 0 && (
            <FootLink to="/schedule?view=dispatch">
              {unassigned_today} {unassigned_today === 1 ? 'visit' : 'visits'} with nobody on it
            </FootLink>
          )}
          {pending_requests > 0 && (
            <FootLink to="/schedule?tab=availability">
              {pending_requests} time-off {pending_requests === 1 ? 'request' : 'requests'} to decide
            </FootLink>
          )}
        </Foot>
      )}
    </Box>
  )
}

/* ── 3. Turnover feed health ──────────────────────────────────────────────── */

const FEED_DOT = { failing: 'bg-rose-500', never: 'bg-ink-3', stale: 'bg-amber-500' }

export function FeedHealth({ snap }) {
  // No short-term-rental calendars connected → this box has no subject.
  if (!snap || !snap.total) return null
  const { total, ok, problems, problem_total } = snap

  return (
    <Box dot={problem_total ? 'bg-amber-500' : 'bg-emerald-500'}
      title="Turnover feeds"
      right={`${ok}/${total} feeding`}>
      {problem_total === 0 ? (
        /* Nothing wrong = nothing to say. The header already reads
           "6/6 feeding"; a paragraph repeating that in words was a whole
           card of reassurance nobody needs to read twice. */
        null
      ) : (
        <div className="divide-y divide-hairline">
          {problems.map(p => (
            <div key={p.id} className="px-3.5 py-2">
              <div className="flex items-baseline gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${FEED_DOT[p.state] || 'bg-ink-3'}`} />
                {/* Straight to that house's feed list — the place the fix is. */}
                <Link to={`/properties/${p.property_id}/icals`} className={`${RECORD_LINK} flex-1`}>
                  {p.property_name}
                </Link>
                <span className="shrink-0 text-[11px] text-ink-3">{p.source}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 pl-3.5 text-[11px] leading-snug text-ink-3">{p.detail}</p>
            </div>
          ))}
        </div>
      )}
      {problem_total > problems.length && (
        <Foot>
          <FootLink to="/sync">
            +{problem_total - problems.length} more · open Sync Center
          </FootLink>
        </Foot>
      )}
    </Box>
  )
}

/* ── 4. Recurring series that stopped generating ──────────────────────────── */

export function RecurringHealth({ snap }) {
  if (!snap || !snap.scanned) return null
  const { scanned, stalled, stalled_total } = snap

  return (
    <Box dot={stalled_total ? 'bg-amber-500' : 'bg-emerald-500'}
      title="Recurring series"
      right={`${scanned} total`}>
      {stalled_total === 0 ? (
        null
      ) : (
        <div className="divide-y divide-hairline">
          {stalled.map(s => (
            <div key={s.schedule_id} className="px-3.5 py-2">
              <div className="flex items-baseline gap-2">
                <span className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full bg-amber-500" />
                <Link to="/recurring" className={`${RECORD_LINK} flex-1`}>{s.title}</Link>
                {s.client_id ? (
                  <Link to={`/clients/${s.client_id}`} className={META_LINK}>
                    {s.client_name}
                  </Link>
                ) : null}
              </div>
              <p className="mt-0.5 line-clamp-2 pl-3.5 text-[11px] leading-snug text-ink-3">{s.message}</p>
            </div>
          ))}
        </div>
      )}
      {stalled_total > stalled.length && (
        <Foot>
          <FootLink to="/recurring">
            +{stalled_total - stalled.length} more · open Recurring
          </FootLink>
        </Foot>
      )}
    </Box>
  )
}
