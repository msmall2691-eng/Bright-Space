import { useState } from 'react'
import { Link } from 'react-router-dom'
import { get } from '../../api'

// Map a finding's table to the record page, so its sample ids become links you
// can click straight to the offending record to fix it. Tables with no per-id
// page (e.g. leads) simply show no links.
const ROUTE_BY_TABLE = {
  clients: (id) => `/clients/${id}`,
  properties: (id) => `/properties/${id}`,
  jobs: (id) => `/jobs/${id}`,
  quotes: (id) => `/quotes/${id}`,
  invoices: (id) => `/invoices/${id}`,
  opportunities: (id) => `/opportunities/${id}`,
}

/**
 * DataHealthCard — a one-tap read-only data-quality scan.
 *
 * Hits GET /api/admin/data-health (services/data_doctor.py): dangling
 * references, missing-required drift, money anomalies, stuck lifecycle rows,
 * duplicate contacts — each with a suggested fix and whether that fix would be
 * destructive. Scoped to this workspace, never writes.
 *
 * Button-triggered, not auto-run: the scan is cheap but not free, and nobody
 * needs it re-run every time Settings opens (brightbase-economy). Admin/manager
 * only (the endpoint enforces it; this hides the card for everyone else so a
 * viewer doesn't get a silently-swallowed 403).
 */
const DOT = { error: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-ink-3' }
const WORD = { error: 'error', warn: 'needs a look', info: 'note' }

function role() {
  try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role || '' }
  catch { return '' }
}

export default function DataHealthCard() {
  const [state, setState] = useState(null)   // null | 'loading' | report | {error}
  if (!['admin', 'manager'].includes(role())) return null

  const run = () => {
    setState('loading')
    get('/api/admin/data-health')
      .then(setState)
      .catch(e => setState({ error: e?.detail || e?.message || 'Could not run the scan' }))
  }

  const report = state && typeof state === 'object' && !state.error ? state : null
  const findings = report?.findings || []

  return (
    <div className="bg-panel rounded-xl border border-hairline p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">Data health</h3>
          <p className="text-xs text-ink-3">A read-only scan for problems in your data — dangling records, money that doesn't add up, duplicates. Nothing is changed.</p>
        </div>
        <button onClick={run} disabled={state === 'loading'}
          className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium bg-bg-2 hover:bg-hairline text-ink-2 transition-colors disabled:opacity-50">
          {state === 'loading' ? 'Scanning…' : report ? 'Re-scan' : 'Run scan'}
        </button>
      </div>

      {state && state.error && (
        <div className="mt-3 flex items-start gap-1.5 text-[12px] text-ink-2">
          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      )}

      {report && (
        <div className="mt-3 border-t border-hairline pt-3">
          {report.healthy ? (
            <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
              All clear — nothing flagged{report.generated_at ? ` (${report.generated_at})` : ''}.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2 mb-2">
                {['error', 'warn', 'info'].map(sev => (report.summary?.[sev] ? (
                  <span key={sev} className="inline-flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${DOT[sev]} shrink-0`} aria-hidden="true" />
                    {report.summary[sev]} {WORD[sev]}{report.summary[sev] === 1 ? '' : 's'}
                  </span>
                ) : null))}
              </div>
              <div className="space-y-2">
                {findings.map((f, i) => (
                  <div key={`${f.code}-${i}`} className="flex items-start gap-2 text-[12px]">
                    <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[f.severity] || DOT.info}`} aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="text-ink">
                        {f.message}
                        {f.count > 1 && <span className="text-ink-3"> · {f.count}{f.truncated ? '+' : ''}</span>}
                      </div>
                      {f.suggestion && (
                        <div className="text-ink-3 mt-0.5">
                          {f.suggestion}{f.destructive ? ' (this fix deletes data — back up first)' : ''}
                        </div>
                      )}
                      {/* Click straight to the offending record(s). Some findings
                          key their sample_ids on a value that ISN'T a record id —
                          duplicate_client_email carries the shared email strings,
                          not client ids — so only linkify id-shaped (numeric)
                          entries, or the link would point at /clients/x@y.com. */}
                      {(() => {
                        const route = ROUTE_BY_TABLE[f.table]
                        const ids = Array.isArray(f.sample_ids)
                          ? f.sample_ids.filter(id => Number.isInteger(id)) : []
                        if (!route || ids.length === 0) return null
                        return (
                          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                            <span className="text-[11px] text-ink-3">Open:</span>
                            {ids.map(id => (
                              <Link key={id} to={route(id)}
                                className="text-[11px] text-ink hover:text-indigo-600 no-underline tabular-nums">
                                #{id}
                              </Link>
                            ))}
                            {f.truncated && <span className="text-[11px] text-ink-3">+ more</span>}
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
