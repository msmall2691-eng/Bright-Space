import { useState } from 'react'
import { Search, Download, Clock, Car } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'
import { get } from '../api'

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
    <div className="p-4 sm:p-6 max-w-4xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-zinc-900 mb-1">Payroll</h2>
        <p className="text-sm text-zinc-400">Pull timesheet and mileage data from Connecteam for a pay period.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-zinc-100 p-1 rounded-lg w-fit mb-5">
        {[
          { id: 'timesheets', icon: Clock, label: 'Timesheets' },
          { id: 'mileage',    icon: Car,   label: 'Mileage' },
        ].map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setData(null) }}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-600'
            }`}>
            <t.icon className="w-4 h-4" />{t.label}
          </button>
        ))}
      </div>

      {/* Date range */}
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Start Date</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">End Date</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none" />
        </div>
        <button onClick={fetch_} disabled={loading}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <Search className="w-4 h-4" />{loading ? 'Loading...' : 'Pull Data'}
        </button>
      </div>

      {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-4">{error}</div>}

      {data && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
            {tab === 'timesheets' ? <>
              <Stat label="Total Hours" value={totalHours.toFixed(1) + 'h'} />
              <Stat label="Employees" value={data.employees?.length || 0} />
              <Stat label="Period" value={data.period} small />
            </> : <>
              <Stat label="Total Miles" value={totalMiles.toFixed(1)} />
              <Stat label="Total Reimbursement" value={`$${totalReimb.toFixed(2)}`} color="text-green-400" />
              <Stat label="Rate" value={`$${data.rate_per_mile}/mi`} />
            </>}
          </div>

          {/* Per employee */}
          <div className="space-y-3">
            {data.employees?.map(emp => (
              <div key={emp.employee_id} className="bg-white border border-zinc-200 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-zinc-900">{emp.name}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">ID: {emp.employee_id}</div>
                  </div>
                  {tab === 'timesheets'
                    ? <div className="text-right"><div className="font-bold text-zinc-900">{emp.total_hours.toFixed(1)}h</div><div className="text-xs text-zinc-500">{emp.entries?.length || 0} entries</div></div>
                    : <div className="text-right"><div className="font-bold text-zinc-900">{emp.total_miles.toFixed(1)} mi</div><div className="text-green-400 font-semibold">${emp.reimbursement.toFixed(2)}</div></div>
                  }
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <AgentWidget
        pageContext="payroll"
        prompts={[
          'Summarize payroll for this pay period',
          'Which employees logged the most hours?',
          'What is the total mileage reimbursement?',
        ]}
      />
    </div>
  )
}

function Stat({ label, value, color = 'text-zinc-900', small = false }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`${small ? 'text-sm' : 'text-xl font-bold'} ${color}`}>{value}</div>
    </div>
  )
}
