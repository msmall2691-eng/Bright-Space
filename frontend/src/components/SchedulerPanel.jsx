import { useState, useEffect } from 'react'
import { RefreshCw, CheckCircle, XCircle, Clock, Zap, MessageSquare, Home, Activity } from 'lucide-react'

const TASK_CONFIG = {
  ical_sync: {
    label: 'iCal Sync',
    description: 'Airbnb/VRBO booking sync',
    icon: Home,
    schedule: 'Every 15 min',
    color: 'orange',
  },
  recurring_generation: {
    label: 'Recurring Jobs',
    description: 'Auto-generate scheduled cleanings',
    icon: RefreshCw,
    schedule: 'Daily at 2 AM',
    color: 'blue',
  },
  daily_reminders: {
    label: 'SMS Reminders',
    description: "Tomorrow's job reminders",
    icon: MessageSquare,
    schedule: 'Daily at 9 AM',
    color: 'green',
  },
}

const COLOR_MAP = {
  orange: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', icon: 'text-orange-500', btn: 'bg-orange-100 hover:bg-orange-200 text-orange-700' },
  blue:   { bg: 'bg-blue-50',   border: 'border-blue-200',   text: 'text-blue-700',   icon: 'text-blue-500',   btn: 'bg-blue-100 hover:bg-blue-200 text-blue-700' },
  green:  { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700',  icon: 'text-green-500',  btn: 'bg-green-100 hover:bg-green-200 text-green-700' },
  indigo: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700', icon: 'text-indigo-500', btn: 'bg-indigo-100 hover:bg-indigo-200 text-indigo-700' },
}

function timeAgo(isoStr) {
  if (!isoStr) return 'Never'
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function SchedulerPanel() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState({})

  const fetchStatus = () => {
    fetch('/api/scheduler/status')
      .then(r => r.json())
      .then(d => { setStatus(d); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 30000) // refresh every 30s
    return () => clearInterval(interval)
  }, [])

  const runTask = async (taskName) => {
    setRunning(r => ({ ...r, [taskName]: true }))
    try {
      await fetch(`/api/scheduler/run/${taskName}`, { method: 'POST' })
      await new Promise(r => setTimeout(r, 500))
      fetchStatus()
    } catch {}
    setRunning(r => ({ ...r, [taskName]: false }))
  }

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading scheduler...
        </div>
      </div>
    )
  }

  const isRunning = status?.running

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          <Activity className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-semibold text-gray-900">Automation Scheduler</span>
          <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
            isRunning ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            {isRunning ? 'Active' : 'Stopped'}
          </span>
        </div>
        <button onClick={fetchStatus} className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-lg hover:bg-gray-100">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Task cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4">
        {Object.entries(TASK_CONFIG).map(([key, config]) => {
          const taskStatus = status?.tasks?.[key] || {}
          const colors = COLOR_MAP[config.color]
          const Icon = config.icon
          const isOk = taskStatus.status === 'ok'
          const isError = taskStatus.status === 'error'
          const isNever = taskStatus.status === 'never_run'
          const result = taskStatus.result || {}

          return (
            <div key={key} className={`${colors.bg} border ${colors.border} rounded-xl p-4`}>
              {/* Task header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className={`w-4 h-4 ${colors.icon}`} />
                  <span className={`text-sm font-semibold ${colors.text}`}>{config.label}</span>
                </div>
                {isOk && <CheckCircle className="w-4 h-4 text-green-500" />}
                {isError && <XCircle className="w-4 h-4 text-red-500" />}
                {isNever && <Clock className="w-4 h-4 text-gray-400" />}
              </div>

              <p className="text-xs text-gray-500 mb-2">{config.description}</p>

              {/* Schedule */}
              <div className="text-[10px] text-gray-400 mb-2 flex items-center gap-1">
                <Clock className="w-3 h-3" /> {config.schedule}
              </div>

              {/* Last run info */}
              <div className="text-xs text-gray-600 mb-3">
                {isNever ? (
                  <span className="text-gray-400">Not run yet</span>
                ) : (
                  <>
                    <span className="font-medium">{timeAgo(taskStatus.last_run)}</span>
                    {/* Show key metrics */}
                    {result.jobs_created > 0 && <span className="ml-1.5 text-green-600">+{result.jobs_created} jobs</span>}
                    {result.jobs_pushed > 0 && <span className="ml-1.5 text-indigo-600">{result.jobs_pushed} pushed</span>}
                    {result.reminders_sent > 0 && <span className="ml-1.5 text-green-600">{result.reminders_sent} sent</span>}
                    {result.properties_synced > 0 && <span className="ml-1.5 text-orange-600">{result.properties_synced} synced</span>}
                    {isError && taskStatus.error && (
                      <div className="text-red-600 mt-1 truncate" title={taskStatus.error}>{taskStatus.error}</div>
                    )}
                  </>
                )}
              </div>

              {/* Run now button */}
              <button
                onClick={() => runTask(key)}
                disabled={running[key]}
                className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${colors.btn} disabled:opacity-50`}
              >
                {running[key] ? (
                  <><RefreshCw className="w-3 h-3 animate-spin" /> Running...</>
                ) : (
                  <><Zap className="w-3 h-3" /> Run Now</>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
