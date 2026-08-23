import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Search, Download, Clock, Car, DollarSign, User, CalendarRange,
  Home, KeyRound, Sun, AlertTriangle, Settings2, ChevronDown, Save, Check,
  Send, X, Sparkles,
} from 'lucide-react'
import { get, put, patch, post } from '../api'
import { PageHeader, StatCard, SubNav } from '../components/ui'

// Payroll breakdown.
// Pulls native time-clock punches for a pay period and splits each crew
// member's hours into residential vs rental, weekday vs weekend, with mileage
// and a computed gross. Rates are editable; and each shift can be manually set
// to Hourly / Piece rate / Exclude so piece-rate ("Rate Pay") jobs can have
// their hours swapped out for a flat amount at payroll time.

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`
const hrs = (n) => `${(Number(n) || 0).toFixed(1)}h`
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

function isoDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// "Save rates" (PUT /api/payroll/rates) and "Send to Square"
// (POST /api/payroll/send-to-square, both dry-run preview and confirm) are
// admin-only on the backend (backend/modules/payroll/router.py). Viewing
// this page and its rates (GET /api/payroll/summary, /rates) is
// admin+manager, so managers can reach it — gate just the two writes so a
// manager's click doesn't silently 403.
function isAdminUser() {
  try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
  catch { return false }
}

// Effective pay for one shift given a manual override. Returns { pay, mode }.
// mode 'auto' uses the backend's computed pay; the others let the operator
// swap a shift to a flat piece rate, re-price it hourly, or drop it entirely.
function shiftEffective(shift, ov, rates) {
  const mode = ov?.mode || 'auto'
  if (mode === 'exclude') return { pay: 0, mode }
  if (mode === 'piece') return { pay: round2(ov.amount), mode }
  if (mode === 'hourly') {
    const rate = shift.kind === 'rental' ? rates.rental_weekday_rate
      : shift.kind === 'deep' ? rates.deep_clean_rate
      : rates.residential_rate
    return { pay: round2(shift.hours * rate), mode }
  }
  return { pay: round2(shift.pay), mode: 'auto' }
}

// Recompute an employee's gross from their shifts + overrides + mileage.
function employeeAdjusted(emp, overrides, rates) {
  let shiftPay = 0
  for (const s of emp.shifts) shiftPay += shiftEffective(s, overrides[s.shift_id], rates).pay
  const gross = round2(shiftPay + emp.mileage_reimbursement)
  return { gross, changed: Math.abs(gross - emp.gross_pay) > 0.005 }
}

export default function Payroll() {
  const isAdmin = isAdminUser()
  const [startDate, setStartDate] = useState(isoDaysAgo(14))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState({})
  const [overrides, setOverrides] = useState({})
  const [square, setSquare] = useState(null)   // { mode:'preview'|'sent', data, busy, error }

  // Persist manual overrides per pay period so they survive a refresh.
  const ovKey = `payroll_overrides_${startDate}_${endDate}`
  useEffect(() => {
    try { setOverrides(JSON.parse(localStorage.getItem(ovKey) || '{}')) }
    catch { setOverrides({}) }
  }, [ovKey])
  const setOverride = (shiftId, patchObj) => {
    setOverrides(prev => {
      const next = { ...prev, [shiftId]: { ...prev[shiftId], ...patchObj } }
      if (next[shiftId]?.mode === 'auto') delete next[shiftId]
      try { localStorage.setItem(ovKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

  const pull = async () => {
    if (!startDate || !endDate) { setError('Select a date range'); return }
    setLoading(true); setError(''); setData(null)
    try {
      const d = await get(`/api/payroll/summary?start_date=${startDate}&end_date=${endDate}`)
      setData(d)
    } catch (e) {
      setError(String(e.message || e))
    }
    setLoading(false)
  }

  const rates = data?.rates
  // Adjusted per-employee gross (memoized so re-renders on override edits are cheap).
  const adj = useMemo(() => {
    if (!data) return {}
    const out = {}
    for (const emp of data.employees) out[emp.employee_id] = employeeAdjusted(emp, overrides, rates)
    return out
  }, [data, overrides, rates])
  const adjTotalGross = useMemo(
    () => round2(Object.values(adj).reduce((s, a) => s + a.gross, 0)),
    [adj]
  )

  const exportCsv = () => {
    if (!data) return
    const cols = [
      'Employee', 'Total Hours', 'Residential Hours', 'Deep Clean Hours', 'Deep Clean Pay',
      'Rental Weekday Hours', 'Weekend Turnovers', 'Miles', 'Mileage Reimbursement', 'Gross Pay',
    ]
    const rows = data.employees.map(e => [
      e.name, e.total_hours, e.residential_hours, e.deep_clean_hours, e.deep_clean_pay,
      e.rental_weekday_hours, e.weekend_turnovers, e.miles, e.mileage_reimbursement,
      adj[e.employee_id]?.gross ?? e.gross_pay,
    ])
    const csv = [cols, ...rows]
      .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `payroll_${startDate}_to_${endDate}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const sendSquare = async (dryRun) => {
    setSquare(s => ({ ...(s || {}), busy: true, error: '' }))
    try {
      const r = await post('/api/payroll/send-to-square', {
        start_date: startDate, end_date: endDate, dry_run: dryRun, overrides,
      })
      setSquare({ mode: dryRun ? 'preview' : 'sent', data: r, busy: false, error: '' })
    } catch (e) {
      setSquare(s => ({ ...(s || {}), busy: false, error: e?.detail || e?.message || String(e) }))
    }
  }

  const t = data?.totals

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Payroll"
        subtitle="Pull the crew's time-clock hours for a pay period and break them down by job type for payroll."
        icon={DollarSign}
        iconColor="emerald"
      >
        <SubNav className="mb-3" />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-ink-3 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="bg-panel border border-hairline rounded-lg px-3 py-2 text-sm focus:outline-none" />
          </div>
          <button onClick={pull} disabled={loading}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Search className="w-4 h-4" />{loading ? 'Loading...' : 'Pull Data'}
          </button>
          {data && (
            <>
              <button onClick={exportCsv}
                className="flex items-center gap-2 bg-panel hover:bg-bg-2 border border-hairline px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                <Download className="w-4 h-4" />Export CSV
              </button>
              {isAdmin && (
                <button onClick={() => sendSquare(true)} disabled={square?.busy}
                  className="flex items-center gap-2 bg-panel hover:bg-bg-2 border border-hairline px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                  <Send className="w-4 h-4" />Send to Square
                </button>
              )}
            </>
          )}
        </div>
      </PageHeader>

      <div className="px-4 sm:px-8 pb-6 space-y-5">
        {error && (
          <div className="flex items-start gap-2 text-sm text-ink-2 bg-panel border border-hairline rounded-xl p-4">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0 mt-1.5" aria-hidden="true" />
            {error}
          </div>
        )}

        {data && (
          <>
            {data.warnings?.length > 0 && (
              <div className="text-sm bg-panel border border-hairline rounded-xl p-4">
                <div className="flex items-center gap-2 font-medium text-ink mb-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />Needs attention
                </div>
                <ul className="list-disc pl-5 space-y-0.5 text-ink-2">
                  {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {square && <SquarePanel square={square} onClose={() => setSquare(null)}
              onConfirm={() => sendSquare(false)} />}

            <section>
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-2">This period</h2>
              <div className="bg-panel border border-hairline rounded-xl grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
                <StatCard label="Total hours" value={hrs(t.total_hours)} icon={Clock} />
                <StatCard label="Residential" value={hrs(t.residential_hours)} icon={Home} />
                <StatCard label="Rental (wkday)" value={hrs(t.rental_weekday_hours)} icon={KeyRound} />
                <StatCard label="Weekend turnovers" value={t.weekend_turnovers} icon={Sun} />
                <StatCard label="Mileage" value={money(t.mileage_reimbursement)} icon={Car} sub={`${t.miles} mi`} />
                <StatCard label="Gross pay" value={money(adjTotalGross)} icon={DollarSign}
                  accent="text-emerald-600 dark:text-emerald-300"
                  sub={Math.abs(adjTotalGross - t.gross_pay) > 0.005 ? `auto ${money(t.gross_pay)}` : null} />
              </div>
            </section>

            <div className="text-xs text-ink-3 space-y-0.5">
              <div>
                Period {data.period} · Residential {money(rates.residential_rate)}/hr ·
                Rental weekday {money(rates.rental_weekday_rate)}/hr ·
                Mileage {money(rates.mileage_rate)}/mi · Weekend rentals paid per-property piece rate
              </div>
              <div>
                <span>Hours and mileage from the BrightBase time clock (crew enter miles at clock-out).</span>
                {t.unallocated_hours > 0.05 && <span> · {t.unallocated_hours}h not yet split into a job bucket.</span>}
              </div>
            </div>

            <div className="space-y-3">
              {data.employees.map(emp => {
                const a = adj[emp.employee_id] || { gross: emp.gross_pay, changed: false }
                return (
                  <div key={emp.employee_id} className="bg-panel border border-hairline rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpanded(x => ({ ...x, [emp.employee_id]: !x[emp.employee_id] }))}
                      className="w-full text-left px-4 py-2.5 hover:bg-bg-2/60 transition-colors">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <div className="flex items-center gap-1.5 font-medium text-ink flex-wrap">
                          <User className="w-4 h-4 text-ink-3 shrink-0" />{emp.name}
                          <span className="text-xs text-ink-3 ml-1">{hrs(emp.total_hours)} total</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {a.changed && <span className="text-xs text-ink-3 line-through">{money(emp.gross_pay)}</span>}
                          <span className="font-bold text-emerald-600 dark:text-emerald-300">{money(a.gross)}</span>
                          <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${expanded[emp.employee_id] ? 'rotate-180' : ''}`} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                        <Bucket icon={Home} label="Residential" primary={hrs(emp.residential_hours)} secondary={money(emp.residential_pay)} />
                        {emp.deep_clean_hours > 0 && (
                          <Bucket icon={Sparkles} label="Deep clean" primary={hrs(emp.deep_clean_hours)} secondary={money(emp.deep_clean_pay)} />
                        )}
                        <Bucket icon={KeyRound} label="Rental (hourly)" primary={hrs(emp.rental_weekday_hours)} secondary={money(emp.rental_weekday_pay)} />
                        <Bucket icon={Sun} label="Weekend"
                          primary={`${emp.weekend_turnovers} turnover${emp.weekend_turnovers === 1 ? '' : 's'}`}
                          secondary={money(emp.weekend_pay)}
                          warn={emp.weekend_unpriced_turnovers > 0 ? `${emp.weekend_unpriced_turnovers} unpriced` : null} />
                        <Bucket icon={Car} label="Mileage" primary={`${emp.miles} mi`} secondary={money(emp.mileage_reimbursement)} />
                      </div>
                      {emp.unclassified_hours > 0 && (
                        <div className="mt-2 text-xs text-amber-600 dark:text-amber-300 flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" />{hrs(emp.unclassified_hours)} unclassified (not in pay)
                        </div>
                      )}
                    </button>

                    {expanded[emp.employee_id] && (
                      <div className="border-t border-hairline bg-bg-2/30 px-4 py-3">
                        <div className="flex items-center justify-between text-xs text-ink-3 mb-2">
                          <span>Shifts — set any to piece rate or exclude</span>
                        </div>
                        <div className="space-y-2">
                          {emp.shifts.map((s) => (
                            <ShiftRow key={s.shift_id} shift={s} rates={rates}
                              ov={overrides[s.shift_id]} onChange={p => setOverride(s.shift_id, p)} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {data.employees.length === 0 && (
                <div className="text-sm text-ink-3 bg-panel border border-hairline rounded-xl p-6 text-center">
                  No timesheet punches found for this period.
                </div>
              )}
            </div>

            <MileagePanel startDate={startDate} endDate={endDate} />
          </>
        )}

        {/* Setup lives BELOW the pay-run results: rates change a few times a
            year; the numbers are what this page is opened for. */}
        <section>
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-2">Setup</h2>
          <RatesPanel />
        </section>
      </div>
    </div>
  )
}

function ShiftRow({ shift, rates, ov, onChange }) {
  const mode = ov?.mode || 'auto'
  const eff = shiftEffective(shift, ov, rates)
  const label = shift.shift_title || shift.job_label || shift.property ||
    (shift.kind === 'unclassified' ? 'No job linked' : shift.kind)
  // Cross-link the label to the record it names (the app's usual pattern —
  // see SyncCenter's feed rows): a job title goes to the job, a property name
  // to the property. Quiet inline style so the row still reads as a table;
  // unlinked punches have no ids and stay plain text.
  const href = shift.job_id && label === shift.job_label ? `/jobs/${shift.job_id}`
    : shift.property_id && label === shift.property ? `/properties/${shift.property_id}`
    : null
  return (
    <div className="bg-panel border border-hairline rounded-lg px-3 py-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <KindDot kind={shift.kind} weekend={shift.weekend} />
          <span className="text-ink-2 tabular-nums text-sm">{shift.date}</span>
          {href ? (
            <Link to={href} className="text-ink hover:text-indigo-600 no-underline text-sm truncate">{label}</Link>
          ) : (
            <span className="text-ink-3 text-sm truncate">{label}</span>
          )}
          {shift.weekend && <span className="text-[11px] text-amber-600 dark:text-amber-300">wknd</span>}
          {shift.rate_pay && (
            <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
              <span className="h-1.5 w-1.5 rounded-full bg-purple-400 shrink-0" aria-hidden="true" />Rate Pay
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 tabular-nums text-sm">
          <span className="text-ink-2">{hrs(shift.hours)}</span>
          {shift.miles > 0 && <span className="text-ink-3">{shift.miles} mi</span>}
          <span className={`font-medium w-16 text-right ${mode !== 'auto' ? 'text-purple-300' : 'text-ink'}`}>{money(eff.pay)}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <select value={mode} onChange={e => onChange({ mode: e.target.value })}
          className="bg-bg-2 border border-hairline rounded-md px-2 py-1 text-xs focus:outline-none">
          <option value="auto">Auto ({shift.rate_pay ? 'piece' : 'hourly'})</option>
          <option value="hourly">Hourly</option>
          <option value="piece">Piece rate</option>
          <option value="exclude">Exclude</option>
        </select>
        {mode === 'piece' && (
          <div className="flex items-center bg-bg-2 border border-hairline rounded-md px-2">
            <span className="text-ink-3 text-xs">$</span>
            <input type="number" step="1" min="0" value={ov?.amount ?? ''} autoFocus
              onChange={e => onChange({ amount: e.target.value })} placeholder="amount"
              className="w-20 bg-transparent px-1 py-1 text-xs focus:outline-none" />
          </div>
        )}
        {mode !== 'auto' && (
          <button onClick={() => onChange({ mode: 'auto' })}
            className="text-xs text-ink-3 hover:text-ink-2">reset</button>
        )}
      </div>
    </div>
  )
}

function KindDot({ kind, weekend }) {
  const color = kind === 'unclassified' ? 'bg-amber-400'
    : kind === 'rental' ? (weekend ? 'bg-purple-400' : 'bg-blue-400')
    : kind === 'deep' ? 'bg-teal-400'
    : 'bg-emerald-400'
  return <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
}

function Bucket({ icon: Icon, label, primary, secondary, warn }) {
  return (
    <div className="bg-bg-2/50 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1 text-xs text-ink-3 mb-0.5">
        <Icon className="w-3 h-3" />{label}
      </div>
      <div className="font-semibold text-ink">{primary}</div>
      <div className="text-xs text-emerald-600 dark:text-emerald-300">{secondary}</div>
      {warn && <div className="text-xs text-amber-600 dark:text-amber-300">{warn}</div>}
    </div>
  )
}

// ── Send-to-Square preview / result ────────────────────────────────────────
function SquarePanel({ square, onClose, onConfirm }) {
  const d = square.data
  const sent = square.mode === 'sent'
  return (
    <div className="bg-panel border border-blue-500/40 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 font-medium text-ink">
          <Send className="w-4 h-4 text-blue-500" />
          {sent ? 'Sent to Square' : 'Send to Square — preview'}
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink"><X className="w-4 h-4" /></button>
      </div>

      {square.error && <div className="text-sm text-red-600 dark:text-red-300 mb-2">{square.error}</div>}

      {d && !sent && (
        <>
          <div className="text-sm text-ink-2 mb-2">
            {d.timecards_total} timecard{d.timecards_total === 1 ? '' : 's'} will be created for{' '}
            <b>{d.matched}</b> matched {d.matched === 1 ? 'person' : 'people'}. Piece-rate turnovers and
            mileage are listed as adjustments to enter in Square manually. <b>Nothing is sent yet.</b>
          </div>
          {d.jobs && (
            <div className="text-[11px] text-ink-3 mb-3">
              Tagged as Square jobs: residential → <b>{d.jobs.residential}</b>, rental → <b>{d.jobs.rental}</b>.
              {' '}Rates: {d.square_rates_used
                ? <span className="text-emerald-600 dark:text-emerald-300">using your Square-configured wage rates.</span>
                : <span>using the rates set on this page (no matching Square wage found — check the job titles in Settings).</span>}
            </div>
          )}
          {d.unmatched?.length > 0 && (
            <div className="flex items-start gap-2 text-xs bg-panel border border-hairline rounded-lg p-2.5 mb-3 text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0 mt-1" aria-hidden="true" />
              <span><span className="font-medium text-ink">Not matched to a Square team member:</span>{' '}
              {d.unmatched.join(', ')}. Their timecards are skipped — match names/emails in Square, or set them up there.</span>
            </div>
          )}
          <div className="space-y-1.5 mb-3">
            {d.employees.map(e => (
              <div key={e.employee_id} className="flex items-center justify-between gap-2 text-sm border-b border-hairline/50 last:border-0 py-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  {e.matched ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-300 shrink-0" />
                    : <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-300 shrink-0" />}
                  <span className="text-ink truncate">{e.name}</span>
                  {e.matched && e.square_name && e.square_name !== e.name &&
                    <span className="text-xs text-ink-3">→ {e.square_name}</span>}
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs tabular-nums">
                  <span className="text-ink-2">{e.timecard_count} timecard{e.timecard_count === 1 ? '' : 's'}</span>
                  {e.piece_count > 0 && <span className="text-purple-600 dark:text-purple-300">+{money(e.piece_total)} piece ({e.piece_count})</span>}
                  {e.mileage_reimbursement > 0 && <span className="text-ink-3">+{money(e.mileage_reimbursement)} mi</span>}
                  {e.unpriced > 0 && <span className="text-amber-600 dark:text-amber-300">{e.unpriced} unpriced</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-ink-3 mb-3">
            Adjustments (piece rate + mileage) aren't timecards — enter them in Square Payroll as additional pay / reimbursements.
          </div>
          <button onClick={onConfirm} disabled={square.busy || d.matched === 0}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Send className="w-4 h-4" />{square.busy ? 'Sending…' : `Confirm — create ${d.timecards_total} timecard${d.timecards_total === 1 ? '' : 's'}`}
          </button>
        </>
      )}

      {d && sent && (
        <div className="text-sm text-ink-2 space-y-1">
          <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-300 font-medium">
            <Check className="w-4 h-4" />Created {d.created} timecard{d.created === 1 ? '' : 's'} in Square.
          </div>
          <div className="text-ink-3">Import them from the Square Payroll dashboard, then add the piece-rate + mileage adjustments.</div>
          {d.errors?.length > 0 && (
            <div className="text-xs bg-panel border border-hairline rounded-lg p-2.5 mt-2">
              <div className="flex items-center gap-1.5 text-ink font-medium mb-1">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" />{d.errors.length} failed:
              </div>
              <ul className="list-disc pl-4 space-y-0.5 text-ink-2">
                {d.errors.slice(0, 8).map((er, i) => <li key={i}>{er.employee}: {er.error}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {square.busy && !d && <div className="text-sm text-ink-3">Working…</div>}
    </div>
  )
}

// ── Pre-calculated drive mileage (display only — never added to pay) ────────
// Chains each cleaner's scheduled jobs for the period: home → first job →
// between houses → back home, with per-leg distances from the backend
// (road distance when the Google key is set, straight-line × 1.3 labeled
// "est." otherwise). Quiet reference numbers for setting reimbursements —
// gross pay still runs on the miles crew enter at clock-out.
function MileagePanel({ startDate, endDate }) {
  const [open, setOpen] = useState(false)
  const [rep, setRep] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [exp, setExp] = useState({})

  useEffect(() => {
    if (!open) return
    setLoading(true); setErr('')
    get(`/api/payroll/mileage?start_date=${startDate}&end_date=${endDate}`)
      .then(setRep)
      .catch(e => setErr(String(e.message || e)))
      .finally(() => setLoading(false))
  }, [open, startDate, endDate])

  return (
    <div className="bg-panel border border-hairline rounded-xl">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between p-4 text-left">
        <div className="flex items-center gap-2 font-medium text-ink">
          <Car className="w-4 h-4 text-ink-3" />Drive mileage
          <span className="text-xs text-ink-3 font-normal">home → first job → between houses · reference only, not added to pay</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-hairline p-4 space-y-3">
          {err && <div className="text-sm text-red-600 dark:text-red-300">{err}</div>}
          {loading && <div className="text-sm text-ink-3">Calculating…</div>}
          {!loading && rep && rep.cleaners.length === 0 && (
            <div className="text-sm text-ink-3">No scheduled jobs with assigned crew in this period.</div>
          )}

          {!loading && rep && rep.cleaners.map(c => (
            <div key={c.cleaner_id} className="border border-hairline rounded-lg">
              <button
                onClick={() => setExp(x => ({ ...x, [c.cleaner_id]: !x[c.cleaner_id] }))}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg-2/60 transition-colors">
                <div className="flex items-center gap-1.5 min-w-0 text-sm">
                  <User className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                  <span className="text-ink truncate">{c.name}</span>
                  {!c.has_home && <span className="text-[11px] text-ink-3">· no home address, between houses only</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0 tabular-nums text-sm">
                  <span className="font-medium text-ink">{c.total_miles.toFixed(1)} mi</span>
                  {c.estimated && <span className="text-[11px] text-ink-3">est.</span>}
                  {c.return_miles > 0 && (
                    <span className="text-[11px] text-ink-3">incl. {c.return_miles.toFixed(1)} back home</span>
                  )}
                  <ChevronDown className={`w-3.5 h-3.5 text-ink-3 transition-transform ${exp[c.cleaner_id] ? 'rotate-180' : ''}`} />
                </div>
              </button>
              {exp[c.cleaner_id] && (
                <div className="border-t border-hairline bg-bg-2/30 px-3 py-2 space-y-2">
                  {c.days.map(day => (
                    <div key={day.date}>
                      <div className="flex items-center justify-between text-xs text-ink-3 mb-1 tabular-nums">
                        <span>{day.date}</span>
                        <span>{day.miles.toFixed(1)} mi</span>
                      </div>
                      <div className="space-y-0.5">
                        {day.legs.map((l, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 text-sm tabular-nums">
                            <span className="text-ink-2 truncate">
                              {l.from} → {l.to_property_id
                                ? <Link to={`/properties/${l.to_property_id}`} className="text-ink hover:text-indigo-600 no-underline">{l.to}</Link>
                                : l.to}
                              {l.kind === 'return_home' && <span className="text-[11px] text-ink-3"> · back home</span>}
                            </span>
                            <span className="text-ink-2 shrink-0">
                              {l.miles.toFixed(1)} mi{l.estimated && <span className="text-[11px] text-ink-3"> est.</span>}
                            </span>
                          </div>
                        ))}
                        {day.legs.length === 0 && (
                          <div className="text-xs text-ink-3">One stop — no drive legs to measure.</div>
                        )}
                      </div>
                    </div>
                  ))}
                  {c.unknown_stops > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-ink-3">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                      {c.unknown_stops} stop{c.unknown_stops === 1 ? '' : 's'} without map coordinates skipped.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {!loading && rep && (
            <div className="text-xs text-ink-3 space-y-1">
              {rep.cleaners.length > 0 && (
                <div className="tabular-nums">
                  Total {rep.totals.miles.toFixed(1)} mi ({rep.totals.work_miles.toFixed(1)} working + {rep.totals.return_miles.toFixed(1)} back home)
                  {rep.method === 'estimated' && ' · straight-line estimates × 1.3 road factor'}
                </div>
              )}
              {rep.notes.map((n, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-1" aria-hidden="true" />
                  <span>{n}</span>
                </div>
              ))}
              <div>These are scheduled-route estimates for reference — reimbursement still pays on the miles crew enter at clock-out.</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Editable pay rates + per-property weekend turnover rates ────────────────
function RatesPanel() {
  const isAdmin = isAdminUser()
  const [open, setOpen] = useState(false)
  const [rates, setRates] = useState(null)
  const [props, setProps] = useState([])
  const [savingRates, setSavingRates] = useState(false)
  const [savedRates, setSavedRates] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open || rates) return
    (async () => {
      try {
        const [r, p] = await Promise.all([
          get('/api/payroll/rates'),
          get('/api/properties?property_type=str'),
        ])
        setRates(r)
        setProps(p)
      } catch (e) { setErr(String(e.message || e)) }
    })()
  }, [open])

  const saveRates = async () => {
    setSavingRates(true); setErr(''); setSavedRates(false)
    try {
      const r = await put('/api/payroll/rates', {
        residential_rate: Number(rates.residential_rate),
        rental_weekday_rate: Number(rates.rental_weekday_rate),
        deep_clean_rate: Number(rates.deep_clean_rate),
        mileage_rate: Number(rates.mileage_rate),
      })
      setRates(r); setSavedRates(true); setTimeout(() => setSavedRates(false), 2000)
    } catch (e) { setErr(String(e.message || e)) }
    setSavingRates(false)
  }

  return (
    <div className="bg-panel border border-hairline rounded-xl">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between p-4 text-left">
        <div className="flex items-center gap-2 font-medium text-ink">
          <Settings2 className="w-4 h-4 text-ink-3" />Pay rates
          <span className="text-xs text-ink-3 font-normal">hourly rates & per-property weekend turnover rates</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-hairline p-4 space-y-5">
          {err && <div className="text-sm text-red-600 dark:text-red-300">{err}</div>}
          {!rates ? <div className="text-sm text-ink-3">Loading…</div> : (
            <>
              <div className="flex flex-wrap items-end gap-4">
                <RateInput label="Residential $/hr" value={rates.residential_rate}
                  onChange={v => setRates({ ...rates, residential_rate: v })} />
                <RateInput label="Rental weekday $/hr" value={rates.rental_weekday_rate}
                  onChange={v => setRates({ ...rates, rental_weekday_rate: v })} />
                <RateInput label="Deep clean $/hr" value={rates.deep_clean_rate}
                  onChange={v => setRates({ ...rates, deep_clean_rate: v })} />
                <RateInput label="Mileage $/mi" value={rates.mileage_rate} step="0.01"
                  onChange={v => setRates({ ...rates, mileage_rate: v })} />
                <button onClick={saveRates} disabled={savingRates || !isAdmin}
                  title={isAdmin ? undefined : 'Admin only'}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                  {savedRates ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  {savedRates ? 'Saved' : savingRates ? 'Saving…' : 'Save rates'}
                </button>
              </div>

              <div>
                <div className="text-sm font-medium text-ink mb-1 flex items-center gap-1.5">
                  <Sun className="w-4 h-4 text-ink-3" />Weekend turnover piece rates (per rental)
                </div>
                <div className="text-xs text-ink-3 mb-3">
                  Weekend rental turnovers are paid a flat amount per turnover, set per property.
                  You can also override any single shift's pay right on its row above.
                </div>
                {props.length === 0 ? (
                  <div className="text-sm text-ink-3">No short-term rental properties found.</div>
                ) : (
                  <div className="space-y-2">{props.map(p => <TurnoverRow key={p.id} property={p} />)}</div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function RateInput({ label, value, onChange, step = '0.5' }) {
  return (
    <div>
      <label className="block text-xs text-ink-3 mb-1">{label}</label>
      <div className="flex items-center bg-bg-2 border border-hairline rounded-lg px-2">
        <span className="text-ink-3 text-sm">$</span>
        <input type="number" step={step} min="0" value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          className="w-24 bg-transparent px-1 py-2 text-sm focus:outline-none" />
      </div>
    </div>
  )
}

function TurnoverRow({ property }) {
  const [val, setVal] = useState(property.turnover_rate ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')
  const dirty = String(val) !== String(property.turnover_rate ?? '')

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false)
    try {
      await patch(`/api/properties/${property.id}`, { turnover_rate: val === '' ? null : Number(val) })
      property.turnover_rate = val === '' ? null : Number(val)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e) { setErr(String(e.message || e)) }
    setSaving(false)
  }

  return (
    <div className="flex items-center gap-3 bg-bg-2/50 rounded-lg px-3 py-2">
      <div className="flex-1 min-w-0">
        <Link to={`/properties/${property.id}`}
          className="block text-sm text-ink truncate no-underline hover:text-indigo-600">
          {property.name}
        </Link>
        {err && <div className="text-xs text-red-600 dark:text-red-300">{err}</div>}
      </div>
      <div className="flex items-center bg-panel border border-hairline rounded-lg px-2">
        <span className="text-ink-3 text-sm">$</span>
        <input type="number" step="1" min="0" value={val}
          onChange={e => setVal(e.target.value)} placeholder="—"
          className="w-20 bg-transparent px-1 py-1.5 text-sm focus:outline-none" />
      </div>
      <button onClick={save} disabled={!dirty || saving}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 disabled:text-ink-3">
        {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
        {saved ? 'Saved' : 'Save'}
      </button>
    </div>
  )
}
