import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { SERIES_STATE_LABEL, isLiveSeries, seriesState } from '../../utils/recurringDuplicates'
import { computeUpcoming, fmtDate, fmtTime, ruleSummary } from './helpers'
import { ChevronRight, Pause, Pencil, Play } from 'lucide-react'
import { SEV_DOT } from '../board/tokens'
import { STATUS_TEXT } from '../../theme/statusText'

/**
 * One row in the Recurring series list.
 *
 * ## It used to be one big <button>, and that is why it had no actions
 *
 * The survey counted **zero inline actions on these rows** against 21
 * elsewhere on the surface — read-only rows on the one screen that lists every
 * series. The reason was structural rather than an oversight: the entire row
 * was a single `<button onClick={onOpen}>`, so there was nowhere to put a
 * second control. A `<button>` inside a `<button>` is invalid HTML and does
 * not reliably receive its own click, and the client-name `<Link>` was already
 * nested in there (interactive inside interactive) with a `stopPropagation` to
 * stop the row firing underneath it.
 *
 * So the card is now a plain element with the house row idiom
 * (`components/invoicing/InvoiceRow.jsx`): `cursor-pointer` + `onClick` for the
 * mouse, and the **title is the focusable control** that opens the series, so
 * a keyboard still reaches it with Tab and Enter. Actions sit beside it as
 * siblings, each stopping propagation.
 *
 * ## Pause / Resume takes no confirm, deliberately
 *
 * It is one PATCH, instantly reversible by the button that replaces it, and
 * the toast carries an Undo. A confirm on every pause would tax the loop to
 * guard something undoable — the same reasoning already recorded for Requests'
 * Archive in `docs/redesign-implementation.md`. Cancel (the irreversible one)
 * stays on the detail page behind its danger-zone dialog; it is not offered
 * from a list where a mis-click lands on the wrong row.
 *
 * ## Edit rule needs no extra fetch
 *
 * `GET /api/recurring` and `GET /api/recurring/{id}` return the SAME
 * `sched_to_dict`, so the row already holds every field `EditSeriesModal`
 * pre-fills from. Worth stating, because a partial payload here would not
 * error — it would pre-fill the form with fallback defaults and silently
 * narrow the rule on save. `__tests__/SeriesRow.editPayload.test.jsx` pins the
 * field list against the modal.
 */
