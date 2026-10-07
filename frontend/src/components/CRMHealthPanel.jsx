import { useState, useEffect } from 'react'
import { Activity, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { get } from '../api'
import { SEV_DOT } from './board/tokens'
import { STATUS_TEXT } from '../theme/statusText'

// Read-only CRM health snapshot, backed by GET /api/clients/health. Answers
// "how many of these leads are actually real?" before any cleanup runs — it never
// mutates anything. Buckets are mutually exclusive and sum to the total.
// Dot+word, not filled chips (owner's veto of tinted pill bubbles) — a small
// colored dot carries the bucket's hue, the label stays plain ink.
// BB-A11Y-02 — a dot is non-text, so the floor is 3:1, and every step here
// was off the 500 ramp and under it (amber-500 1.77, emerald-500 2.09,
// rose-500 2.98). `SEV_DOT` is the measured map the board already holds, so
// these route through it rather than keeping a second set of steps that
// drifts. `sky` and `zinc` had no equivalent at all: sky was doing an
// informational job, which is SEV_DOT.info, and zinc was "neutral", which the
// design language spells as the ink-3 token.
export const BUCKET_META = {
  real:           { label: 'Real',             dot: SEV_DOT.good },
  duplicate:      { label: 'Duplicates',       dot: SEV_DOT.watch },
  spam_marketing: { label: 'Spam / marketing', dot: SEV_DOT.urgent },
  incomplete:     { label: 'Incomplete',       dot: SEV_DOT.info },
  test:           { label: 'Test / junk',      dot: 'bg-ink-3' },
}
const ORDER = ['real', 'duplicate', 'spam_marketing', 'incomplete', 'test']

function Breakdown({ title, obj }) {
  const entries = Object.entries(obj || {})
  if (!entries.length) return null
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span key={k} className="px-2 py-0.5 rounded-md text-[11px] bg-bg-2 text-ink-2 border border-hairline">
            {k}: {v}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * @param inline  Render for a shared meta row rather than as its own band:
 *   the trigger is a bare button, and the expanded body is `w-full` so a
 *   `flex-wrap` parent drops it onto its own line underneath. The Clients
 *   chrome used to spend a whole full-width card on a one-line collapsed
 *   disclosure, which was one of four bands stacked above the list.
 */
export default function CRMHealthPanel({ onSelectBucket, inline = false }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const load = () => {
    setLoading(true); setError(null)
    // include_ids=true so the buckets carry the full ID list — clicking
    // "Duplicates: 23" narrows the list without a second round trip.
    get('/api/clients/health?include_ids=true')
      .then(setData)
      .catch(e => setError(e.message || 'Failed to load'))
      .finally(() => setLoading(false))
  }

  // Lazy: only scan when first expanded, so opening the Clients page stays cheap.
  useEffect(() => { if (open && !data && !loading && !error) load() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = data?.total ?? 0
  const real = data?.buckets?.real?.count ?? 0
  const pctReal = total ? Math.round((real / total) * 100) : 0

  return (
    <div className={inline
      ? 'contents'
      : 'mb-3 border border-hairline rounded-lg bg-panel'}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        className={inline
          ? 'bb-focus inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium text-ink-3 transition-colors hover:text-ink-2'
          : 'w-full flex items-center gap-2 px-3 py-2 text-[12px] font-medium text-ink-2 hover:text-ink transition-colors'}>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Activity className="w-3.5 h-3.5 text-ink-3" />
        CRM health
        {data && <span className="text-ink-3 font-normal">— {pctReal}% real ({real}/{total})</span>}
      </button>

      {open && (
        <div className={inline
          ? 'w-full rounded-lg border border-hairline bg-panel px-3 pb-3 pt-1'
          : 'px-3 pb-3 pt-1 border-t border-hairline'}>
          {loading && <div className="text-[12px] text-ink-3 py-2">Scanning clients…</div>}

          {error && !loading && (
            <div className={`text-[12px] ${STATUS_TEXT.problem} py-2 flex items-center gap-2`}>
              {error}
              <button onClick={load} className="inline-flex items-center gap-1 text-ink-3 hover:text-ink-2">
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            </div>
          )}

          {data && !loading && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 py-2">
                {ORDER.map(k => {
                  const m = BUCKET_META[k]
                  const n = data.buckets?.[k]?.count ?? 0
                  const ids = data.buckets?.[k]?.ids || []
                  // Non-empty buckets are click-through filters — the parent
                  // wires the click to narrow the Clients list to just that
                  // bucket. "Real" is skipped since that's the healthy set.
                  const clickable = onSelectBucket && n > 0 && k !== 'real'
                  // Bare dot + word. These were `border border-hairline-2
                  // bg-panel px-2` boxes around a dot and a word — the boxed
                  // "dot-pill" the design language names as vetoed in those
                  // exact classes. A CLICKABLE bucket reveals its border and
                  // fill on hover only, which is what InlineSelect does so an
                  // interactive status still reads as clickable at rest.
                  return clickable ? (
                    <button
                      key={k}
                      onClick={() => onSelectBucket(k, ids)}
                      title={`Filter to ${m.label.toLowerCase()} — the banner offers bulk actions`}
                      className="bb-focus inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-hairline-2 hover:bg-bg-2"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.dot}`} aria-hidden="true" />
                      {m.label}: {n} →
                    </button>
                  ) : (
                    <span key={k} className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-ink-3">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.dot}`} aria-hidden="true" />
                      {m.label}: {n}
                    </span>
                  )
                })}
                <button onClick={load} title="Refresh"
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink-2">
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>

              <p className="text-[11px] text-ink-3 -mt-1 mb-1">
                Click a bucket to filter — the banner above the list has bulk archive / merge / review actions.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
                <Breakdown title="By source" obj={data.by_source} />
                <Breakdown title="By status" obj={data.by_status} />
              </div>

              <p className="text-[11px] text-ink-3 mt-2">
                Snapshot itself changes nothing. Buckets are mutually exclusive and sum to {total}.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
