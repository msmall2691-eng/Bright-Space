import { useState, useEffect } from 'react'
import { Send, AlertCircle, CheckCircle, Users } from 'lucide-react'
import { get } from "../api"


export default function Dispatch() {
  const [jobs, setJobs] = useState([])
  const [employees, setEmployees] = useState([])
  const [empError, setEmpError] = useState('')
  const [dispatching, setDispatching] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    get('/api/jobs?status=scheduled').then(setJobs).catch(err => console.error("[Dispatch]", err))
    get('/api/dispatch/employees')
      .then(data => setEmployees(Array.isArray(data) ? data : []))
      .catch(() => setEmpError('Could not load Connecteam employees — check your API key'))
  }, [])

  const dispatch = async (jobId) => {
    setDispatching(jobId)
    setResult(null)
    try {
      const r = await fetch(`/api/dispatch/jobs/${jobId}/dispatch`, { method: 'POST' })
      const data = await r.json()
      setResult({ jobId, ...data, ok: r.ok })
      if (r.ok) {
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, dispatched: true } : j))
      }
    } catch (e) {
      setResult({ jobId, ok: false, detail: String(e) })
    }
    setDispatching(null)
  }

  const empName = (id) => {
    const e = employees.find(e => e.id === id || e.userId === id)
    return e ? (e.name || e.displayName || id) : id
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Dispatch to Connecteam</h2>
        <p className="text-sm text-gray-400">Push scheduled jobs as shifts to your cleaners in Connecteam.</p>
      </div>

      {empError && (
        <div className="flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 rounded-xl p-4 mb-5 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {empError}
        </div>
      )}

      {result && (
        <div className={`flex items-start gap-2 rounded-xl p-4 mb-5 text-sm border ${result.ok ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
          {result.ok ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <div>
            {result.ok ? `Dispatched ${result.dispatched} shift(s) for job #${result.jobId}` : `Error: ${result.detail || 'Dispatch failed'}`}
            {result.errors?.length > 0 && <div className="mt-1 text-xs opacity-75">{result.errors.map(e => e.error).join(', ')}</div>}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {jobs.map(j => (
          <div key={j.id} className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium text-gray-900">{j.title}</div>
                <div className="text-sm text-gray-400 mt-0.5">
                  {j.scheduled_date} · {j.start_time}–{j.end_time}
                  {j.address && <span className="ml-2">· {j.address}</span>}
                </div>
                {j.cleaner_ids?.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-2">
                    <Users className="w-3.5 h-3.5 text-gray-500" />
                    <span className="text-xs text-gray-400">{j.cleaner_ids.map(empName).join(', ')}</span>
                  </div>
                )}
                {j.cleaner_ids?.length === 0 && (
                  <div className="text-xs text-yellow-400 mt-2">No cleaners assigned — edit this job in Scheduling first</div>
                )}
              </div>
              <div className="flex items-center gap-3 ml-4">
                {j.dispatched && (
                  <span className="text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 px-2.5 py-1 rounded-full">Dispatched</span>
                )}
                {!j.dispatched && (
                  <button
                    onClick={() => dispatch(j.id)}
                    disabled={dispatching === j.id || !j.cleaner_ids?.length}
                    className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {dispatching === j.id ? 'Sending...' : 'Dispatch'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {jobs.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <Send className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <div>No scheduled jobs to dispatch</div>
          </div>
        )}
      </div>
    </div>
  )
}
