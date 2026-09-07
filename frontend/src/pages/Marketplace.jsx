/**
 * Marketplace — the bench, in one place.
 *
 * WHY THIS PAGE EXISTS, in the owner's words: *"where can i view the
 * marketplace page lol"*. It had shipped as five surfaces bolted onto pages
 * that already existed — applicants and the roster on Crew, open jobs and
 * waiting requests on Schedule and the dashboard, standing work on Routes,
 * money on Payouts. Every piece worked. Nobody could find any of it, which
 * makes it not really shipped.
 *
 * IT IS A HUB, NOT A SIXTH PLACE TO DO THE WORK. Every row links to the
 * screen that already owns that action. That restraint is partly a safety
 * property: answering a claim request is the one path where "a sub requests,
 * the office never assigns" is enforced, and a second implementation of it is
 * a second place to get worker classification wrong (brightbase-marketplace,
 * Rule 0). So this page reads and links; it never approves.
 *
 * ORDERED BY WHO IS BLOCKED ON WHOM. "Waiting on you" is first because it is
 * the only section where a person is held up by the office rather than the
 * other way round — somebody asked for a job, or asked to join, and is
 * sitting there. Everything below it is the office looking at its own state.
 *
 * ONE REQUEST draws the whole page (brightbase-economy). A hub costing four
 * round trips would be worse than the five pages it gathers.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Store } from 'lucide-react'
import { get } from '../api'
import { PageHeader, ErrorState, Skeleton } from '../components/ui'

const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** Section heading + an optional link to the screen that owns the actions. */
function Section({ title, count, to, linkLabel, children }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          {title}
          {/* A plain ink-3 number, never a bubble. */}
          {count > 0 && <span className="ml-2 font-normal tabular-nums">{count}</span>}
        </h2>
        {to && (
          <Link to={to} className="text-[12px] text-ink-3 no-underline hover:text-indigo-600">
            {linkLabel}
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

/** One line of the page: a dot, a sentence, and somewhere to go. */
function Row({ dot = 'bg-ink-3/40', to, children, right }) {
  const body = (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </span>
  )
  return (
    <li className="flex items-start justify-between gap-3 border-b border-hairline/60 px-3 py-2 text-[13px] text-ink-2 last:border-0">
      {to ? (
        <Link to={to} className="flex min-w-0 flex-1 text-ink-2 no-underline hover:text-indigo-600">
          {body}
        </Link>
      ) : body}
      {right && <span className="shrink-0 text-[12px] text-ink-3">{right}</span>}
    </li>
  )
}

function List({ children }) {
  return (
    <ul className="overflow-hidden rounded-xl border border-hairline bg-panel">{children}</ul>
  )
}

/** A quiet sentence where a whole section would otherwise be an empty box. */
function Quiet({ children }) {
  return <p className="text-[13px] text-ink-3">{children}</p>
}

export default function Marketplace() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await get('/api/marketplace'))
    } catch (e) {
      setError(e?.detail || e?.message || String(e))
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (error) {
    return (
      <div className="max-w-4xl">
        <ErrorState title="Couldn’t load the marketplace" description={error} onRetry={load} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="max-w-4xl space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  const { waiting, bench, money: cash } = data
  const nothingWaiting = !waiting.application_count && !waiting.job_count

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Marketplace"
        subtitle="Who cleans for you, what work is open to them, and what they’re owed."
        icon={Store}
        stats={[
          { label: 'On the bench', value: bench.people },
          { label: 'Cleared to work', value: bench.can_work,
            tone: bench.can_work ? undefined : 'warn' },
          { label: 'Open jobs', value: data.open_job_count },
          { label: 'Owed', value: money(cash.owed),
            tone: cash.owed > 0 ? 'warn' : undefined },
        ]}
      />

      <div className="mt-5 space-y-6">
        <Section title="Waiting on you" count={waiting.application_count + waiting.people_waiting}>
          {nothingWaiting ? (
            <Quiet>Nobody’s waiting on an answer.</Quiet>
          ) : (
            <List>
              {waiting.jobs.map(j => (
                /* Amber: somebody asked for this job and is sitting there.
                   The link goes to the job, which is where answering lives —
                   this page never approves anything. */
                <Row key={`job-${j.job_id}`} dot="bg-amber-500" to={`/jobs/${j.job_id}`}
                  right={fmtDate(j.scheduled_date)}>
                  <span className="text-ink">{plural(j.asked, 'person', 'people')}</span>
                  {' asked for '}{j.title}
                  {j.client ? ` · ${j.client}` : ''}
                </Row>
              ))}
              {waiting.applications.map(a => (
                <Row key={`app-${a.id}`} dot="bg-amber-500" to="/crew"
                  right="Review on Crew">
                  <span className="text-ink">{a.name}</span>
                  {' applied to join'}{a.towns ? ` · ${a.towns}` : ''}
                </Row>
              ))}
            </List>
          )}
          {waiting.job_count > waiting.jobs.length && (
            <p className="mt-2 text-[12px] text-ink-3">
              …and {waiting.job_count - waiting.jobs.length} more on the schedule.
            </p>
          )}
        </Section>

        <Section title="Open to the bench" count={data.open_job_count}
          to="/schedule" linkLabel="Post more on the schedule">
          {data.open_jobs.length === 0 ? (
            <Quiet>
              No jobs are open right now. Open one to the bench from the schedule
              and everyone cleared to work can ask for it.
            </Quiet>
          ) : (
            <List>
              {data.open_jobs.map(j => (
                <Row key={j.job_id} to={`/jobs/${j.job_id}`}
                  /* Violet is "open to crew" in the shared vocabulary. */
                  dot={j.asked ? 'bg-amber-500' : 'bg-violet-500'}
                  right={[j.posted_rate ? money(j.posted_rate) : null, fmtDate(j.scheduled_date)]
                    .filter(Boolean).join(' · ')}>
                  <span className="text-ink">{j.title}</span>
                  {j.town ? ` · ${j.town}` : ''}
                  {j.asked
                    ? ` · ${plural(j.asked, 'person has', 'people have')} asked`
                    : ' · nobody yet'}
                </Row>
              ))}
            </List>
          )}
        </Section>

        <Section title="The bench" count={bench.people} to="/crew" linkLabel="Manage on Crew">
          {bench.people === 0 ? (
            <Quiet>
              Nobody on the bench yet. Share the application link below and
              approve the people you want.
            </Quiet>
          ) : (
            <List>
              <Row dot={bench.can_work ? 'bg-emerald-500' : 'bg-amber-500'} to="/crew">
                <span className="text-ink">{bench.can_work}</span>
                {` of ${bench.people} cleared to work`}
                <span className="text-ink-3"> — insurance and paperwork accepted</span>
              </Row>
              {bench.awaiting_review > 0 && (
                <Row dot="bg-amber-500" to="/crew">
                  <span className="text-ink">{bench.awaiting_review}</span>
                  {' waiting on you to review a document'}
                </Row>
              )}
              {bench.blocked > 0 && (
                <Row dot="bg-red-500" to="/crew">
                  <span className="text-ink">{bench.blocked}</span>
                  {' can’t take jobs — something on file expired or was rejected'}
                </Row>
              )}
              <Row dot={bench.direct_deposit ? 'bg-emerald-500' : 'bg-ink-3/40'} to="/payroll">
                <span className="text-ink">{bench.direct_deposit}</span>
                {` of ${bench.people} set up for direct deposit`}
                <span className="text-ink-3">
                  {' — the rest get paid however you pay them today'}
                </span>
              </Row>
            </List>
          )}
        </Section>

        <Section title="Money" to="/payroll" linkLabel="Open Payouts">
          <List>
            <Row dot={cash.owed > 0 ? 'bg-amber-500' : 'bg-emerald-500'} to="/payroll"
              right={money(cash.owed)}>
              {cash.owed > 0 ? 'Owed to subcontractors' : 'Nothing outstanding'}
              <span className="text-ink-3">
                {' — recorded on the ledger, not yet paid'}
              </span>
            </Row>
            <Row to="/payroll" right={money(cash.paid_ytd)}>
              {`Paid out in ${cash.year}`}
              <span className="text-ink-3">
                {' — by the date the work happened, which is what a 1099 counts'}
              </span>
            </Row>
          </List>
        </Section>

        <Section title="The front door">
          <ApplyLink />
        </Section>
      </div>
    </div>
  )
}

/**
 * The public application link.
 *
 * Here because it is the thing you actually want when you are looking at a
 * bench that is too small — the URL to put in a Facebook post or hand to
 * somebody at a job. Built from the browser's own origin rather than a
 * configured base URL, so it is always the address the person reading it is
 * already on and can never show a stale domain.
 */
function ApplyLink() {
  const [copied, setCopied] = useState(false)
  const url = typeof window === 'undefined' ? '/apply' : `${window.location.origin}/apply`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="rounded-xl border border-hairline bg-panel px-3 py-3">
      <p className="text-[13px] text-ink-2">
        Cleaners apply to join here. It needs no login — share it anywhere.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a href="/apply" target="_blank" rel="noreferrer"
          className="truncate text-[13px] text-ink no-underline hover:text-indigo-600">
          {url}
        </a>
        <button type="button" onClick={copy}
          className="rounded-md border border-hairline-2 bg-panel px-2 py-1 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2">
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}