export default function SeriesRow({ s, clientName, onOpen, isDuplicate, onTogglePause, onEdit, busy }) {
  const next = useMemo(() => {
    const up = computeUpcoming(s, [], 1)
    return up[0]?.date
  }, [s])
  const hasTime = !!s.start_time
  // Active-but-past-its-end-date (how split retires a predecessor: only
  // series_end_date is set, `active` stays true) reads as a quiet "Ended",
  // not as a live series.
  const live = isLiveSeries(s)
  const state = seriesState(s)
  // Pause/Resume is offered on the two states it can actually move between.
  // A cancelled series is not resumed by flipping `active` (cancelled_at stays
  // set, so it would still read as cancelled) and an ended one is past its end
  // date, so the button would promise a visit nothing generates.
  const canTogglePause = state === 'active' || state === 'paused'

  return (
    <li>
      <div
        onClick={() => onOpen(s.id)}
        className="group bg-panel border border-hairline rounded-lg px-4 py-2.5 cursor-pointer hover:bg-bg-2/60 transition"
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              {/* The row's keyboard target. Styled as the heading it is, so
                  nothing moves visually, but it is a real control: Tab lands
                  here and Enter opens the series. */}
              <button
                onClick={(e) => { e.stopPropagation(); onOpen(s.id) }}
                className="text-base font-semibold text-ink text-left rounded-md hover:text-link"
              >
                {s.title || 'Untitled'}
              </button>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <span className={`h-1.5 w-1.5 rounded-full ${live ? SEV_DOT.good : 'bg-ink-3'}`} />
                {SERIES_STATE_LABEL[state]}
              </span>
              {isDuplicate && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-2"
                  title="Another live series for this client has the same property, cadence, and time on an overlapping day — likely a duplicate. Open both and pause or cancel one.">
                  <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT.watch}`} />
                  Possible duplicate
                </span>
              )}
            </div>
            <p className="text-[13px] text-ink-2 truncate">
              {s.client_id ? (
                <Link to={`/clients/${s.client_id}`} onClick={e => e.stopPropagation()}
                  className="no-underline hover:text-link hover:underline">
                  {clientName}
                </Link>
              ) : clientName}
              {' · '}{s.address}
            </p>
            <p className="text-[12px] text-ink-3 mt-1">
              {ruleSummary(s)}
              {hasTime
                ? <> · {fmtTime(s.start_time)}–{fmtTime(s.end_time)}</>
                : <> · <span className={`${STATUS_TEXT.attention} font-medium`}>no time set</span></>}
              {next && live && <> · Next {fmtDate(next)}</>}
              <> · {s.upcoming_job_count || 0} upcoming</>
            </p>
          </div>

          {/* Row actions — hover-reveal on desktop, always visible on touch so
              they are reachable on a phone (the InvoiceRow pattern). Kept
              opacity-only rather than conditional rendering: a cluster that
              mounts on hover shifts the row's layout under the cursor.
              `group-focus-within` is the keyboard equivalent of the hover, so
              tabbing to an action reveals the cluster it is in.

              `w-full sm:w-auto` is load-bearing, and rendering the page at
              380px is what showed it: as an inline sibling the cluster took
              ~210px from a ~360px row, squeezing the text column to about a
              hundred — the title broke across three lines and the rule summary
              became a vertical ribbon. On a phone it gets its own line. */}
          {/* The propagation stop is on the two BUTTONS, not on this wrapper.
              It was on the wrapper, and that made the chevron — and the
              whitespace around it — a dead click: the card's own handler was
              blocked and the chevron has none of its own, so the one spot
              that used to say "Manage →" became the one spot that did nothing
              (codex P2 on #1161). Everything in here that is not a button now
              falls through to the row. */}
          <div className="flex items-center gap-1 w-full sm:w-auto justify-end self-center shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
            {canTogglePause && (
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePause?.(s) }}
                disabled={busy}
                title={s.active ? 'Pause this series — no new visits are generated' : 'Resume generating visits'}
                className="flex items-center gap-1 text-[11px] px-2.5 py-2 sm:px-2 sm:py-1 rounded-md bg-bg text-ink-3 hover:bg-bg-2 hover:text-ink transition-colors disabled:opacity-50"
              >
                {s.active
                  ? <><Pause className="w-3 h-3" /> Pause</>
                  : <><Play className="w-3 h-3" /> Resume</>}
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onEdit?.(s) }}
              title="Edit the rule for future visits"
              className="flex items-center gap-1 text-[11px] px-2.5 py-2 sm:px-2 sm:py-1 rounded-md bg-bg text-ink-3 hover:bg-bg-2 hover:text-ink transition-colors"
            >
              {/* "Edit", not "Edit rule". Rendering the before/after at 940px
                  showed the cluster taking enough width to wrap the rule
                  summary onto a second line on every row — a density cost paid
                  by the whole list to label one button more fully. The pencil
                  and the tooltip carry the rest. */}
              <Pencil className="w-3 h-3" /> Edit
            </button>
            {/* Was the words "Manage →", which were the row's only affordance
                back when the whole card was one button. With two real actions
                beside it the label was ~70px of a cramped row spent saying
                what the card already does, so it is the chevron InvoiceRow
                uses. */}
            <ChevronRight className="w-3.5 h-3.5 text-ink-3 ml-1 shrink-0" aria-hidden="true" />
          </div>
        </div>
      </div>
    </li>
  )
}

// Duplicate grouping (same client + property + cadence + time, overlapping
// days, LIVE series only) lives in utils/recurringDuplicates.js —
// groupDuplicateSeries is THE single definition, shared by the list pills,
// the banner count, and the review panel below, and aligned with the
// backend's pre-create guard (services/recurring_guards.py).

// ─── Duplicate review panel ──────────────────────────────────────────────
// Groups "Possible duplicate" series side by side so the owner can pick the
// keeper and pause/cancel the others one confirmed action at a time. Drives
// ONLY the existing Manage endpoints — PATCH {active:false} (pause, same as
// the detail page's Pause button) and DELETE (soft-cancel: sets active=false;
// already-scheduled visits stay on the calendar, past visits untouched).
// Nothing is automatic: every action goes through the app's confirm dialog,
// and nothing is ever hard-deleted (scheduling-invariants R7).
