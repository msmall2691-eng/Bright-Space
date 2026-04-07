import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, post, patch } from "../api"
import {
  Globe, ArrowRight, FileText, Calendar, CheckCircle, Clock, Eye,
  Phone, Mail, MapPin, Home, Users, ChevronDown, ChevronUp, Plus,
  RefreshCw, X, Bed, Bath, Ruler, CalendarDays
} from 'lucide-react'

const PIPELINE_STAGES = [
  { key: 'new',       label: 'New Requests',  color: 'amber',   icon: Globe },
  { key: 'reviewed',  label: 'Reviewed',      color: 'blue',    icon: Eye },
  { key: 'quoted',    label: 'Quoted',         color: 'purple',  icon: FileText },
  { key: 'converted', label: 'Scheduled',      color: 'emerald', icon: Calendar },
]

const STAGE_COLORS = {
  new:       { bg: 'bg-amber-50',   border: 'border-amber-200',  badge: 'bg-amber-100 text-amber-700',  dot: 'bg-amber-400',  header: 'text-amber-700' },
  reviewed:  { bg: 'bg-blue-50',    border: 'border-blue-200',   badge: 'bg-blue-100 text-blue-700',    dot: 'bg-blue-400',   header: 'text-blue-700' },
  quoted:    { bg: 'bg-purple-50',  border: 'border-purple-200', badge: 'bg-purple-100 text-purple-700', dot: 'bg-purple-400', header: 'text-purple-700' },
  converted: { bg: 'bg-emerald-50', border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-400', header: 'text-emerald-700' },
}

const SERVICE_LABELS = {
  residential: 'Residential',
  commercial: 'Commercial',
  str: 'STR / Vacation',
}

function Toast({ msg }) {
  return (
    <div className="fixed bottom-6 right-6 bg-white border border-gray-200 text-gray-900 text-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 z-50">
      <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />{msg}
    </div>
  )
}

function RequestCard({ intake, onAdvance, onViewDetails, quotes }) {
  const [expanded, setExpanded] = useState(false)
  const colors = STAGE_COLORS[intake.status] || STAGE_COLORS.new
  const linkedQuote = quotes.find(q => q.intake_id === intake.id)
  const estimate = intake.estimate_min && intake.estimate_max
    ? `$${intake.estimate_min.toFixed(0)}-$${intake.estimate_max.toFixed(0)}`
    : null

  return (
    <div className={`bg-white border border-gray-200 rounded-xl overflow-hidden transition-all hover:shadow-md`}>
      {/* Header */}
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-semibold text-sm text-gray-900 truncate">{intake.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 capitalize shrink-0">
                {SERVICE_LABELS[intake.service_type] || intake.service_type}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-400">
              {intake.phone && (
                <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{intake.phone}</span>
              )}
              {intake.email && (
                <span className="flex items-center gap-1 truncate"><Mail className="w-3 h-3" />{intake.email}</span>
              )}
            </div>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors shrink-0"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {/* Key details row */}
        <div className="flex flex-wrap gap-2 mt-2">
          {intake.address && (
            <span className="flex items-center gap-1 text-[11px] text-gray-500 bg-gray-50 px-2 py-0.5 rounded-md">
              <MapPin className="w-3 h-3" />{intake.address.length > 30 ? intake.address.slice(0, 30) + '...' : intake.address}
            </span>
          )}
          {(intake.requested_date || intake.preferred_date) && (
            <span className="flex items-center gap-1 text-[11px] text-gray-500 bg-gray-50 px-2 py-0.5 rounded-md">
              <CalendarDays className="w-3 h-3" />{intake.requested_date || intake.preferred_date}
            </span>
          )}
          {estimate && (
            <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md">
              {estimate}
            </span>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3.5 pb-3 border-t border-gray-100 pt-2.5 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {intake.bedrooms && (
              <div className="flex items-center gap-1.5 text-gray-500">
                <Bed className="w-3.5 h-3.5 text-gray-400" /> {intake.bedrooms} bed
              </div>
            )}
            {intake.bathrooms && (
              <div className="flex items-center gap-1.5 text-gray-500">
                <Bath className="w-3.5 h-3.5 text-gray-400" /> {intake.bathrooms} bath
              </div>
            )}
            {intake.square_footage && (
              <div className="flex items-center gap-1.5 text-gray-500">
                <Ruler className="w-3.5 h-3.5 text-gray-400" /> {intake.square_footage} sq ft
              </div>
            )}
            {intake.guests && (
              <div className="flex items-center gap-1.5 text-gray-500">
                <Users className="w-3.5 h-3.5 text-gray-400" /> {intake.guests} guests
              </div>
            )}
            {intake.property_name && (
              <div className="flex items-center gap-1.5 text-gray-500 col-span-2">
                <Home className="w-3.5 h-3.5 text-gray-400" /> {intake.property_name}
              </div>
            )}
            {intake.frequency && (
              <div className="flex items-center gap-1.5 text-gray-500">
                <RefreshCw className="w-3.5 h-3.5 text-gray-400" /> {intake.frequency}
              </div>
            )}
          </div>
          {(intake.check_in || intake.check_out) && (
            <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-1.5">
              {intake.check_in && <span>Check-in: {intake.check_in.slice(0, 10)}</span>}
              {intake.check_in && intake.check_out && <span className="mx-1.5 text-gray-300">|</span>}
              {intake.check_out && <span>Check-out: {intake.check_out.slice(0, 10)}</span>}
            </div>
          )}
          {intake.message && (
            <div className="text-xs text-gray-500 italic bg-gray-50 rounded-lg px-2.5 py-1.5">
              "{intake.message}"
            </div>
          )}
          {linkedQuote && (
            <div className="text-xs bg-purple-50 text-purple-700 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              Quote {linkedQuote.quote_number} — ${parseFloat(linkedQuote.total || 0).toFixed(2)}
              <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full capitalize ${
                linkedQuote.status === 'accepted' ? 'bg-emerald-100 text-emerald-700' :
                linkedQuote.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                linkedQuote.status === 'declined' ? 'bg-red-100 text-red-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {linkedQuote.status}
              </span>
            </div>
          )}
          <div className="text-[10px] text-gray-400 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {new Date(intake.created_at).toLocaleDateString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit'
            })}
            {intake.source && <span className="ml-1.5 text-gray-400">via {intake.source}</span>}
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="px-3.5 py-2 bg-gray-50 border-t border-gray-100 flex gap-1.5">
        {intake.status === 'new' && (
          <>
            <button onClick={() => onAdvance(intake.id, 'reviewed')}
              className="flex-1 flex items-center justify-center gap-1 text-xs font-medium px-2.5 py-1.5 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded-lg transition-colors">
              <Eye className="w-3 h-3" /> Mark Reviewed
            </button>
            <button onClick={() => onViewDetails(intake, 'quote')}
              className="flex-1 flex items-center justify-center gap-1 text-xs font-medium px-2.5 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors">
              <Plus className="w-3 h-3" /> Create Quote
            </button>
          </>
        )}
        {intake.status === 'reviewed' && (
          <button onClick={() => onViewDetails(intake, 'quote')}
            className="flex-1 flex items-center justify-center gap-1 text-xs font-medium px-2.5 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors">
            <FileText className="w-3 h-3" /> Create Quote
          </button>
        )}
        {intake.status === 'quoted' && linkedQuote && linkedQuote.status === 'accepted' && (
          <button onClick={() => onViewDetails(intake, 'schedule')}
            className="flex-1 flex items-center justify-center gap-1 text-xs font-medium px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors">
            <Calendar className="w-3 h-3" /> Schedule Job
          </button>
        )}
        {intake.status === 'quoted' && linkedQuote && linkedQuote.status !== 'accepted' && (
          <span className="flex-1 text-center text-xs text-gray-400 py-1.5">Waiting for client response</span>
        )}
        {intake.status === 'converted' && (
          <span className="flex-1 text-center text-xs text-emerald-600 py-1.5 flex items-center justify-center gap-1">
            <CheckCircle className="w-3 h-3" /> Scheduled
          </span>
        )}
        {intake.client_id && (
          <button onClick={() => onViewDetails(intake, 'client')}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-white border border-gray-200 hover:bg-gray-100 text-gray-500 rounded-lg transition-colors">
            <Users className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  )
}


export default function Pipeline() {
  const navigate = useNavigate()
  const [intakes, setIntakes] = useState([])
  const [quotes, setQuotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [view, setView] = useState('board') // 'board' | 'list'

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500) }

  const loadData = async () => {
    try {
      const [intakeRes, quoteRes] = await Promise.all([
        get('/api/intake'),
        get('/api/quotes'),
      ])
      setIntakes(Array.isArray(intakeRes) ? intakeRes : [])
      setQuotes(Array.isArray(quoteRes) ? quoteRes : [])
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

  const handleAction = (intake, action) => {
    if (action === 'quote') {
      navigate('/quoting', { state: { intakeId: intake.id } })
    } else if (action === 'schedule') {
      const linkedQuote = quotes.find(q => q.intake_id === intake.id)
      if (linkedQuote) {
        convertToJob(linkedQuote.id)
      }
    } else if (action === 'client' && intake.client_id) {
      navigate(`/clients/${intake.client_id}`)
    }
  }

  const convertToJob = async (quoteId) => {
    try {
      await post(`/api/quotes/${quoteId}/convert-to-job`)
      showToast('Job created — set the date in Scheduling')
      await loadData()
    } catch { showToast('Error converting to job') }
  }

  const grouped = PIPELINE_STAGES.reduce((acc, stage) => {
    acc[stage.key] = intakes.filter(i => i.status === stage.key)
    return acc
  }, {})

  const totalNew = grouped.new?.length || 0

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
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-900">Website Pipeline</h1>
          {totalNew > 0 && (
            <span className="bg-amber-100 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-full">
              {totalNew} new
            </span>
          )}
          <span className="text-xs text-gray-400">maineclean.co requests</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button onClick={() => setView('board')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${view === 'board' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              Board
            </button>
            <button onClick={() => setView('list')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${view === 'list' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              List
            </button>
          </div>
          <button onClick={loadData}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

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
                  {/* Column header */}
                  <div className={`flex items-center gap-2 px-3 py-2.5 rounded-t-xl ${colors.bg} border ${colors.border} border-b-0`}>
                    <div className={`w-2 h-2 rounded-full ${colors.dot}`} />
                    <StageIcon className={`w-4 h-4 ${colors.header}`} />
                    <span className={`text-sm font-semibold ${colors.header}`}>{stage.label}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ml-auto ${colors.badge}`}>
                      {items.length}
                    </span>
                  </div>
                  {/* Column body */}
                  <div className={`flex-1 overflow-y-auto border ${colors.border} border-t-0 rounded-b-xl p-2 space-y-2 bg-gray-50/50`}>
                    {items.length === 0 && (
                      <div className="text-center py-8 text-gray-400 text-xs">
                        No requests
                      </div>
                    )}
                    {items.map(intake => (
                      <RequestCard
                        key={intake.id}
                        intake={intake}
                        quotes={quotes}
                        onAdvance={advanceStatus}
                        onViewDetails={handleAction}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* List view */}
      {view === 'list' && (
        <div className="flex-1 overflow-y-auto p-6">
          {intakes.length === 0 ? (
            <div className="text-center py-16">
              <Globe className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No website requests yet</p>
              <p className="text-xs text-gray-400 mt-1">Submissions from maineclean.co will appear here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {intakes.map(intake => {
                const colors = STAGE_COLORS[intake.status] || STAGE_COLORS.new
                const linkedQuote = quotes.find(q => q.intake_id === intake.id)
                return (
                  <div key={intake.id} className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-sm transition-all">
                    <div className="flex items-center gap-4">
                      <div className={`w-2.5 h-2.5 rounded-full ${colors.dot} shrink-0`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-0.5">
                          <span className="font-medium text-gray-900">{intake.name}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${colors.badge}`}>{intake.status}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 capitalize">
                            {SERVICE_LABELS[intake.service_type] || intake.service_type}
                          </span>
                          {linkedQuote && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-600">
                              {linkedQuote.quote_number} — ${parseFloat(linkedQuote.total || 0).toFixed(2)}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-400">
                          {intake.phone && <span>{intake.phone}</span>}
                          {intake.email && <span>{intake.email}</span>}
                          {intake.address && <span>{intake.address}</span>}
                          {(intake.requested_date || intake.preferred_date) && (
                            <span>Date: {intake.requested_date || intake.preferred_date}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {intake.status === 'new' && (
                          <>
                            <button onClick={() => advanceStatus(intake.id, 'reviewed')}
                              className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors">
                              Review
                            </button>
                            <button onClick={() => handleAction(intake, 'quote')}
                              className="text-xs px-3 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors">
                              Quote
                            </button>
                          </>
                        )}
                        {intake.status === 'reviewed' && (
                          <button onClick={() => handleAction(intake, 'quote')}
                            className="text-xs px-3 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors">
                            Create Quote
                          </button>
                        )}
                        {intake.status === 'quoted' && linkedQuote?.status === 'accepted' && (
                          <button onClick={() => handleAction(intake, 'schedule')}
                            className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors">
                            Schedule
                          </button>
                        )}
                        {intake.status === 'converted' && (
                          <span className="text-xs text-emerald-600 flex items-center gap-1 px-2 py-1.5">
                            <CheckCircle className="w-3.5 h-3.5" /> Done
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {toast && <Toast msg={toast} />}
    </div>
  )
}
