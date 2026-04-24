import { useState, useEffect, useMemo } from 'react'
import {
  MoreVertical, Plus, Search, FileText, Archive, AlertCircle,
  Home, Building2, Wind, Zap, Mail, Phone, MapPin, X
} from 'lucide-react'
import { get, post, patch } from '../api'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'

const SERVICE_TYPE_CONFIG = {
  residential: { label: 'Residential', badge: 'bg-blue-100 text-blue-700', icon: Home },
  commercial: { label: 'Commercial', badge: 'bg-purple-100 text-purple-700', icon: Building2 },
  str: { label: 'STR', badge: 'bg-amber-100 text-amber-700', icon: Wind },
}

const STATUS_CONFIG = {
  new: { label: 'New', badge: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
  reviewed: { label: 'Reviewed', badge: 'bg-gray-100 text-gray-700', dot: 'bg-gray-500' },
  quoted: { label: 'Quoted', badge: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  converted: { label: 'Converted', badge: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  archived: { label: 'Archived', badge: 'bg-neutral-100 text-neutral-700', dot: 'bg-neutral-400' },
}

const PRIORITY_CONFIG = {
  low: { label: 'Low', color: 'text-gray-500' },
  normal: { label: 'Normal', color: 'text-gray-600' },
  high: { label: 'High', color: 'text-amber-600' },
  urgent: { label: 'Urgent', color: 'text-red-600' },
}

const RequestCard = ({ intake, onViewDetails, onCreateQuote, onArchive }) => {
  const serviceConfig = SERVICE_TYPE_CONFIG[intake.service_type] || SERVICE_TYPE_CONFIG.residential
  const statusConfig = STATUS_CONFIG[intake.status] || STATUS_CONFIG.new
  const priorityConfig = PRIORITY_CONFIG[intake.priority] || PRIORITY_CONFIG.normal
  const ServiceIcon = serviceConfig.icon

  const [showMenu, setShowMenu] = useState(false)

  return (
    <div className="bg-white rounded-lg border border-neutral-200 p-4 hover:shadow-md transition-all">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Service Type Icon */}
          <div className={`p-2 rounded ${serviceConfig.badge}`}>
            <ServiceIcon className="w-4 h-4" />
          </div>

          <div className="flex-1 min-w-0">
            {/* Name + Status */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <h3 className="font-semibold text-neutral-900 truncate">{intake.name}</h3>
              <span className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${statusConfig.badge}`}>
                {statusConfig.label}
              </span>
            </div>

            {/* Contact + Priority */}
            <div className="space-y-1 mb-2">
              {intake.email && (
                <div className="flex items-center gap-1.5 text-xs text-neutral-600">
                  <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{intake.email}</span>
                </div>
              )}
              {intake.phone && (
                <div className="flex items-center gap-1.5 text-xs text-neutral-600">
                  <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{intake.phone}</span>
                </div>
              )}
              {intake.address && (
                <div className="flex items-center gap-1.5 text-xs text-neutral-600">
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{intake.address}</span>
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="flex items-center gap-3 text-xs text-neutral-500 flex-wrap">
              <span className={priorityConfig.color}>{priorityConfig.label} Priority</span>
              {intake.requested_date && <span>• {intake.requested_date}</span>}
              {intake.frequency && <span>• {intake.frequency}</span>}
            </div>
          </div>
        </div>

        {/* Menu Button */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-2 hover:bg-neutral-100 rounded transition-colors"
          >
            <MoreVertical className="w-4 h-4 text-neutral-500" />
          </button>

          {showMenu && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-neutral-200 rounded-lg shadow-lg z-10 w-48">
              <button
                onClick={() => {
                  onViewDetails(intake)
                  setShowMenu(false)
                }}
                className="w-full text-left px-4 py-2 text-sm text-neutral-900 hover:bg-neutral-50 first:rounded-t-lg"
              >
                View Details
              </button>
              <button
                onClick={() => {
                  onCreateQuote(intake)
                  setShowMenu(false)
                }}
                className="w-full text-left px-4 py-2 text-sm text-neutral-900 hover:bg-neutral-50 flex items-center gap-2"
              >
                <FileText className="w-4 h-4" />
                Create Quote
              </button>
              {intake.status !== 'archived' && (
                <button
                  onClick={() => {
                    onArchive(intake)
                    setShowMenu(false)
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-neutral-900 hover:bg-neutral-50 flex items-center gap-2 last:rounded-b-lg"
                >
                  <Archive className="w-4 h-4" />
                  Archive
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Message Preview */}
      {intake.message && (
        <p className="text-xs text-neutral-600 bg-neutral-50 p-2 rounded line-clamp-2">
          "{intake.message}"
        </p>
      )}
    </div>
  )
}

export default function Requests() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedStatus, setSelectedStatus] = useState('all')
  const [selectedServiceType, setSelectedServiceType] = useState('all')
  const [selectedPriority, setSelectedPriority] = useState('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedRequest, setSelectedRequest] = useState(null)
  const [showDetailsDrawer, setShowDetailsDrawer] = useState(false)

  // Load requests on mount and when filters change
  useEffect(() => {
    const loadRequests = async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        if (selectedStatus !== 'all') params.append('status', selectedStatus)
        if (selectedServiceType !== 'all') params.append('service_type', selectedServiceType)
        if (selectedPriority !== 'all') params.append('priority', selectedPriority)

        const res = await get(`/api/intake?${params.toString()}`)
        setRequests(res || [])
      } catch (err) {
        console.error('[Requests]', err)
      }
      setLoading(false)
    }

    loadRequests()
  }, [selectedStatus, selectedServiceType, selectedPriority])

  // Filter by search term
  const filteredRequests = useMemo(() => {
    return requests.filter(r => {
      const search = searchTerm.toLowerCase()
      return (
        r.name.toLowerCase().includes(search) ||
        r.email?.toLowerCase().includes(search) ||
        r.phone?.includes(search) ||
        r.address?.toLowerCase().includes(search)
      )
    })
  }, [requests, searchTerm])

  const handleViewDetails = (intake) => {
    setSelectedRequest(intake)
    setShowDetailsDrawer(true)
  }

  const handleCreateQuote = (intake) => {
    console.log('Create quote for:', intake.id)
    // TODO: Navigate to quote creation page with intake pre-filled
  }

  const handleArchive = async (intake) => {
    try {
      await patch(`/api/intake/${intake.id}`, { status: 'archived' })
      setRequests(requests.filter(r => r.id !== intake.id))
    } catch (err) {
      console.error('[Requests] Archive failed:', err)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-50">
      {/* Header */}
      <div className="bg-white border-b border-neutral-200 p-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-neutral-900">Requests</h1>
            <Button variant="primary" size="sm">
              <Plus className="w-4 h-4 mr-2" />
              New Request
            </Button>
          </div>

          {/* Search */}
          <div className="relative mb-4">
            <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by name, email, phone, or address..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-3 items-center">
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white"
            >
              <option value="all">All Statuses</option>
              <option value="new">New</option>
              <option value="reviewed">Reviewed</option>
              <option value="quoted">Quoted</option>
              <option value="converted">Converted</option>
              <option value="archived">Archived</option>
            </select>

            <select
              value={selectedServiceType}
              onChange={(e) => setSelectedServiceType(e.target.value)}
              className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white"
            >
              <option value="all">All Service Types</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="str">STR</option>
            </select>

            <select
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
              className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white"
            >
              <option value="all">All Priorities</option>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-4">
          {loading ? (
            <p className="text-center text-neutral-600">Loading requests...</p>
          ) : filteredRequests.length === 0 ? (
            <GlassCard>
              <div className="text-center py-12">
                <AlertCircle className="w-12 h-12 text-neutral-300 mx-auto mb-3" />
                <p className="text-neutral-600">
                  {requests.length === 0 ? 'No requests yet' : 'No requests match your filters'}
                </p>
              </div>
            </GlassCard>
          ) : (
            <div className="grid gap-3">
              {filteredRequests.map((intake) => (
                <RequestCard
                  key={intake.id}
                  intake={intake}
                  onViewDetails={handleViewDetails}
                  onCreateQuote={handleCreateQuote}
                  onArchive={handleArchive}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Details Drawer */}
      {showDetailsDrawer && selectedRequest && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 flex items-end sm:items-center sm:justify-center">
          <div className="w-full sm:w-full max-w-2xl bg-white rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden sm:max-h-[90vh] flex flex-col max-h-[95vh]">
            {/* Header */}
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 p-4 sm:p-6 text-white flex items-center justify-between">
              <div>
                <h2 className="text-xl sm:text-2xl font-bold">{selectedRequest.name}</h2>
                <p className="text-xs sm:text-sm text-blue-100">Request #{selectedRequest.id}</p>
              </div>
              <button
                onClick={() => setShowDetailsDrawer(false)}
                className="p-2 hover:bg-blue-400 rounded transition-colors -mr-2 sm:mr-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 p-4 sm:p-6 space-y-4">
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Email</label>
                <p className="text-sm text-neutral-900">{selectedRequest.email || '—'}</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Phone</label>
                <p className="text-sm text-neutral-900">{selectedRequest.phone || '—'}</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Address</label>
                <p className="text-sm text-neutral-900">
                  {selectedRequest.address || '—'} {selectedRequest.city ? `, ${selectedRequest.city}` : ''} {selectedRequest.state}
                </p>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Service Type</label>
                <p className="text-sm text-neutral-900">{SERVICE_TYPE_CONFIG[selectedRequest.service_type]?.label}</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Status</label>
                <p className="text-sm text-neutral-900">{STATUS_CONFIG[selectedRequest.status]?.label}</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Priority</label>
                <p className={`text-sm ${PRIORITY_CONFIG[selectedRequest.priority]?.color}`}>
                  {PRIORITY_CONFIG[selectedRequest.priority]?.label}
                </p>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase">Message</label>
                <p className="text-sm text-neutral-900 whitespace-pre-wrap">{selectedRequest.message || '—'}</p>
              </div>
              {selectedRequest.internal_notes && (
                <div>
                  <label className="text-xs font-semibold text-neutral-600 uppercase">Internal Notes</label>
                  <p className="text-sm text-neutral-900 whitespace-pre-wrap">{selectedRequest.internal_notes}</p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-neutral-200 bg-neutral-50 p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 justify-end sticky bottom-0">
              <Button variant="secondary" onClick={() => setShowDetailsDrawer(false)} className="w-full sm:w-auto">
                Close
              </Button>
              <Button variant="primary" className="w-full sm:w-auto flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Create Quote
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
