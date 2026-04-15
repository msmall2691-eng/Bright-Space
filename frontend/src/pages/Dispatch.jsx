import { useState, useEffect } from 'react'
import { Send, AlertCircle, CheckCircle, Users, Calendar, MapPin, Clock, RefreshCw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import AgentWidget from '../components/AgentWidget'
import { get, post } from '../api'


export default function Dispatch() {
  const navigate = useNavigate()
  const [jobs, setJobs] = useState([])
  const [employees, setEmployees] = useState([])
  const [empError, setEmpError] = useState('')
  const [dispatching, setDispatching] = useState(null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    get('/api/jobs?status=scheduled').then(data => {
      setJobs(Array.isArray(data) ? data : [])
      setLoading(false)
    }).catch(err => { console.error("[Dispatch]", err); setLoading(false) })
  }

  useEffect(() => {
    load()
    get('/api/dispatch/employees')
      .then(data => setEmployees(Array.isArray(data) ? data : []))
      .catch(() => setEmpError('Could not load Connecteam employees — check your API key'))
  }, [])

  const dispatch = async (jobId) => {
    setDispatching(jobId)
    setResult(null)
    try {
      const data = await post(`/api/dispatch/jobs/${jobId}/dispatch`)
      setResult({ jobId, ...data, ok: true })
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, dispatched: true } : j))
    } catch (e) {
      setResult({ jobId, ok: false, detail: String(e) })
    }
    setDispatching(null)
  }

  const empName = (id) => {
    const e = employees.find(e => e.id === id || e.userId === id)
    return e ? (e.name || e.displayName || id) : id
  }

  const dispatched = jobs.filter(j => j.dispatched)
  const pending = jobs.filter(j => !j.dispatched)

  return (
    <div className="p-4 sm:p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 mb-1">Dispatch to Connecteam</h2>
          <p className="text-sm text-zinc-400">Push scheduled jobs as shifts to your cleaners.</p>
        </div>
        <button onClick={load}
          className="flex items-center gap-2 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 px-3 py-2 rounded-lg text-sm transition-colors">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-zinc-200 rounded-xl p-4">
          <div className="text-xs text-zinc-500 mb-1">Pending</div>
          <div className="text-xl font-bold text-zinc-900">{pending.length}</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-xl p-4">
          <div className="text-xs text-zinc-500 mb-1">Dispatched</div>
          <div className="text-xl font-bold text-emerald-600">{dispatched.length}</div>
        </div>
        <div className="bg-white border border-zinc-200 rounded-xl p-4">
          <div className="text-xs text-zinc-500 mb-1">Team Size</div>
          <div className="text-xl font-bold text-zinc-900">{employees.length || '—'}</div>
        </div>
      </div>

      {empError && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl p-4 mb-5 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {empError}
        </div>
      )}

      {result && (
        <div className={`flex items-start gap-2 rounded-xl p-4 mb-5 text-sm border ${
          result.ok ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {result.ok ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <div>
            {result.ok ? `Dispatched ${result.dispatched} shift(s) for job #${result.jobId}` : `Error: ${result.detail || 'Dispatch failed'}`}
            {result.errors?.length > 0 && <div className="mt-1 text-xs opacity-75">{result.errors.map(e => e.error).join(', ')}</div>}
          </div>
        </div>
      )}

      {/* Pending dispatch */}
      {pending.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Ready to Dispatch</h3>
          <div className="space-y-3">
            {pending.map(j => (
              <div key={j.id} className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition-colors">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="font-medium text-zinc-900">{j.title}</div>
                    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-sm text-zinc-500">
                      <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{j.scheduled_date}</span>
                      <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{j.start_time}–{j.end_time}</span>
                      {j.address && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{j.address}</span>}
                    </div>
                    {j.cleaner_ids?.length > 0 && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <Users className="w-3.5 h-3.5 text-zinc-400" />
                        <span className="text-xs text-zinc-500">{j.cleaner_ids.map(empName).join(', ')}</span>
                      </div>
                    )}
                    {(!j.cleaner_ids || j.cleaner_ids.length === 0) && (
                      <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-600">
                        <AlertCircle className="w-3.5 h-3.5" />
                        No cleaners assigned —{' '}
                        <button onClick={() => navigate('/scheduling')} className="underline hover:no-underline">assign in Scheduling</button>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => dispatch(j.id)}
                    disabled={dispatching === j.id || !j.cleaner_ids?.length}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white disabled:bg-zinc-100 disabled:text-zinc-400 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-sm font-medium transition-colors shrink-0 ml-4"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {dispatching === j.id ? 'Sending...' : 'Dispatch'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Already dispatched */}
      {dispatched.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Already Dispatched</h3>
          <div className="space-y-2">
            {dispatched.map(j => (
              <div key={j.id} className="bg-zinc-50 border border-gray-100 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-600">{j.title}</div>
                    <div className="text-xs text-zinc-400 mt-0.5">{j.scheduled_date} · {j.start_time}–{j.end_time}</div>
                  </div>
                  <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-full flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> Dispatched
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {jobs.length === 0 && !loading && (
        <div className="text-center py-16">
          <Send className="w-10 h-10 mx-auto mb-3 text-gray-300" />
          <div className="text-zinc-500 font-medium mb-1">No scheduled jobs to dispatch</div>
          <p className="text-sm text-zinc-400 mb-4">Schedule jobs first, then dispatch them to your field team.</p>
          <button onClick={() => navigate('/scheduling')}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            Go to Scheduling
          </button>
        </div>
      )}

      <AgentWidget
        pageContext="dispatch"
        prompts={[
          'Which jobs still need to be dispatched?',
          'Show me today\'s dispatch status',
          'Are any jobs missing cleaner assignments?',
        ]}
      />
    </div>
  )
}
