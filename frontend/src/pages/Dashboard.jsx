import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Calendar, DollarSign, Users, FileText, Clock,
  AlertCircle, TrendingUp, Plus, ArrowRight, MapPin, RefreshCw
} from 'lucide-react'

function StatCard({ icon: Icon, label, value, sub, color = 'text-gray-900', iconBg = 'bg-gray-100' }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-gray-500 mb-1">{label}</p>
          <p className={`text-2xl font-bold ${color}`}>{value}</p>
          {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
        </div>
        <div className={`p-2.5 rounded-lg ${iconBg}`}>
          <Icon className="w-5 h-5 text-gray-600" />
        </div>
      </div>
    </div>
  )
}

const JOB_STATUS_COLORS = {
  scheduled:   'bg-blue-50 text-blue-700 border-blue-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  completed:   'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled:   'bg-red-50 text-red-700 border-red-200',
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [todayJobs, setTodayJobs] = useState([])
  const [upcomingJobs, setUpcomingJobs] = useState([])
  const [weekJobs, setWeekJobs] = useState([])
  const [clients, setClients] = useState([])
  const [invoices, setInvoices] = useState([])
  const [recurringCount, setRecurringCount] = useState(0)
  const [loading, setLoading] = useState(true)

  const today = new Date().toISOString().slice(0, 10)
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

  useEffect(() => {
    const load = async () => {
      try {
        const [jobsToday, jobsWeek, clientsAll, invoicesAll, schedules] = await Promise.all([
          fetch(`/api/jobs?date=${today}`).then(r => r.json()),
          fetch(`/api/jobs?date_from=${today}&date_to=${weekEnd}`).then(r => r.json()),
          fetch('/api/clients').then(r => r.json()),
          fetch('/api/invoices').then(r => r.json()),
          fetch('/api/recurring').then(r => r.json()),
        ])
        setTodayJobs(Array.isArray(jobsToday) ? jobsToday : [])
        const week = Array.isArray(jobsWeek) ? jobsWeek : []
        setWeekJobs(week)
        setUpcomingJobs(week.filter(j => j.scheduled_date > today && j.status === 'scheduled').slice(0, 3))
        setClients(Array.isArray(clientsAll) ? clientsAll : [])
        setInvoices(Array.isArray(invoicesAll) ? invoicesAll : [])
        setRecurringCount(Array.isArray(schedules) ? schedules.filter(s => s.active).length : 0)
      } catch {}
      setLoading(false)
    }
    load()
  }, [])

  // Computed stats
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)

  const monthRevenue = invoices
    .filter(i => i.status === 'paid' && i.paid_at && i.paid_at.slice(0, 10) >= monthStart)
    .reduce((s, i) => s + (i.total || 0), 0)

  const outstanding = invoices
    .filter(i => ['sent', 'overdue'].includes(i.status))
    .reduce((s, i) => s + (i.total || 0), 0)

  const overdueInvoices = invoices.filter(i => i.status === 'overdue')
  const unpaidInvoices = invoices.filter(i => ['sent', 'overdue'].includes(i.status))
    .sort((a, b) => (a.status === 'overdue' ? -1 : 1))
    .slice(0, 5)

  const activeClients = clients.filter(c => c.status === 'active').length
  const newLeads = clients.filter(c => c.status === 'lead').length

  const recentClients = [...clients]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5)

  const clientName = (id) => clients.find(c => c.id === id)?.name || `Client #${id}`

  const completedToday = todayJobs.filter(j => j.status === 'completed').length
  const weekTotal = weekJobs.length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 text-sm">Loading dashboard...</div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full scrollbar-thin">

      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </h2>
          <p className="text-sm text-gray-400 mt-0.5">
            {todayJobs.length === 0
              ? 'No jobs scheduled today'
              : `${todayJobs.length} job${todayJobs.length > 1 ? 's' : ''} today · ${completedToday} completed`}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate('/clients')}
            className="flex items-center gap-1.5 bg-gray-100 hover:bg-gray-200 border border-gray-200 px-3 py-2 rounded-lg text-sm transition-colors">
            <Plus className="w-3.5 h-3.5" /> Client
          </button>
          <button onClick={() => navigate('/scheduling')}
            className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-3.5 h-3.5" /> Job
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Calendar}
          label="Today's Jobs"
          value={todayJobs.length}
          sub={completedToday > 0 ? `${completedToday} completed` : weekTotal > 0 ? `${weekTotal} this week` : 'None scheduled'}
          color={todayJobs.length > 0 ? 'text-sky-400' : 'text-gray-400'}
          iconBg="bg-sky-50"
        />
        <StatCard
          icon={DollarSign}
          label="This Month Revenue"
          value={`$${monthRevenue.toFixed(0)}`}
          sub="Paid invoices"
          color="text-green-400"
          iconBg="bg-green-50"
        />
        <StatCard
          icon={AlertCircle}
          label="Outstanding"
          value={`$${outstanding.toFixed(0)}`}
          sub={`${unpaidInvoices.length} invoice${unpaidInvoices.length !== 1 ? 's' : ''}${overdueInvoices.length > 0 ? ` · ${overdueInvoices.length} overdue` : ''}`}
          color={overdueInvoices.length > 0 ? 'text-red-400' : outstanding > 0 ? 'text-yellow-400' : 'text-gray-400'}
          iconBg={overdueInvoices.length > 0 ? 'bg-red-50' : 'bg-amber-50'}
        />
        <StatCard
          icon={RefreshCw}
          label="Recurring Schedules"
          value={recurringCount}
          sub={`${activeClients} active client${activeClients !== 1 ? 's' : ''}${newLeads > 0 ? ` · ${newLeads} lead${newLeads > 1 ? 's' : ''}` : ''}`}
          color="text-purple-400"
          iconBg="bg-purple-50"
        />
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Today's schedule — spans 2 cols */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-sky-400" /> Today's Schedule
              </h3>
              <button onClick={() => navigate('/scheduling')}
                className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1">
                View all <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {todayJobs.length === 0 ? (
              <div className="text-center py-8">
                <Calendar className="w-10 h-10 mx-auto mb-2 text-gray-700" />
                <p className="text-sm text-gray-500">No jobs today</p>
                <button onClick={() => navigate('/scheduling')}
                  className="mt-3 text-xs text-sky-400 hover:text-sky-300">
                  + Schedule a job
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {todayJobs.map(job => (
                  <div key={job.id}
                    onClick={() => navigate('/scheduling')}
                    className="flex items-center gap-4 bg-gray-50 hover:bg-gray-100 rounded-lg p-3 cursor-pointer transition-colors">
                    <div className="text-center w-14 shrink-0">
                      <div className="text-sm font-semibold text-gray-900">{job.start_time}</div>
                      <div className="text-xs text-gray-500">{job.end_time}</div>
                    </div>
                    <div className="w-px h-8 bg-gray-200 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{job.title}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-400">{clientName(job.client_id)}</span>
                        {job.address && (
                          <span className="text-xs text-gray-500 flex items-center gap-0.5 truncate">
                            <MapPin className="w-3 h-3 shrink-0" />{job.address}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {job.dispatched && (
                        <span className="text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 px-2 py-0.5 rounded-full">
                          Dispatched
                        </span>
                      )}
                      <span className={`text-xs px-2.5 py-1 rounded-full border capitalize ${JOB_STATUS_COLORS[job.status]}`}>
                        {job.status.replace('_', ' ')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Upcoming jobs */}
          {upcomingJobs.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-gray-400" /> Upcoming
              </h3>
              <div className="space-y-2">
                {upcomingJobs.map(job => (
                  <div key={job.id} onClick={() => navigate('/scheduling')}
                    className="flex items-center gap-3 bg-gray-50 hover:bg-gray-100 rounded-lg p-3 cursor-pointer transition-colors">
                    <div className="text-xs text-gray-400 w-20 shrink-0">
                      {new Date(job.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-900 truncate">{job.title}</div>
                      <div className="text-xs text-gray-500">{clientName(job.client_id)} · {job.start_time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Outstanding invoices */}
          {unpaidInvoices.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-yellow-400" /> Outstanding Invoices
                </h3>
                <button onClick={() => navigate('/invoicing')}
                  className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1">
                  View all <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-2">
                {unpaidInvoices.map(inv => (
                  <div key={inv.id} onClick={() => navigate('/invoicing')}
                    className="flex items-center gap-3 bg-gray-50 hover:bg-gray-100 rounded-lg p-3 cursor-pointer transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">{inv.invoice_number}</span>
                        <span className="text-gray-600">·</span>
                        <span className="text-sm text-gray-600 truncate">{clientName(inv.client_id)}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">Due {inv.due_date || 'No due date'}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-gray-900">${inv.total?.toFixed(2)}</div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${inv.status === 'overdue' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                        {inv.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">

          {/* Quick actions */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <h3 className="font-semibold text-gray-900 mb-3">Quick Actions</h3>
            <div className="space-y-2">
              {[
                { label: 'New Client / Lead', icon: Users, to: '/clients', color: 'text-purple-400' },
                { label: 'Create Quote', icon: FileText, to: '/quoting', color: 'text-blue-400' },
                { label: 'Schedule Job', icon: Calendar, to: '/scheduling', color: 'text-sky-400' },
                { label: 'Create Invoice', icon: DollarSign, to: '/invoicing', color: 'text-green-400' },
                { label: 'Send SMS', icon: TrendingUp, to: '/comms', color: 'text-yellow-400' },
              ].map(({ label, icon: Icon, to, color }) => (
                <button key={to} onClick={() => navigate(to)}
                  className="w-full flex items-center gap-3 bg-gray-50 hover:bg-gray-100 px-3 py-2.5 rounded-lg text-sm transition-colors text-left">
                  <Icon className={`w-4 h-4 shrink-0 ${color}`} />
                  <span className="text-gray-600">{label}</span>
                  <ArrowRight className="w-3.5 h-3.5 ml-auto text-gray-600" />
                </button>
              ))}
            </div>
          </div>

          {/* Recent clients / leads */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-900">Recent Clients</h3>
              <button onClick={() => navigate('/clients')}
                className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1">
                All <ArrowRight className="w-3 h-3" />
              </button>
            </div>
            {recentClients.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No clients yet</p>
            ) : (
              <div className="space-y-2">
                {recentClients.map(c => (
                  <div key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
                    className="flex items-center gap-3 hover:bg-gray-50 rounded-lg p-2 cursor-pointer transition-colors">
                    <div className="w-8 h-8 rounded-full bg-sky-50 flex items-center justify-center shrink-0">
                      <span className="text-sky-400 text-xs font-bold">{c.name[0]?.toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-900 truncate">{c.name}</div>
                      <div className="text-xs text-gray-500">{c.phone || c.email || 'No contact'}</div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize shrink-0 ${
                      c.status === 'active' ? 'bg-green-500/20 text-green-400' :
                      c.status === 'lead'   ? 'bg-yellow-500/20 text-yellow-400' :
                                              'bg-gray-500/20 text-gray-400'
                    }`}>{c.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Ask an agent */}
          <div
            onClick={() => navigate('/workspace')}
            className="bg-gradient-to-br from-sky-50 to-purple-50 border border-sky-200 rounded-xl p-5 cursor-pointer hover:border-sky-300 transition-colors"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">⚡</span>
              <h3 className="font-semibold text-gray-900">Ask an Agent</h3>
            </div>
            <p className="text-xs text-gray-400 mb-3">Nova, Mia, Scout, Finn, and Pixel are ready to help you run and grow your business.</p>
            <div className="flex items-center gap-1 text-xs text-sky-400">
              Open Workspace <ArrowRight className="w-3 h-3" />
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
