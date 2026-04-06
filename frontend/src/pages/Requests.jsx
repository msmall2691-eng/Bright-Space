import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, patch } from '../api'
import {
  Inbox, Globe, ArrowRight, FileText, Calendar, CheckCircle, Clock, Eye,
  Phone, Mail, MapPin, Home, Users, ChevronDown, ChevronUp, Plus,
  RefreshCw, X, Bed, Bath, Ruler, CalendarDays, AlertTriangle,
  Filter, Search, Star, Archive, MessageSquare, ArrowUpRight,
  Flag, StickyNote, ChevronRight, MoreHorizontal, Zap
} from 'lucide-react'

// ── Pipeline stages ──────────────────────────────────────────────────────────
const PIPELINE_STAGES = [
  { key: 'new',       label: 'New',        color: 'amber',   icon: Inbox },
  { key: 'reviewed',  label: 'Reviewed',   color: 'blue',    icon: Eye },
  { key: 'quoted',    label: 'Quoted',     color: 'purple',  icon: FileText },
  { key: 'converted', label: 'Converted',  color: 'emerald', icon: Calendar },
]

const STAGE_COLORS = {
  new:       { bg: 'bg-amber-50',   border: 'border-amber-200',  badge: 'bg-amber-100 text-amber-700',   dot: 'bg-amber-400',  header: 'text-amber-700' },
  reviewed:  { bg: 'bg-blue-50',    border: 'border-blue-200',   badge: 'bg-blue-100 text-blue-700',     dot: 'bg-blue-400',   header: 'text-blue-700' },
  quoted:    { bg: 'bg-purple-50',  border: 'border-purple-200', badge: 'bg-purple-100 text-purple-700', dot: 'bg-purple-400', header: 'text-purple-700' },
  converted: { bg: 'bg-emerald-50', border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-400', header: 'text-emerald-700' },
  archived:  { bg: 'bg-gray-50',    border: 'border-gray-200',   badge: 'bg-gray-100 text-gray-500',     dot: 'bg-gray-300',   header: 'text-gray-500' },
}

const PRIORITY_CONFIG = {
  urgent: { label: 'Urgent', color: 'text-red-600 bg-red-50 border-red-200', dot: 'bg-red-500', icon: AlertTriangle },
  high:   { label: 'High',   color: 'text-orange-600 bg-orange-50 border-orange-200', dot: 'bg-orange-500', icon: Flag },
  normal: { label: 'Normal', color: 'text-gray-500 bg-gray-50 border-gray-200', dot: 'bg-gray-400', icon: null },
  low:    { label: 'Low',    color: 'text-gray-400 bg-gray-50 border-gray-200', dot: 'bg-gray-300', icon: null },
}

const SERVICE_LABELS = {
  residential: 'Residential',
  commercial: 'Commercial',
  str: 'STR / Vacation',
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return ''
  const now = new Date()
  const then = new Date(dateStr)
  const mins = Math.floor((now - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function urgencyLevel(dateStr) {
  if (!dateStr) return 'normal'
  const hrs = (new Date() - new Date(dateStr)) / 3600000
  if (hrs > 48) return 'overdue'
  if (hrs > 24) return 'warning'
  return 'normal'
}

function Toast({ msg }) {
  return (
    <div className="fixed bottom-6 right-6 bg-white border border-gray-200 text-gray-900 text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50">
      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />{msg}
    </div>
  )
}

// ── Inbox Row ────────────────────────────────────────────────────────────────
function InboxRow({ intake, quotes, onAdvance, onAction, onUpdateField, expanded, onToggle }) {
  const colors = STAGE_COLORS[intake.status] || STAGE_COLORS.new
  const linkedQuote = quotes.find(q => q.intake_id === intake.id)
  const estimate = intake.estimate_min && intake.estimate_max
    ? `$${intake.estimate_min.toFixed(0)}-$${intake.estimate_max.toFixed(0)}`
    : null
  const urgency = intake.status === 'new' ? urgencyLevel(intake.created_at) : 'normal'
  const priorityCfg = PRIORITY_CONFIG[intake.priority || 'normal']

  const [editingNotes, setEditingNotes] = useState(false)
  const [notesVal, setNotesVal] = useState(intake.internal_notes || '')

  const saveNotes = () => {
    onUpdateField(intake.id, 'internal_notes', notesVal)
    setEditingNotes(false)
  }

  return (
    <div className={`border rounded-xl transition-all ${
      urgency === 'overdue' ? 'border-red-200 bg-red-50/30' :
      urgency === 'warning' ? 'border-amber-200 bg-amber-50/20' :
      'border-gray-200 bg-white'
    } ${expanded ? 'shadow-md' : 'hover:shadow-sm'}`}>
      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={onToggle}>
        {/* Priority dot */}
        <div className="flex flex-col items-center gap-1">
          <div className={`w-2.5 h-2.5 rounded-full ${priorityCfg.dot}`} />
          {urgency === 'overdue' && <AlertTriangle className="w-3 h-3 text-red-500" />}
        </div>

        {/* Status badge */}
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium capitalize shrink-0 ${colors.badge}`}>
          {intake.status}
        </span>

        {/* Name & contact */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-gray-900 truncate">{intake.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 capitalize shrink-0">
              {SERVICE_LABELS[intake.service_type] || intake.service_type}
            </span>
            {intake.priority && intake.priority !== 'normal' && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${priorityCfg.color}`}>
                {priorityCfg.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
            {intake.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{intake.phone}</span>}
            {intake.email && <span className="flex items-center gap-1 truncate"><Mail className="w-3 h-3" />{intake.email}</span>}
            {intake.address && <span className="flex items-center gap-1 truncate"><MapPin className="w-3 h-3" />{intake.address}</span>}
          </div>
        </div>

        {/* Estimate */}
        {estimate && (
          <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg shrink-0">
            {estimate}
          </span>
        )}

        {/* Linked quote */}
        {linkedQuote && (
          <span className="text-[10px] bg-purple-50 text-purple-600 px-2 py-1 rounded-lg shrink-0">
            {linkedQuote.quote_number}
          </span>
        )}

        {/* Time */}
        <span className={`text-xs shrink-0 ${
          urgency === 'overdue' ? 'text-red-500 font-medium' :
          urgency === 'warning' ? 'text-amber-500' : 'text-gray-400'
        }`}>
          {timeAgo(intake.created_at)}
        </span>

        {/* Quick actions */}
        <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          {intake.status === 'new' && (
            <>
              <button onClick={() => onAdvance(intake.id, 'reviewed')}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-600 transition-colors" title="Mark Reviewed">
                <Eye className="w-4 h-4" />
              </button>
              <button onClick={() => onAction(intake, 'quote')}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-purple-600 transition-colors" title="Create Quote">
                <FileText className="w-4 h-4" />
              </button>
            </>
          )}
          {intake.status === 'reviewed' && (
            <button onClick={() => onAction(intake, 'quote')}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-purple-600 transition-colors" title="Create Quote">
              <FileText className="w-4 h-4" />
            </button>
          )}
          {intake.status === 'quoted' && linkedQuote?.status === 'accepted' && (
            <button onClick={() => onAction(intake, 'schedule')}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-emerald-600 transition-colors" title="Schedule Job">
              <Calendar className="w-4 h-4" />
            </button>
          )}
          {intake.status !== 'archived' && intake.status !== 'converted' && (
            <button onClick={() => onAdvance(intake.id, 'archived')}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" title="Archive">
              <Archive className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <ChevronRight className={`w-4 h-4 text-gray-300 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 space-y-3">
          {/* Property details */}
          <div className="flex flex-wrap gap-3">
            {intake.bedrooms && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg">
                <Bed className="w-3.5 h-3.5 text-gray-400" /> {intake.bedrooms} bed
              </span>
            )}
            {intake.bathrooms && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg">
                <Bath className="w-3.5 h-3.5 text-gray-400" /> {intake.bathrooms} bath
              </span>
            )}
            {intake.square_footage && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg">
                <Ruler className="w-3.5 h-3.5 text-gray-400" /> {intake.square_footage} sq ft
              </span>
            )}
            {intake.guests && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg">
                <Users className="w-3.5 h-3.5 text-gray-400" /> {intake.guests} guests
              </span>
            )}
            {intake.property_name && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg">
                <Home className="w-3.5 h-3.5 text-gray-400" /> {intake.property_name}
              </span>
            )}
            {intake.frequency && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg">
                <RefreshCw className="w-3.5 h-3.5 text-gray-400" /> {intake.frequency}
              </span>
            )}
            {(intake.requested_date || intake.preferred_date) && (
              <span className="flex items-center gap-1.5 text-xs text-gray-500 bg-gray-50 px-2.5 py-1 rounded-lg">
                <CalendarDays className="w-3.5 h-3.5 text-gray-400" /> {intake.requested_date || intake.preferred_date}
              </span>
            )}
          </div>

          {/* Check-in / Check-out */}
          {(intake.check_in || intake.check_out) && (
            <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
              {intake.check_in && <span>Check-in: {intake.check_in.slice(0, 10)}</span>}
              {intake.check_in && intake.check_out && <span className="mx-2 text-gray-300">|</span>}
              {intake.check_out && <span>Check-out: {intake.check_out.slice(0, 10)}</span>}
            </div>
          )}

          {/* Customer message */}
          {intake.message && (
            <div className="text-xs text-gray-600 bg-blue-50 rounded-lg px-3 py-2 border border-blue-100">
              <span className="font-medium text-blue-600">Customer note:</span> "{intake.message}"
            </div>
          )}

          {/* Linked quote */}
          {linkedQuote && (
            <div className="text-xs bg-purple-50 text-purple-700 rounded-lg px-3 py-2 flex items-center gap-2 border border-purple-100">
              <FileText className="w-3.5 h-3.5" />
              <span>Quote {linkedQuote.quote_number} — ${parseFloat(linkedQuote.total || 0).toFixed(2)}</span>
              <span className={`ml-auto text-[10px] px-2 py-0.5 rounded-full capitalize ${
                linkedQuote.status === 'accepted' ? 'bg-emerald-100 text-emerald-700' :
                linkedQuote.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                linkedQuote.status === 'declined' ? 'bg-red-100 text-red-700' :
                'bg-gray-100 text-gray-600'
              }`}>{linkedQuote.status}</span>
            </div>
          )}

          {/* Internal notes + priority + actions row */}
          <div className="flex items-start gap-3 pt-1" onClick={e => e.stopPropagation()}>
            {/* Internal notes */}
            <div className="flex-1">
              {editingNotes ? (
                <div className="flex gap-2">
                  <input
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                    placeholder="Add internal note..."
                    value={notesVal}
                    onChange={e => setNotesVal(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveNotes()}
                    autoFocus
                  />
                  <button onClick={saveNotes} className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-800">Save</button>
                  <button onClick={() => { setEditingNotes(false); setNotesVal(intake.internal_notes || '') }} className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700">Cancel</button>
                </div>
              ) : (
                <button onClick={() => setEditingNotes(true)}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                  <StickyNote className="w-3.5 h-3.5" />
                  {intake.internal_notes || 'Add note...'}
                </button>
              )}
            </div>

            {/* Priority selector */}
            <select
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
              value={intake.priority || 'normal'}
              onChange={e => onUpdateField(intake.id, 'priority', e.target.value)}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>

            {/* Action buttons */}
            <div className="flex gap-1.5">
              {intake.status === 'new' && (
                <button onClick={() => onAdvance(intake.id, 'reviewed')}
                  className="text-xs px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors font-medium">
                  Mark Reviewed
                </button>
              )}
              {(intake.status === 'new' || intake.status === 'reviewed') && (
                <button onClick={() => onAction(intake, 'quote')}
                  className="text-xs px-3 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors font-medium">
                  Create Quote
                </button>
              )}
              {intake.status === 'quoted' && linkedQuote?.status === 'accepted' && (
                <button onClick={() => onAction(intake, 'schedule')}
                  className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-medium">
                  Schedule Job
                </button>
              )}
              {intake.client_id && (
                <button onClick={() => onAction(intake, 'client')}
                  className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors">
                  View Client
                </button>
              )}
            </div>
          </div>

          {/* Metadata */}
          <div className="flex items-center gap-3 text-[10px] text-gray-400 pt-1 border-t border-gray-100">
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />
              {new Date(intake.created_at).toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit'
              })}
            </span>
            {intake.source && <span>via {intake.source}</span>}
            {intake.assigned_to && <span>assigned to {intake.assigned_to}</span>}
            {intake.followed_up_at && <span>followed up {timeAgo(intake.followed_up_at)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Kanban Card (compact) ────────────────────────────────────────────────────
function KanbanCard({ intake, quotes, onAdvance, onAction }) {
  const linkedQuote = quotes.find(q => q.intake_id === intake.id)
  const estimate = intake.estimate_min && intake.estimate_max
    ? `$${intake.estimate_min.toFixed(0)}-$${intake.estimate_max.toFixed(0)}`
    : null
  const priorityCfg = PRIORITY_CONFIG[intake.priority || 'normal']
  const urgency = intake.status === 'new' ? urgencyLevel(intake.created_at) : 'normal'

  return (
    <div className={`bg-white border rounded-xl overflow-hidden transition-all hover:shadow-md ${
      urgency === 'overdue' ? 'border-red-200' : urgency === 'warning' ? 'border-amber-200' : 'border-gray-200'
    }`}>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {intake.priority && intake.priority !== 'normal' && (
                <div className={`w-2 h-2 rounded-full shrink-0 ${priorityCfg.dot}`} />
              )}
              <span className="font-semibold text-sm text-gray-900 truncate">{intake.name}</span>
            </div>
          </div>
          <span className={`text-xs shrink-0 ${
            urgency === 'overdue' ? 'text-red-500 font-medium' :
            urgency === 'warning' ? 'text-amber-500' : 'text-gray-400'
          }`}>
            {timeAgo(intake.created_at)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 capitalize">
            {SERVICE_LABELS[intake.service_type] || intake.service_type}
          </span>
          {estimate && (
            <span className="text-[10px] font-medium text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">
              {estimate}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-gray-400">
          {intake.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{intake.phone}</span>}
          {intake.email && <span className="flex items-center gap-1 truncate"><Mail className="w-3 h-3" />{intake.email}</span>}
        </div>

        {intake.internal_notes && (
          <div className="mt-2 text-[11px] text-gray-500 bg-yellow-50 rounded-lg px-2 py-1 border border-yellow-100 truncate">
            <StickyNote className="w-3 h-3 inline mr-1 text-yellow-500" />{intake.internal_notes}
          </div>
        )}

        {linkedQuote && (
          <div className="mt-2 text-[10px] bg-purple-50 text-purple-600 rounded-lg px-2 py-1 flex items-center gap-1">
            <FileText className="w-3 h-3" /> {linkedQuote.quote_number} — ${parseFloat(linkedQuote.total || 0).toFixed(2)}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="px-3 py-2 bg-gray-50 border-t border-gray-100 flex gap-1.5">
        {intake.status === 'new' && (
          <>
            <button onClick={() => onAdvance(intake.id, 'reviewed')}
              className="flex-1 text-[11px] font-medium px-2 py-1.5 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded-lg transition-colors text-center">
              Review
            </button>
            <button onClick={() => onAction(intake, 'quote')}
              className="flex-1 text-[11px] font-medium px-2 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors text-center">
              Quote
            </button>
          </>
        )}
        {intake.status === 'reviewed' && (
          <button onClick={() => onAction(intake, 'quote')}
            className="flex-1 text-[11px] font-medium px-2 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors text-center">
            Create Quote
          </button>
        )}
        {intake.status === 'quoted' && linkedQuote?.status === 'accepted' && (
          <button onClick={() => onAction(intake, 'schedule')}
            className="flex-1 text-[11px] font-medium px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors text-center">
            Schedule
          </button>
        )}
        {intake.status === 'quoted' && linkedQuote && linkedQuote.status !== 'accepted' && (
          <span className="flex-1 text-center text-[11px] text-gray-400 py-1.5">Awaiting response</span>
        )}
        {intake.status === 'converted' && (
          <span className="flex-1 text-center text-[11px] text-emerald-600 py-1.5 flex items-center justify-center gap-1">
            <CheckCircle className="w-3 h-3" /> Done
          </span>
        )}
      </div>
    </div>
  )
}


// ── Main Page ────────────────────────────────────────────────────────────────
export default function Requests() {
  const navigate = useNavigate()
  const [intakes, setIntakes] = useState([])
  const [quotes, setQuotes] = useState([])
  const [stats, setStats] = useState({})
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [view, setView] = useState('inbox')       // 'inbox' | 'board'
  const [filterStatus, setFilterStatus] = useState('active')  // 'active' | 'new' | 'reviewed' | 'quoted' | 'converted' | 'archived' | 'all'
  const [filterService, setFilterService] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [sortBy, setSortBy] = useState('newest')   // 'newest' | 'oldest' | 'priority'

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500) }

  const loadData = async () => {
    try {
      const [intakeRes, quoteRes, statsRes] = await Promise.all([
        get('/api/intake'),
        get('/api/quotes'),
        get('/api/intake/stats'),
      ])
      setIntakes(Array.isArray(intakeRes) ? intakeRes : [])
      setQuotes(Array.isArray(quoteRes) ? quoteRes : [])
      setStats(statsRes || {})
    } catch { }
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const advanceStatus = async (intakeId, newStatus) => {
    try {
      await patch(`/api/intake/${intakeId}`, { status: newStatus })
      await loadData()
      showToast(`Moved to ${newStatus}`)
    } catch { showToast('Error updating status') }
  }

  const updateField = async (intakeId, field, value) => {
    try {
      await patch(`/api/intake/${intakeId}`, { [field]: value })
      await loadData()
      showToast('Updated')
    } catch { showToast('Error updating') }
  }

  const handleAction = (intake, action) => {
    if (action === 'quote') {
      navigate('/quoting', { state: { intakeId: intake.id } })
    } else if (action === 'schedule') {
      const linkedQuote = quotes.find(q => q.intake_id === intake.id)
      if (linkedQuote) convertToJob(linkedQuote.id)
    } else if (action === 'client' && intake.client_id) {
      navigate(`/clients/${intake.client_id}`)
    }
  }

  const convertToJob = async (quoteId) => {
    try {
      const r = await fetch(`/api/quotes/${quoteId}/convert-to-job`, { method: 'POST' })
      if (!r.ok) throw new Error()
      showToast('Job created — set the date in Scheduling')
      await loadData()
    } catch { showToast('Error converting to job') }
  }

  // ── Filtering & sorting ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let items = [...intakes]

    // Status filter
    if (filterStatus === 'active') {
      items = items.filter(i => i.status !== 'archived' && i.status !== 'converted')
    } else if (filterStatus !== 'all') {
      items = items.filter(i => i.status === filterStatus)
    }

    // Service filter
    if (filterService !== 'all') {
      items = items.filter(i => i.service_type === filterService)
    }

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      items = items.filter(i =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.email || '').toLowerCase().includes(q) ||
        (i.phone || '').includes(q) ||
        (i.address || '').toLowerCase().includes(q)
      )
    }

    // Sort
    if (sortBy === 'priority') {
      const order = { urgent: 0, high: 1, normal: 2, low: 3 }
      items.sort((a, b) => (order[a.priority || 'normal'] || 2) - (order[b.priority || 'normal'] || 2))
    } else if (sortBy === 'oldest') {
      items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    }
    // 'newest' is default from API

    return items
  }, [intakes, filterStatus, filterService, searchQuery, sortBy])

  const grouped = PIPELINE_STAGES.reduce((acc, stage) => {
    acc[stage.key] = intakes.filter(i => i.status === stage.key)
    return acc
  }, {})

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-5 h-5 text-gray-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 shrink-0 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-gray-900">Requests</h1>
            {stats.new > 0 && (
              <span className="bg-amber-100 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
                {stats.new} new
              </span>
            )}
            {stats.urgent > 0 && (
              <span className="bg-red-100 text-red-600 text-xs font-bold px-2 py-0.5 rounded-full">
                {stats.urgent} urgent
              </span>
            )}
            <span className="text-xs text-gray-400">maineclean.co incoming leads</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              <button onClick={() => setView('inbox')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${view === 'inbox' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                Inbox
              </button>
              <button onClick={() => setView('board')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${view === 'board' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                Board
              </button>
            </div>
            <button onClick={loadData}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            {[
              { key: 'active', label: 'Active', count: (stats.new || 0) + (stats.reviewed || 0) + (stats.quoted || 0) },
              { key: 'new', label: 'New', count: stats.new || 0 },
              { key: 'reviewed', label: 'Reviewed', count: stats.reviewed || 0 },
              { key: 'quoted', label: 'Quoted', count: stats.quoted || 0 },
              { key: 'converted', label: 'Converted', count: stats.converted || 0 },
              { key: 'archived', label: 'Archived', count: stats.archived || 0 },
              { key: 'all', label: 'All', count: stats.total || 0 },
            ].map(tab => (
              <button key={tab.key} onClick={() => setFilterStatus(tab.key)}
                className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
                  filterStatus === tab.key
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}>
                {tab.label}
                <span className={`ml-1 ${filterStatus === tab.key ? 'text-white/70' : 'text-gray-400'}`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Service filter */}
            <select value={filterService} onChange={e => setFilterService(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-900/10">
              <option value="all">All services</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="str">STR / Vacation</option>
            </select>

            {/* Sort */}
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-900/10">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="priority">Priority</option>
            </select>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                className="text-xs border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 w-48 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                placeholder="Search name, email, phone..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Inbox view */}
      {view === 'inbox' && (
        <div className="flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <div className="text-center py-16">
              <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No requests found</p>
              <p className="text-xs text-gray-400 mt-1">
                {searchQuery ? 'Try a different search' : 'Submissions from maineclean.co will appear here'}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-w-5xl mx-auto">
              {filtered.map(intake => (
                <InboxRow
                  key={intake.id}
                  intake={intake}
                  quotes={quotes}
                  onAdvance={advanceStatus}
                  onAction={handleAction}
                  onUpdateField={updateField}
                  expanded={expandedId === intake.id}
                  onToggle={() => setExpandedId(expandedId === intake.id ? null : intake.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Board view */}
      {view === 'board' && (
        <div className="flex-1 overflow-x-auto p-4">
          <div className="flex gap-4 min-w-max h-full">
            {PIPELINE_STAGES.map(stage => {
              const items = grouped[stage.key] || []
              const colors = STAGE_COLORS[stage.key]
              const StageIcon = stage.icon
              return (
                <div key={stage.key} className="w-[320px] flex flex-col min-h-0">
                  <div className={`flex items-center gap-2 px-3 py-2.5 rounded-t-xl ${colors.bg} border ${colors.border} border-b-0`}>
                    <div className={`w-2 h-2 rounded-full ${colors.dot}`} />
                    <StageIcon className={`w-4 h-4 ${colors.header}`} />
                    <span className={`text-sm font-semibold ${colors.header}`}>{stage.label}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ml-auto ${colors.badge}`}>
                      {items.length}
                    </span>
                  </div>
                  <div className={`flex-1 overflow-y-auto border ${colors.border} border-t-0 rounded-b-xl p-2 space-y-2 bg-gray-50/50`}>
                    {items.length === 0 && (
                      <div className="text-center py-8 text-gray-400 text-xs">No requests</div>
                    )}
                    {items.map(intake => (
                      <KanbanCard
                        key={intake.id}
                        intake={intake}
                        quotes={quotes}
                        onAdvance={advanceStatus}
                        onAction={handleAction}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {toast && <Toast msg={toast} />}
    </div>
  )
}
