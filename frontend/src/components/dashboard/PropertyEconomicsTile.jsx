/**
 * PropertyEconomicsTile — "Am I making money on this house".
 *
 * Consumes GET /api/dashboard/property-economics: per-property paid/invoiced
 * revenue (Invoice → Job → Property), completed-visit count, crew hours from
 * the native time clock, and the effective $/hr those numbers imply. Top N by
 * paid revenue; every property name links to its record.
 *
 * Quiet data-forward table: plain ink numbers on hairline rows — no bars, no
 * tints. The one number that gets emphasis is Paid (it's the answer); $/hr is
 * the pricing-decision column and shows "—" when no crew hours were clocked
 * (an honest blank beats a fantasy rate).
 */
import { Home } from 'lucide-react'
import { Tile, TileLoading } from './primitives'
import { fmtMoney } from './utils'

export function PropertyEconomicsTile({ loading, data, error, navigate }) {
  const rows = data?.properties || []
  const windowDays = data?.window_days || 90
  return (
    <Tile icon={Home} title="Property economics"
      action="All properties" onAction={() => navigate('/properties')}>
      {loading ? <TileLoading /> : error ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">Couldn't load property economics.</div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-3">
          No invoiced work in the last {windowDays} days yet.
        </div>
      ) : (
        <>
          {/* Table scrolls inside the tile on narrow screens; the page never
              scrolls sideways. */}
          <div className="overflow-x-auto">
            <table className="bb-table whitespace-nowrap">
              <thead>
                <tr className="border-b border-hairline">
                  <th className="bb-th pl-5">Property</th>
                  <th className="bb-th text-right">Visits</th>
                  <th className="bb-th text-right">Crew hours</th>
                  <th className="bb-th text-right">Invoiced</th>
                  <th className="bb-th text-right">Paid</th>
                  <th className="bb-th text-right pr-5">Effective $/hr</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(p => (
                  <tr key={p.property_id} className="border-b border-hairline last:border-b-0">
                    <td className="bb-td pl-5 max-w-[16rem]">
                      <a href={`/properties/${p.property_id}`}
                         className="block truncate font-medium text-ink hover:text-indigo-600 no-underline">
                        {p.property_name}
                      </a>
                    </td>
                    <td className="bb-td text-right tabular-nums">{p.visits}</td>
                    <td className="bb-td text-right tabular-nums">
                      {p.crew_hours > 0 ? `${p.crew_hours}h` : '—'}
                    </td>
                    <td className="bb-td text-right tabular-nums">{fmtMoney(p.revenue_invoiced)}</td>
                    <td className="bb-td text-right tabular-nums font-semibold text-ink">{fmtMoney(p.revenue_paid)}</td>
                    <td className="bb-td text-right tabular-nums pr-5">
                      {p.effective_hourly != null ? `$${Math.round(p.effective_hourly)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bb-table-foot px-5 text-[11px] text-ink-3">
            Paid revenue ÷ clocked crew hours, last {windowDays} days
            {data?.properties_total > rows.length
              ? ` · top ${rows.length} of ${data.properties_total} properties`
              : ''}
          </div>
        </>
      )}
    </Tile>
  )
}
