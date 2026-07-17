import { useEffect, useMemo, useState } from 'react'
import {
  Search, Download, Clock, Car, DollarSign, User, CalendarRange,
  Home, KeyRound, Sun, AlertTriangle, Settings2, ChevronDown, Save, Check,
} from 'lucide-react'
import { get, put, patch } from '../api'
import { PageHeader } from '../components/ui'

// Payroll / Connecteam breakdown.
// Pulls Time Clock punches for a pay period and splits each crew member's
// hours into residential vs rental, weekday vs weekend, with mileage and a
// computed gross. Hourly rates and per-property weekend turnover rates are
// editable right here so the operator can reconcile against Connecteam.

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`
const hrs = (n) => `${(Number(n) || 0).toFixed(1)}h`

function isoDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function Payroll() {
  const [startDate, setStartDate] = useState(isoDaysAgo(14))
  const [endDate, setEndDate] = useState(isoDaysAgo(0))
  const [data, setData] = useState(null)
  const [ctRates, setCtRates] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState({})

  const pull = async () => {
    if (!startDate || !endDate) { setError('Select a date range'); return }
    setLoading(true); setError(''); setData(null); setCtRates({})
    try {
      const d = await get(`/api/payroll/summary?start_date=${startDate}&end_date=${endDate}`)
      setData(d)
      // Best-effort: Connecteam's own stored pay rates, shown alongside ours.
      get(`/api/connecteam/pay-rates?start_date=${startDate}&end_date=${endDate}`)
        .then(r => setCtRates(r.rates || {}))
        .catch(() => setCtRates({}))
    } catch (e) {
      setError(String(e.message || e))
    }
    setLoading(false)
  }

  const exportCsv = () => {
    if (!data) return
    const cols = [
      'Employee', 'Total Hours', 'Residential Hours', 'Residential Pay',
      'Rental Weekday Hours', 'Rental Weekday Pay', 'Weekend Turnovers',
      'Weekend Pay', 'Miles', 'Mileage Reimbursement', 'Unclassified Hours', 'Gross Pay',
    ]
    const rows = data.employees.map(e => [
      e.name, e.total_hours, e.residential_hours, e.residential_pay,
      e.rental_weekday_hours, e.rental_weekday_pay, e.weekend_turnovers,
      e.weekend_pay, e.miles, e.mileage_reimbursement, e.unclassified_hours, e.gross_pay,
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

  const t = data?.totals

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Payroll"
        subtitle="Pull Connecteam timesheets for a pay period and break the hours down by job type for payroll."
        icon={DollarSign}
        iconColor="emerald"
      >
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
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Search className="w-4 h-4" />{loading ? 'Loading...' : 'Pull Data'}
          </button>
          {data && (
            <button onClick={exportCsv}
              className="flex items-center gap-2 bg-panel hover:bg-bg-2 border border-hairline px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <Download className="w-4 h-4" />Export CSV
            </button>
          )}
        </div>
      </PageHeader>

      <div className="px-4 sm:px-6 pb-6 space-y-5">
        <RatesPanel />

        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl p-4">
            {error}
          </div>
        )}

        {data && (
          <>
            {data.warnings?.length > 0 && (
              <div className="text-sm bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                <div className="flex items-center gap-2 font-medium text-amber-400 mb-1.5">
                  <AlertTriangle className="w-4 h-4" />Needs attention
                </div>
                <ul className="list-disc pl-5 space-y-0.5 text-ink-2">
                  {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* Totals */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Stat label="Total Hours" value={hrs(t.total_hours)} icon={Clock} />
              <Stat label="Residential" value={hrs(t.residential_hours)} icon={Home} />
              <Stat label="Rental (wkday)" value={hrs(t.rental_weekday_hours)} icon={KeyRound} />
              <Stat label="Weekend Turnovers" value={t.weekend_turnovers} icon={Sun} />
              <Stat label="Mileage" value={money(t.mileage_reimbursement)} icon={Car} sub={`${t.miles} mi`} />
              <Stat label="Gross Pay" value={money(t.gross_pay)} icon={DollarSign} color="text-emerald-400" />
            </div>

            <div className="text-xs text-ink-3 space-y-0.5">
              <div>
                Period {data.period} · Residential {money(data.rates.residential_rate)}/hr ·
                Rental weekday {money(data.rates.rental_weekday_rate)}/hr ·
                Mileage {money(data.rates.mileage_rate)}/mi · Weekend rentals paid per-property piece rate
              </div>
              <div>
                {data.hours_source === 'connecteam'
                  ? <span className="text-emerald-400">✓ Total hours pulled from Connecteam's official timesheet (their rounding applied) — matches Connecteam exactly.</span>
                  : <span className="text-amber-400">Total hours computed from raw punches (Connecteam's official totals unavailable for this range).</span>}
                {t.unallocated_hours > 0.05 && <span> · {t.unallocated_hours}h not yet split into a job bucket.</span>}
              </div>
            </div>

            {/* Per employee */}
            <div className="space-y-3">
              {data.employees.map(emp => (
                <div key={emp.employee_id} className="bg-panel border border-hairline rounded-xl overflow-hidden">
                  <button
                    onClick={() => setExpanded(x => ({ ...x, [emp.employee_id]: !x[emp.employee_id] }))}
                    className="w-full text-left p-4 hover:bg-bg-2/40 transition-colors">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="flex items-center gap-1.5 font-medium text-ink flex-wrap">
                        <User className="w-4 h-4 text-ink-3 shrink-0" />{emp.name}
                        <span className="text-xs text-ink-3 ml-1">{hrs(emp.total_hours)} total</span>
                        {emp.hours_source === 'connecteam' && (
                          <span className="text-[11px] text-emerald-400/90 ml-1" title="From Connecteam's official timesheet">· Connecteam</span>
                        )}
                        {ctRates[emp.employee_id]?.rate != null && (
                          <span className="text-[11px] text-ink-3 ml-1" title="Rate stored in Connecteam">
                            · CT rate {money(ctRates[emp.employee_id].rate)}/hr
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-emerald-400">{money(emp.gross_pay)}</span>
                        <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${expanded[emp.employee_id] ? 'rotate-180' : ''}`} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                      <Bucket icon={Home} label="Residential"
                        primary={hrs(emp.residential_hours)} secondary={money(emp.residential_pay)} />
                      <Bucket icon={KeyRound} label="Rental (wkday)"
                        primary={hrs(emp.rental_weekday_hours)} secondary={money(emp.rental_weekday_pay)} />
                      <Bucket icon={Sun} label="Weekend"
                        primary={`${emp.weekend_turnovers} turnover${emp.weekend_turnovers === 1 ? '' : 's'}`}
                        secondary={money(emp.weekend_pay)}
                        warn={emp.weekend_unpriced_turnovers > 0 ? `${emp.weekend_unpriced_turnovers} unpriced` : null} />
                      <Bucket icon={Car} label="Mileage"
                        primary={`${emp.miles} mi`} secondary={money(emp.mileage_reimbursement)} />
                    </div>
                    {emp.unclassified_hours > 0 && (
                      <div className="mt-2 text-xs text-amber-400 flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {hrs(emp.unclassified_hours)} unclassified (not in pay)
                      </div>
                    )}
                    {emp.hours_source === 'connecteam' && Math.abs(emp.unallocated_hours - emp.unclassified_hours) > 0.05 && (
                      <div className="mt-1 text-xs text-ink-3 flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Connecteam total {hrs(emp.connecteam_hours)} vs {hrs(emp.computed_hours)} from punches
                        {emp.unallocated_hours > 0.05 && <> · {hrs(emp.unallocated_hours)} unallocated</>}
                      </div>
                    )}
                  </button>

                  {expanded[emp.employee_id] && (
                    <div className="border-t border-hairline bg-bg-2/30 px-4 py-3">
                      <div className="text-xs text-ink-3 mb-2">Shifts</div>
                      <div className="space-y-1">
                        {emp.shifts.map((s, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-hairline/50 last:border-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <KindDot kind={s.kind} weekend={s.weekend} />
                              <span className="text-ink-2 tabular-nums">{s.date}</span>
                              <span className="text-ink-3 truncate">
                                {s.property || (s.kind === 'unclassified' ? 'No job linked' : s.kind)}
                                {s.weekend && <span className="ml-1 text-amber-400">(wknd)</span>}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 shrink-0 tabular-nums">
                              <span className="text-ink-2">{hrs(s.hours)}</span>
                              {s.miles > 0 && <span className="text-ink-3">{s.miles} mi</span>}
                              <span className="text-ink font-medium w-16 text-right">{money(s.pay)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {data.employees.length === 0 && (
                <div className="text-sm text-ink-3 bg-panel border border-hairline rounded-xl p-6 text-center">
                  No timesheet punches found for this period.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function KindDot({ kind, weekend }) {
  const color = kind === 'unclassified' ? 'bg-amber-400'
    : kind === 'rental' ? (weekend ? 'bg-purple-400' : 'bg-blue-400')
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
      <div className="text-xs text-emerald-400">{secondary}</div>
      {warn && <div className="text-xs text-amber-400">{warn}</div>}
    </div>
  )
}

function Stat({ label, value, color = 'text-ink', icon: Icon, sub }) {
  return (
    <div className="bg-panel border border-hairline rounded-xl p-3">
      <div className="flex items-center gap-1 text-xs text-ink-3 mb-1">
        {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}{label}
      </div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-ink-3">{sub}</div>}
    </div>
  )
}

// ── Editable pay rates + per-property weekend turnover rates ────────────────
function RatesPanel() {
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
        mileage_rate: Number(rates.mileage_rate),
      })
      setRates(r)
      setSavedRates(true)
      setTimeout(() => setSavedRates(false), 2000)
    } catch (e) { setErr(String(e.message || e)) }
    setSavingRates(false)
  }

  return (
    <div className="bg-panel border border-hairline rounded-xl">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 text-left">
        <div className="flex items-center gap-2 font-medium text-ink">
          <Settings2 className="w-4 h-4 text-ink-3" />Pay rates
          <span className="text-xs text-ink-3 font-normal">hourly rates & per-property weekend turnover rates</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-hairline p-4 space-y-5">
          {err && <div className="text-sm text-red-400">{err}</div>}
          {!rates ? (
            <div className="text-sm text-ink-3">Loading…</div>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-4">
                <RateInput label="Residential $/hr" value={rates.residential_rate}
                  onChange={v => setRates({ ...rates, residential_rate: v })} />
                <RateInput label="Rental weekday $/hr" value={rates.rental_weekday_rate}
                  onChange={v => setRates({ ...rates, rental_weekday_rate: v })} />
                <RateInput label="Mileage $/mi" value={rates.mileage_rate} step="0.01"
                  onChange={v => setRates({ ...rates, mileage_rate: v })} />
                <button onClick={saveRates} disabled={savingRates}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
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
                </div>
                {props.length === 0 ? (
                  <div className="text-sm text-ink-3">No short-term rental properties found.</div>
                ) : (
                  <div className="space-y-2">
                    {props.map(p => (
                      <TurnoverRow key={p.id} property={p} />
                    ))}
                  </div>
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
      await patch(`/api/properties/${property.id}`, {
        turnover_rate: val === '' ? null : Number(val),
      })
      property.turnover_rate = val === '' ? null : Number(val)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) { setErr(String(e.message || e)) }
    setSaving(false)
  }

  return (
    <div className="flex items-center gap-3 bg-bg-2/50 rounded-lg px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ink truncate">{property.name}</div>
        {err && <div className="text-xs text-red-400">{err}</div>}
      </div>
      <div className="flex items-center bg-panel border border-hairline rounded-lg px-2">
        <span className="text-ink-3 text-sm">$</span>
        <input type="number" step="1" min="0" value={val}
          onChange={e => setVal(e.target.value)} placeholder="—"
          className="w-20 bg-transparent px-1 py-1.5 text-sm focus:outline-none" />
      </div>
      <button onClick={save} disabled={!dirty || saving}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 disabled:text-ink-3">
        {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
        {saved ? 'Saved' : 'Save'}
      </button>
    </div>
  )
}
