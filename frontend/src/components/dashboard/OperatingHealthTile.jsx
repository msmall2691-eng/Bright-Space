/**
 * OperatingHealthTile — the two numbers a managed home-services business
 * lives or dies on, from GET /api/dashboard/operating-health.
 *
 * LABOUR AS A SHARE OF REVENUE. The operating ratio the whole industry steers
 * by. Published benchmarks for residential cleaning put direct labour at
 * 45–55% of revenue, low 40s for well-run operators, trouble above 55 —
 * residential sits high because unbillable drive time between houses is real,
 * and rural Maine is the worst case for it. A two-point move swings net profit
 * by a quarter.
 *
 * DO THEY COME BACK. The number Homejoy died of: $40M raised, 15–20% of
 * customers rebooking within a month, ~75% of bookings bought with discounts.
 * Molly Maid franchisees run 91%. It is the whole difference between the two
 * businesses, and BrightBase never said it out loud.
 *
 * HONESTY RULES, which are most of the design here:
 *   - a null rate renders as "—", never as 0%. A month with no invoices is not
 *     a month with no labour cost, and a new book is not a book with 0%
 *     retention;
 *   - coverage is shown whenever it is short of complete, because a labour
 *     percentage computed off half the jobs is roughly double the truth and
 *     reads exactly as confidently as a correct one;
 *   - the recurring split rides along, because a 95% repeat rate that is
 *     entirely standing schedules says the generator works, not that the
 *     cleaning won anyone over.
 *
 * Design language: dot + word, plain tabular numbers, no tinted banners, no
 * pills. The benchmark dot is the only colour, and it earns it — it is the
 * one thing on the tile that says "look at this" rather than "here is a fact".
 */
import { Activity } from 'lucide-react'
import { Tile, TileLoading } from './primitives'

/** Dot colour against the published band. Amber is a nudge, rose is trouble. */
function toneFor(pct, bench) {
  if (pct == null || !bench) return 'bg-ink-3/40'
  if (pct <= bench.good_max) return 'bg-emerald-500'
  if (pct <= bench.warn_max) return 'bg-amber-500'
  return 'bg-rose-500'
}

const pct = (v) => v == null ? '—' : `${v}%`

export function OperatingHealthTile({ loading, data, error }) {
  const labour = data?.labour
  const repeat = data?.repeat
  const months = labour?.months || []
  // The latest month with revenue to divide by. The current month is usually
  // half-invoiced, so leading with it would show a number that climbs all
  // month for no operational reason.
  const latest = [...months].reverse().find(m => m.labour_pct != null)
  const coverage = labour?.coverage_pct

  return (
    <Tile icon={Activity} title="Is this working">
      {loading ? <TileLoading /> : error ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">
          Couldn't load these numbers.
        </div>
      ) : (
        <div className="px-5 py-4 space-y-4">
          {/* ── labour share ── */}
          <div>
            <div className="flex items-baseline gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 self-center ${toneFor(latest?.labour_pct, labour?.benchmark)}`} aria-hidden="true" />
              <span className="text-2xl font-bold tabular-nums text-ink">
                {pct(latest?.labour_pct)}
              </span>
              <span className="text-[12px] text-ink-3">
                of revenue went to the people doing the work
                {latest ? ` · ${latest.month}` : ''}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ink-3">
              Well run is the low 40s. Over 55 is trouble.
            </p>

            {months.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {months.map(m => (
                  <span key={m.month} className="text-[11px] tabular-nums text-ink-3">
                    {m.month.slice(5)} <span className="text-ink-2">{pct(m.labour_pct)}</span>
                  </span>
                ))}
              </div>
            )}

            {coverage != null && coverage < 100 && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-ink-2">
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                <span>
                  Only {coverage}% of finished jobs have an invoice
                  ({labour.jobs_invoiced} of {labour.jobs_completed}), so the
                  percentage above is higher than the truth.
                </span>
              </p>
            )}
          </div>

          {/* ── do they come back ── */}
          <div className="border-t border-hairline pt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tabular-nums text-ink">
                {pct(repeat?.rate_pct)}
              </span>
              <span className="text-[12px] text-ink-3">
                booked again within {repeat?.window_days ?? 60} days
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ink-3">
              {repeat?.considered
                ? `${repeat.returned} of ${repeat.considered} cleanings led to another one.`
                : 'Not enough finished work yet to say.'}
              {repeat?.one_off_considered
                ? ` Customers not on a standing schedule: ${pct(repeat.one_off_rate_pct)}.`
                : ''}
            </p>
          </div>
        </div>
      )}
    </Tile>
  )
}
