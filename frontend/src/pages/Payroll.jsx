import { useState } from 'react'
import { Search, Download, Clock, Car, DollarSign, User, CalendarRange } from 'lucide-react'
import { get } from '../api'
import { PageHeader } from '../components/ui'

export default function Payroll() {
  const [tab, setTab] = useState('timesheets')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetch_ = async () => {
    if (!startDate || !endDate) { setError('Select a date range'); return }
    setLoading(true); setError(''); setData(null)
    try {
      const endpoint = tab === 'timesheets' ? 'timesheets' : 'mileage'
      const data = await get(`/api/payroll/${endpoint}?start_date=${startDate}&end_date=${endDate}`)
      setData(data)
    } catch (e) {
      setError(String(e.message || e))
    }
    setLoading(false)
  }

  const totalHours = data?.employees?.reduce((s, e) => s + (e.total_hours || 0), 0) || 0
  const totalMiles = data?.employees?.reduce((s, e) => s + (e.total_miles || 0), 0) || 0
  const totalReimb = data?.employees?.reduce((s, e) => s + (e.reimbursement || 0), 0) || 0

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Payroll"
        subtitle="Pull timesheet and mileage data from Connecteam for a pay period."
        icon={DollarSign}
        iconColor="emerald"
      >
        {/* Tabs */}
        <div className="flex gap-1 bg-bg-2 p-1 rounded-lg w-fit mb-4">
          {[
            { id: 'timesheets', icon: Clock, label: 'Timesheets' },
            { id: 'mileage',    icon: Car,   label: 'Mileage' },
          ].map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setData(null) }}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                tab === t.id ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
              }`}>
              <t.icon className="w-4 h-4" />{t.label}
            </button>
          ))}
        </div>

        {/* Date range */}
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
          <button onClick={fetch_} disabled={loading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-bg-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Search className="w-4 h-4" />{loading ? 'Loading...' : 'Pull Data'}
          </button>
        </div>
      </PageHeader>

      <div className="px-4 sm:px-6 pb-6">

      {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-4">{error}</div>}

      {data && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
            {tab === 'timesheets' ? <>
              <Stat label="Total Hours" value={totalHours.toFixed(1) + 'h'} />
              <Stat label="Employees" value={data.employees?.length || 0} />
              <Stat label="Period" value={data.period} icon={CalendarRange} small />
            </> : <>
              <Stat label="Total Miles" value={totalMiles.toFixed(1)} />
              <Stat label="Total Reimbursement" value={`$${totalReimb.toFixed(2)}`} color="text-green-400" />
              <Stat label="Rate" value={`$${data.rate_per_mile}/mi`} />
            </>}
          </div>

          {/* Per employee */}
          <div className="space-y-3">
            {data.employees?.map(emp => (
              <div key={emp.employee_id} className="bg-panel border border-hairline rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-medium text-ink">
                    <User className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                    {emp.name}
                  </div>
                  {tab === 'timesheets'
                    ? <div className="text-right"><div className="font-bold text-ink">{emp.total_hours.toFixed(1)}h</div><div className="text-xs text-ink-3">{emp.entries?.length || 0} entries</div></div>
                    : <div className="text-right"><div className="flex items-center justify-end gap-1.5 font-bold text-ink">{emp.total_miles.toFixed(1)} mi</div><div className="flex items-center justify-end gap-1 text-green-400 font-semibold"><DollarSign className="w-3.5 h-3.5 shrink-0" />{emp.reimbursement.toFixed(2)}</div></div>
                  }
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      </div>
    </div>
  )
}

function Stat({ label, value, color = 'text-ink', small = false, icon: Icon }) {
  return (
    <div className="bg-panel border border-hairline rounded-xl p-4">
      <div className="text-xs text-ink-3 mb-1">{label}</div>
      <div className={`flex items-center gap-1.5 ${small ? 'text-sm' : 'text-xl font-bold'} ${color}`}>
        {Icon && <Icon className="w-3.5 h-3.5 text-ink-3 shrink-0" />}
        {value}
      </div>
    </div>
  )
}
