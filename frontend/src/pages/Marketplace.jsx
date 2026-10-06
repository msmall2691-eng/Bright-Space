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
 * LAYOUT IS A BENTO, NOT A STACK OF BANDS (brightbase-ui-revamp). The page used
 * to be five full-width bands scrolling down past a lot of empty desk. It is
 * now two packing columns at shell: — the work flowing through the board
 * (what's waiting on you, what's open to the bench) on the left, the state of
 * the bench itself (who's cleared, what's owed, the front door) on the right —
 * so the eye takes the whole hub in at ~940px without a scroll. Collapses to
 * one column on a phone. Boxes carry the canonical quiet chrome (in-card
 * dot+word header over hairline-divided rows) the rest of the office wears.
 *
 * ONE REQUEST draws the whole page (brightbase-economy). A hub costing four
 * round trips would be worse than the five pages it gathers.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Store } from 'lucide-react'
import { get } from '../api'
import { PageTitle, ErrorState, Skeleton } from '../components/ui'
import { STATUS_DOT } from '../theme/statusDots'

const money = (n) => `$${(Number(n) || 0).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * One box of the bento. Canonical quiet chrome: a hairline card with an
 * in-card header — a 6px semantic dot, a quiet uppercase label, an optional
 * plain ink-3 count (never a bubble), and a right-aligned link to the screen
 * that owns the full set. The body (rows / a quiet line / the apply card)
 * sits directly under it, no box-in-box.
 */
function Box({ dot = 'bg-ink-3/40', title, count, to, linkLabel, shortLabel, children }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel">
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-3.5 py-2.5">
        <h2 className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          <span className={`relative top-px h-1.5 w-1.5 shrink-0 self-center rounded-full ${dot}`}
            aria-hidden="true" />
          <span>{title}</span>
          {/* A plain ink-3 number, never a bubble. */}
          {count > 0 && <span className="font-normal tabular-nums">{count}</span>}
        </h2>
        {to && (
          <Link to={to}
            className="shrink-0 text-[12px] text-ink-3 no-underline hover:text-link">
            {/* Two lengths. On a phone the full sentence ran off the screen
                edge and clipped mid-word; the short form says the same thing
                in the space there is. */}
            <span className="sm:hidden">{shortLabel || linkLabel}</span>
            <span className="hidden sm:inline">{linkLabel}</span>
          </Link>
        )}
      </header>
      {children}
    </section>
  )
}

/** One line of a box: a dot, a sentence, and somewhere to go. */
function Row({ dot = 'bg-ink-3/40', to, children, right }) {
  // The meta used to sit OUTSIDE the link, which meant tapping the date on a
  // phone did nothing — half the row looked tappable and wasn't. It is inside
  // now, so the whole row is one target.
  //
  // And it stacks under the text below `sm`. Held on the right, a long title
  // wrapped around it and left the date stranded on its own line beside a gap
  // ("The Pier House · Old Orchard Beach ·" / "nobody yet").
  const body = (
    <span className="flex w-full flex-col gap-x-3 gap-y-0.5 sm:flex-row sm:items-start sm:justify-between">
      <span className="flex min-w-0 items-start gap-2">
        <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="min-w-0 wrap-break-word">{children}</span>
      </span>
      {right && (
        // pl-3.5 lines the meta up under the text, clear of the dot.
        <span className="shrink-0 pl-3.5 text-[12px] text-ink-3 sm:pl-0 sm:text-right">
          {right}
        </span>
      )}
    </span>
  )
  return (
    <li className="border-b border-hairline/60 text-[13px] text-ink-2 last:border-0">
      {to ? (
        <Link to={to}
          className="flex px-3.5 py-2.5 text-ink-2 no-underline transition-colors hover:bg-bg-2 hover:text-link">
          {body}
        </Link>
      ) : (
        <span className="flex px-3.5 py-2.5">{body}</span>
      )}
    </li>
  )
}

/** The hairline-divided list that fills a box. No border of its own — the box
 *  already carries one, and a second would be box-in-box. */
function List({ children }) {
  return <ul>{children}</ul>
}

/** A quiet sentence where a whole box would otherwise be empty furniture. */
function Quiet({ children }) {
  return <p className="px-3.5 py-3 text-[13px] text-ink-3">{children}</p>
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
      <div className="max-w-5xl px-4 sm:px-8">
        <ErrorState title="Couldn’t load the marketplace" description={error} onRetry={load} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="max-w-5xl space-y-4 px-4 pt-4 sm:px-8">
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-4 shell:grid-cols-[1.5fr_1fr]">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    )
  }

  const { waiting, bench, money: cash } = data
  const nothingWaiting = !waiting.application_count && !waiting.job_count

  return (
    <div className="max-w-5xl">
      {/* PageTitle, not PageHeader. PageHeader is a legacy alias that forwards
          title/subtitle/icon/actions/children and nothing else — `stats` went
          in and never came out, so the four numbers this page opens with were
          silently missing. It also means supplying the padding it used to. */}
      <PageTitle
        className="px-4 pt-4 pb-3 sm:px-8 sm:pt-5"
        title="Marketplace"
        subtitle="Who cleans for you, what work is open to them, and what they’re owed."
        icon={Store}
        stats={[
          { label: 'On the bench', value: bench.people },
          { label: 'Cleared', value: bench.can_work,
            tone: bench.can_work ? undefined : 'warn' },
          { label: 'Open jobs', value: data.open_job_count },
        ]}
      />

      {/* px on the body too. Without it every row ran edge to edge and the
          section links clipped mid-word on a phone. */}
      <div className="px-4 pb-6 sm:px-8">
        {/* The bento. Two packing columns at shell: (the owner's ~940px window),
            one column on a phone. Columns are flex stacks, not grid cells, so a
            short box sits directly on the next instead of being height-locked to
            the tallest box in its row (brightbase-ui-revamp: pack, don't lock).
            bb-board-in is the shared 0.28s ease-out entrance, already disabled
            under prefers-reduced-motion. */}
        <div className="bb-board-in grid gap-4 shell:grid-cols-[1.5fr_1fr] shell:items-start">
          {/* ── Column A — the work flowing through the board ───────────────── */}
          <div className="flex flex-col gap-4">
            <Box
              dot={nothingWaiting ? 'bg-ink-3/40' : STATUS_DOT.attention}
              title="Waiting on you"
              count={waiting.application_count + waiting.people_waiting}>
              {nothingWaiting ? (
                <Quiet>Nobody’s waiting on an answer.</Quiet>
              ) : (
                <>
                  <List>
                    {waiting.jobs.map(j => (
                      /* Amber: somebody asked for this job and is sitting there.
                         The link goes to the job, which is where answering lives
                         — this page never approves anything. */
                      <Row key={`job-${j.job_id}`} dot={STATUS_DOT.attention} to={`/jobs/${j.job_id}`}
                        right={fmtDate(j.scheduled_date)}>
                        <span className="flex flex-col gap-1">
                          <span>
                            <span className="text-ink">{plural(j.asked, 'person', 'people')}</span>
                            {' asked for '}{j.title}
                            {j.client ? ` · ${j.client}` : ''}
                          </span>
                          {/* Who asked and at what price, so a job can be sized
                              up without opening it. A pushy ask (BB-CLAIM-02)
                              carries the same amber dot + word as the office
                              review — never a pill or a tinted bar. Tapping still
                              goes to the job to decide; the office never approves
                              from here. */}
                          {j.askers?.length > 0 && (
                            <span className="flex flex-col gap-0.5">
                              {j.askers.map((a, i) => (
                                <span key={i} className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
                                  <span className="text-ink-2">{a.name}</span>
                                  {a.rate != null && (
                                    <span>· {money(a.rate)}{a.countered ? '' : ' · your price'}</span>
                                  )}
                                  {a.high_bid && (
                                    <span className="flex items-center gap-1 text-ink-2">
                                      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT.attention}`} aria-hidden="true" />
                                      over asking
                                    </span>
                                  )}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </Row>
                    ))}
                    {waiting.applications.map(a => (
                      <Row key={`app-${a.id}`} dot={STATUS_DOT.attention} to="/crew"
                        right="Review on Crew">
                        <span className="text-ink">{a.name}</span>
                        {' applied to join'}{a.towns ? ` · ${a.towns}` : ''}
                      </Row>
                    ))}
                  </List>
                  {waiting.job_count > waiting.jobs.length && (
                    <p className="border-t border-hairline/60 px-3.5 py-2 text-[12px] text-ink-3">
                      …and {waiting.job_count - waiting.jobs.length} more on the schedule.
                    </p>
                  )}
                </>
              )}
            </Box>

            {/* Count lives in the header stat ("Open jobs"); repeating it on the
                box header is the redundancy the owner flagged by name. */}
            <Box
              dot={data.open_jobs.length ? 'bg-violet-500' : 'bg-ink-3/40'}
              title="Open to the bench"
              to="/schedule" linkLabel="Post more on the schedule" shortLabel="Schedule">
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
                      dot={j.asked ? STATUS_DOT.attention : 'bg-violet-500'}
                      right={[
                        fmtDate(j.scheduled_date),
                        j.posted_rate ? money(j.posted_rate) : null,
                        j.asked ? `${plural(j.asked, 'person', 'people')} asked` : 'nobody yet',
                      ].filter(Boolean).join(' · ')}>
                      {/* Title line stays what and where. When, how much and who
                          has asked are all the same kind of fact and belong
                          together on the meta line. */}
                      <span className="text-ink">{j.title}</span>
                      {j.town ? ` · ${j.town}` : ''}
                    </Row>
                  ))}
                </List>
              )}
            </Box>
          </div>

          {/* ── Column B — the state of the bench itself ────────────────────── */}
          <div className="flex flex-col gap-4">
            {/* Count lives in the header stat ("On the bench"). */}
            <Box
              dot={bench.people === 0 ? 'bg-ink-3/40'
                : bench.can_work ? STATUS_DOT.ok : STATUS_DOT.attention}
              title="The bench" to="/crew"
              linkLabel="Manage on Crew" shortLabel="Crew">
              {bench.people === 0 ? (
                <Quiet>
                  Nobody on the bench yet. Share the application link below and
                  approve the people you want.
                </Quiet>
              ) : (
                <List>
                  <Row dot={bench.can_work ? STATUS_DOT.ok : STATUS_DOT.attention} to="/crew">
                    <span className="text-ink">{bench.can_work}</span>
                    {` of ${bench.people} cleared to work`}
                    <span className="text-ink-3"> — insurance and paperwork accepted</span>
                  </Row>
                  {bench.awaiting_review > 0 && (
                    <Row dot={STATUS_DOT.attention} to="/crew">
                      <span className="text-ink">{bench.awaiting_review}</span>
                      {' waiting on you to review a document'}
                    </Row>
                  )}
                  {bench.blocked > 0 && (
                    <Row dot={STATUS_DOT.problem} to="/crew">
                      <span className="text-ink">{bench.blocked}</span>
                      {' can’t take jobs — something on file expired or was rejected'}
                    </Row>
                  )}
                  <Row dot={bench.direct_deposit ? STATUS_DOT.ok : 'bg-ink-3/40'} to="/payroll">
                    <span className="text-ink">{bench.direct_deposit}</span>
                    {` of ${bench.people} set up for direct deposit`}
                    <span className="text-ink-3">
                      {' — the rest get paid however you pay them today'}
                    </span>
                  </Row>
                </List>
              )}
            </Box>

            <Box
              dot={cash.owed > 0 ? STATUS_DOT.attention : STATUS_DOT.ok}
              title="Money" to="/payroll" linkLabel="Open Payouts" shortLabel="Payouts">
              <List>
                <Row dot={cash.owed > 0 ? STATUS_DOT.attention : STATUS_DOT.ok} to="/payroll"
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
            </Box>

            <Box dot="bg-indigo-500" title="The front door">
              <ApplyLink />
            </Box>
          </div>
        </div>
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
 *
 * No border of its own — it lives inside its box, which already has one.
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
    <div className="px-3.5 py-3">
      <p className="text-[13px] text-ink-2">
        Where new cleaners get set up. It needs no login — share it anywhere.
      </p>
      <div className="mt-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center">
        {/* break-all, not truncate. A truncated URL on a phone shows half an
            address and no way to read the rest — and this is the one string on
            the page somebody might type out by hand. */}
        <a href="/apply" target="_blank" rel="noreferrer"
          className="min-w-0 break-all text-[13px] text-ink no-underline hover:text-link">
          {url}
        </a>
        <button type="button" onClick={copy}
          className="shrink-0 rounded-md border border-hairline-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2"
          aria-label={copied ? 'Application link copied' : 'Copy the application link'}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}
