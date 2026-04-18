import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { get } from "../api"
import {
  Calendar, DollarSign, Users, FileText, Clock,
  AlertCircle, TrendingUp, Plus, ArrowRight, MapPin, RefreshCw,
  Globe, Inbox, Phone, Mail, MessageSquare, Zap, ArrowUpRight,
  CheckCircle2, ChevronRight
} from 'lucide-react'

/* ── Helpers ─────────────────────────────────────────────────── */
const AVATAR_COLORS = [
  'bg-blue-50 text-blue-700',
  'bg-emerald-50 text-emerald-700',
  'bg-violet-50 text-violet-700',
  'bg-amber-50 text-amber-700',
  'bg-rose-50 text-rose-700',
  'bg-cyan-50 text-cyan-700',
]
function avatarColor(name) {
  let h = 0; for (const c of (name || '')) h = ((h << 5) - h + c.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

const JOB_STATUS = {
  scheduled:   { label: 'Scheduled',   cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  in_progress: { label: 'In Progress', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  completed:   { label: 'Completed',   cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  cancelled:   { label: 'Cancelled',   cls: 'bg-zinc-50 text-zinc-700 border-zinc-200' },
}

/* ── Stat Card ───────────────────────────────────────────────── */
function StatCard({ icon: Icon, label, value, sub, accent = 'text-blue-700', iconCls = 'bg-blue-50 text-blue-700' }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-4 sm:p-5 hover:border-zinc-300 transition-colors">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{label}</p>
          <p className={`text-xl sm:text-2xl font-bold ${accent}`}>{value}</p>
          {sub && <p className="text-[11px] text-zinc-600 mt-1">{sub}</p>}
        </div>
        <div className={`p-2 rounded-lg ${iconCls}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
    </div>
  )
}

/* ── Page ─────────────────────────────────────────────────────── */
export default function Dashboard() {
  const navigate = useNavigate()
  const [todayJobs, setTodayJobs] = useState([])
  const [upcomingJobs, setUpcomingJobs] = useState([])
  const [weekJobs, setWeekJobs] = useState([])
  const [clients, setClients] = useState([])
  const [invoices, setInvoices] = useState([])
  const [recurringCount, setRecurringCount] = useState(0)
  const [schedules, setSchedules] = useState([])
  const [newRequests, setNewRequests] = useState([])
  const [recentMessages, setRecentMessages] = useState([])
  const [loading, setLoading] = useState(true)

  const today = new Date().toISOString().slice(0, 10)
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

  useEffect(() => {
    const load = async () => {
      try {
        const [jobsToday, jobsWeek, clientsAll, invoicesAll, schedules, intakesNew, gmailData] = await Promise.all([
          get(`/api/jobs?date=${today}`),
          get(`/api/jobs?date_from=${today}&date_to=${weekEnd}`),
          get('/api/clients'),
          get('/api/invoices'),
          get('/api/recurring'),
          get('/api/intake?status=new'),
          get('/api/gmail/inbox?max_results=10').catch(() => ({ emails: [] })),
        ])
        setTodayJobs(Array.isArray(jobsToday) ? jobsToday : [])
        const week = Array.isArray(jobsWeek) ? jobsWeek : []
        setWeekJobs(week)
        setUpcomingJobs(week.filter(j => j.scheduled_date > today && j.status === 'scheduled').slice(0, 3))
        setClients(Array.isArray(clientsAll) ? clientsAll : [])
        setInvoices(Array.isArray(invoicesAll) ? invoicesAll : [])
        const sched = Array.isArray(schedules) ? schedules : []
        setSchedules(sched)
        setRecurringCount(sched.filter(s => s.active).length)
        setNewRequests(Array.isArray(intakesNew) ? intakesNew.slice(0, 5) : [])
        setRecentMessages((gmailData?.emails || []).slice(0, 5))
      } catch {}
      setLoading(false)
    }
    load()
  }, [])

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
    .sort((a, b) => (a.status === 'overdue' ? -1 : 1)).slice(0, 5)
  const activeClients = clients.filter(c => c.status === 'active').length
  const newLeads = clients.filter(c => c.status === 'lead').length
  const recentClients = [...clients].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5)
  const clientName = (id) => clients.find(c => c.id === id)?.name || `Client #${id}`
  const completedToday = todayJobs.filter(j => j.status === 'completed').length
  const weekTotal = weekJobs.length

  const activeSchedules = schedules.filter(s => s.active)
  const recurringSubtitle = activeSchedules.length === 0
    ? 'No active schedules'
    : `${activeSchedules.filter(s => s.frequency === 'weekly').length} weekly · ${activeSchedules.filter(s => s.frequency === 'biweekly').length} biweekly · ${activeSchedules.filter(s => s.frequency === 'monthly').length} monthly`

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-zinc-600 text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading...
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 space-y-5 overflow-y-auto h-full">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </h2>
          <p className="text-[13px] text-zinc-600 mt-0.5">
            {todayJobs.length === 0
              ? 'No jobs scheduled today'
              : `${todayJobs.length} job${todayJobs.length > 1 ? 's' : ''} today · ${completedToday} completed`}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate('/clients')}
            className="flex items-center gap-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-600 border border-zinc-200 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors">
            <Plus className="w-3.5 h-3.5" /> Client
          </button>
          <button onClick={() => navigate('/scheduling')}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-[13px] font-medium transition-colors">
            <Plus className="w-3.5 h-3.5" /> Job
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Calendar} label="Today's Jobs" value={todayJobs.length}
          sub={completedToday > 0 ? `${completedToday} completed` : weekTotal > 0 ? `${weekTotal} this week` : 'None scheduled'}
          accent={todayJobs.length > 0 ? 'text-blue-600' : 'text-zinc-600'}
          iconCls="bg-blue-50 text-blue-500" />
        <StatCard icon={DollarSign} label="This Month" value={`$${monthRevenue.toLocaleString()}`}
          sub="Paid invoices"
          accent="text-emerald-600"
          iconCls="bg-emerald-50 text-emerald-500" />
        <StatCard icon={AlertCircle} label="Outstanding" value={`$${outstanding.toLocaleString()}`}
          sub={`${unpaidInvoices.length} invoice${unpaidInvoices.length !== 1 ? 's' : ''}${overdueInvoices.length > 0 ? ` · ${overdueInvoices.length} overdue` : ''}`}
          accent={overdueInvoices.length > 0 ? 'text-red-500' : outstanding > 0 ? 'text-amber-500' : 'text-zinc-600'}
          iconCls={overdueInvoices.length > 0 ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-500'} />
        <StatCard icon={RefreshCw} label="Recurring" value={recurringCount}
          sub={recurringSubtitle}
          accent="text-violet-600"
          iconCls="bg-violet-50 text-violet-500" />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left — spans 2 */}
        <div className="lg:col-span-2 space-y-4">

          {/* New Requests */}
          {newRequests.length > 0 && (
            <div className="bg-amber-50 border border-amber-200/60 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[13px] font-semibold text-amber-800 flex items-center gap-2">
                  <Inbox className="w-4 h-4 text-amber-500" /> New Requests
                  <span className="bg-amber-200 text-amber-800 text-[11px] font-bold px-2 py-0.5 rounded-full">{newRequests.length}</span>
                </h3>
                <button onClick={() => navigate('/requests')}
                  className="text-[11px] text-amber-700 hover:text-amber-900 flex items-center gap-1 font-medium">
                  View all <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1.5">
                {newRequests.map(req => {
                  const SrcIcon = { website: Globe, sms: MessageSquare, email: Mail, phone: Phone, manual: Plus }[req.source] || Globe
                  return (
                    <div key={req.id} onClick={() => navigate('/requests')}
                      className="flex items-center gap-3 bg-white hover:bg-amber-50/50 border border-amber-100 rounded-lg p-3 cursor-pointer transition-colors">
                      <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center shrink-0">
                        <SrcIcon className="w-3.5 h-3.5 text-amber-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-zinc-900 truncate block">{req.name}</span>
                        <div className="flex items-center gap-2 text-[11px] text-zinc-600 mt-0.5">
                          {req.phone && <span>{req.phone}</span>}
                          <span className="capitalize">via {req.source}</span>
                        </div>
                      </div>
                      <span className="text-[11px] text-zinc-600 shrink-0">
                        {new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Recent Messages */}
          {recentMessages.length > 0 && (
            <div className="bg-white border border-zinc-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[13px] font-semibold text-zinc-900 flex items-center gap-2">
                  <Mail className="w-4 h-4 text-blue-500" /> Recent Messages
                  {recentMessages.some(m => !m.is_read) && (
                    <span className="bg-blue-100 text-blue-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                      {recentMessages.filter(m => !m.is_read).length}
                    </span>
                  )}
                </h3>
                <button onClick={() => navigate('/inbox')}
                  className="text-[11px] text-blue-500 hover:text-blue-600 flex items-center gap-1 font-medium">
                  View all <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1.5">
                {recentMessages.map(msg => (
                  <div key={msg.id} onClick={() => navigate('/inbox')}
                    className={`flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-colors ${
                      !msg.is_read ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-zinc-50'
                    }`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                      msg.is_known_contact ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                    }`}>
                      {msg.from_name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-[13px] truncate ${!msg.is_read ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'}`}>
                          {msg.from_name}
                        </span>
                        {!msg.is_read && <span className="w-2 h-2 bg-blue-500 rounded-full shrink-0" />}
                      </div>
                      <p className={`text-[12px] truncate mt-0.5 ${!msg.is_read ? 'text-zinc-600' : 'text-zinc-600'}`}>
                        {msg.subject}
                      </p>
                    </div>
                    <span className="text-[11px] text-zinc-600 shrink-0">
                      {new Date(msg.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Today's Schedule */}
          <div className="bg-white border border-zinc-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[13px] font-semibold text-zinc-900 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-blue-500" /> Today's Schedule
              </h3>
              <button onClick={() => navigate('/scheduling')}
                className="text-[11px] text-blue-500 hover:text-blue-600 flex items-center gap-1 font-medium">
                View all <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {todayJobs.length === 0 ? (
              <div className="text-center py-10">
                <Calendar className="w-9 h-9 mx-auto mb-2 text-zinc-300" />
                <p className="text-[13px] text-zinc-600">No jobs today</p>
                <button onClick={() => navigate('/scheduling')}
                  className="mt-2 text-[12px] text-blue-500 hover:text-blue-600 font-medium">
                  + Schedule a job
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {todayJobs.map(job => {
                  const st = JOB_STATUS[job.status] || JOB_STATUS.scheduled
                  return (
                    <div key={job.id} onClick={() => navigate('/scheduling')}
                      className="flex items-center gap-3 hover:bg-zinc-50 rounded-lg p-3 cursor-pointer transition-colors group">
                      <div className="text-center w-14 shrink-0">
                        <div className="text-[13px] font-semibold text-zinc-900">{job.start_time}</div>
                        <div className="text-[11px] text-zinc-600">{job.end_time}</div>
                      </div>
                      <div className="w-px h-8 bg-zinc-100 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-zinc-900 truncate">{job.title}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-zinc-600">{clientName(job.client_id)}</span>
                          {job.address && (
                            <span className="text-[11px] text-zinc-600 flex items-center gap-0.5 truncate">
                              <MapPin className="w-3 h-3 shrink-0" />{job.address}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {job.dispatched && (
                          <span className="text-[10px] bg-violet-50 text-violet-700 border border-violet-200 px-2 py-0.5 rounded-full font-medium">
                            Dispatched
                          </span>
                        )}
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium ${st.cls}`}>
                          {st.label}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Upcoming */}
          {upcomingJobs.length > 0 && (
            <div className="bg-white border border-zinc-200 rounded-xl p-5">
              <h3 className="text-[13px] font-semibold text-zinc-900 mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-zinc-600" /> Upcoming
              </h3>
              <div className="space-y-1.5">
                {upcomingJobs.map(job => (
                  <div key={job.id} onClick={() => navigate('/scheduling')}
                    className="flex items-center gap-3 hover:bg-zinc-50 rounded-lg p-3 cursor-pointer transition-colors">
                    <div className="text-[11px] text-zinc-600 w-20 shrink-0 font-medium">
                      {new Date(job.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-zinc-900 truncate">{job.title}</div>
                      <div className="text-[11px] text-zinc-600">{clientName(job.client_id)} · {job.start_time}</div>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-300" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Outstanding Invoices */}
          {unpaidInvoices.length > 0 && (
            <div className="bg-white border border-zinc-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[13px] font-semibold text-zinc-900 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-amber-500" /> Outstanding Invoices
                </h3>
                <button onClick={() => navigate('/invoicing')}
                  className="text-[11px] text-blue-500 hover:text-blue-600 flex items-center gap-1 font-medium">
                  View all <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1.5">
                {unpaidInvoices.map(inv => (
                  <div key={inv.id} onClick={() => navigate('/invoicing')}
                    className="flex items-center gap-3 hover:bg-zinc-50 rounded-lg p-3 cursor-pointer transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-zinc-900">{inv.invoice_number}</span>
                        <span className="text-zinc-300">·</span>
                        <span className="text-[13px] text-zinc-600 truncate">{clientName(inv.client_id)}</span>
                      </div>
                      <div className="text-[11px] text-zinc-600 mt-0.5">Due {inv.due_date || 'No due date'}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] font-semibold text-zinc-900">${inv.total?.toFixed(2)}</div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium capitalize ${
                        inv.status === 'overdue' ? 'bg-red-50 text-red-500 border-red-200' : 'bg-amber-50 text-amber-500 border-amber-200'
                      }`}>{inv.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Quick Actions */}
          <div className="bg-white border border-zinc-200 rounded-xl p-5">
            <h3 className="text-[13px] font-semibold text-zinc-900 mb-3">Quick Actions</h3>
            <div className="space-y-1">
              {[
                { label: 'New Client / Lead', icon: Users, to: '/clients', cls: 'text-violet-500' },
                { label: 'Create Quote',      icon: FileText, to: '/quoting', cls: 'text-blue-500' },
                { label: 'Schedule Job',      icon: Calendar, to: '/scheduling', cls: 'text-cyan-500' },
                { label: 'Create Invoice',    icon: DollarSign, to: '/invoicing', cls: 'text-emerald-500' },
                { label: 'View Messages',     icon: Mail, to: '/inbox', cls: 'text-blue-500', badge: recentMessages.filter(m => !m.is_read).length },
                { label: 'Send Message',      icon: MessageSquare, to: '/comms', cls: 'text-amber-500' },
              ].map(({ label, icon: Icon, to, cls, badge }) => (
                <button key={to} onClick={() => navigate(to)}
                  className="w-full flex items-center gap-3 hover:bg-zinc-50 px-3 py-2.5 rounded-lg text-[13px] transition-colors text-left group">
                  <div className="relative">
                    <Icon className={`w-4 h-4 shrink-0 ${cls}`} />
                    {badge > 0 && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                        {badge}
                      </span>
                    )}
                  </div>
                  <span className="text-zinc-600 group-hover:text-zinc-900 transition-colors">{label}</span>
                  <ChevronRight className="w-3.5 h-3.5 ml-auto text-zinc-300 group-hover:text-zinc-400" />
                </button>
              ))}
            </div>
          </div>

          {/* Recent Clients */}
          <div className="bg-white border border-zinc-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[13px] font-semibold text-zinc-900">Recent Clients</h3>
              <button onClick={() => navigate('/clients')}
                className="text-[11px] text-blue-500 hover:text-blue-600 flex items-center gap-1 font-medium">
                All <ArrowRight className="w-3 h-3" />
              </button>
            </div>
            {recentClients.length === 0 ? (
              <p className="text-[13px] text-zinc-600 text-center py-6">No clients yet</p>
            ) : (
              <div className="space-y-1">
                {recentClients.map(c => (
                  <div key={c.id} onClick={() => navigate(`/clients/${c.id}`)}
                    className="flex items-center gap-3 hover:bg-zinc-50 rounded-lg p-2 cursor-pointer transition-colors">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${avatarColor(c.name)}`}>
                      <span className="text-[11px] font-bold">{c.name[0]?.toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-zinc-900 truncate font-medium">{c.name}</div>
                      <div className="text-[11px] text-zinc-600 truncate">{c.phone || c.email || 'No contact'}</div>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium shrink-0 ${
                      c.status === 'active' ? 'bg-emerald-50 text-emerald-500 border-emerald-200' :
                      c.status === 'lead'   ? 'bg-amber-50 text-amber-500 border-amber-200' :
                                              'bg-zinc-100 text-zinc-600 border-zinc-200'
                    }`}>{c.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Workspace CTA */}
          <div onClick={() => navigate('/workspace')}
            className="bg-gradient-to-br from-blue-600 to-violet-600 rounded-xl p-5 cursor-pointer hover:opacity-95 transition-opacity">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-white" />
              <h3 className="text-[13px] font-semibold text-white">AI Workspace</h3>
            </div>
            <p className="text-[11px] text-blue-100/80 mb-3 leading-relaxed">Your AI agents are ready to help you run and grow your business.</p>
            <div className="flex items-center gap-1 text-[11px] text-white font-medium">
              Open Workspace <ArrowRight className="w-3 h-3" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
