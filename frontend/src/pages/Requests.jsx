import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  MoreVertical, Plus, Search, FileText, Archive, AlertCircle,
  Home, Building2, Wind, Zap, Mail, Phone, MapPin, X, MessageSquare, Globe,
  Trash2, MessageCircle, Inbox, ChevronRight, Copy, UserPlus, ArrowUpRight,
} from 'lucide-react'
import { get, post, patch, del } from '../api'
import { displayContactName } from '../utils/display'
import { htmlToText, formatDate, formatDateTime } from '../utils/format'
import Button from '../components/ui/Button'
import GlassCard from '../components/ui/GlassCard'
import PageHero from '../components/ui/PageHero'
import { RequestThreadPanel } from '../components/requests/RequestThreadPanel'
import PropertyPhoto from '../components/PropertyPhoto'
import AiInsight from '../components/AiInsight'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'

// Twenty-style: neutral pills carry the label, the icon (type) or a small
// colored dot (status) carries the signal — so a list of leads isn't a wall of
// tinted rectangles. Only the pipeline STATUS keeps a dot of color.
const SERVICE_TYPE_CONFIG = {
  residential: { label: 'Residential', badge: 'bg-bg-2 text-ink-2', icon: Home },
  commercial: { label: 'Commercial', badge: 'bg-bg-2 text-ink-2', icon: Building2 },
  str: { label: 'STR', badge: 'bg-bg-2 text-ink-2', icon: Wind },
}

const STATUS_CONFIG = {
  new: { label: 'New', badge: 'bg-bg-2 text-ink-2', dot: 'bg-indigo-500' },
  reviewed: { label: 'Reviewed', badge: 'bg-bg-2 text-ink-2', dot: 'bg-ink-3' },
  quoted: { label: 'Quoted', badge: 'bg-bg-2 text-ink-2', dot: 'bg-amber-500' },
  converted: { label: 'Converted', badge: 'bg-bg-2 text-ink-2', dot: 'bg-emerald-500' },
  archived: { label: 'Archived', badge: 'bg-bg-2 text-ink-2', dot: 'bg-ink-3' },
}

// Friendly labels for the customer's preferred arrival window
// (custom_fields.arrival_window, forwarded from maineclean.co /book). Falls
// back to the raw value so an unknown window still renders something.
const ARRIVAL_WINDOW_LABELS = {
  morning: 'Morning (8am–12pm)',
  afternoon: 'Afternoon (12–4pm)',
  evening: 'Evening (4–7pm)',
  flexible: 'Flexible',
}

const PRIORITY_CONFIG = {
  low: { label: 'Low', color: 'text-ink-3' },
  normal: { label: 'Normal', color: 'text-ink-2' },
  high: { label: 'High', color: 'text-amber-600' },
  urgent: { label: 'Urgent', color: 'text-red-600' },
}

// Source chip on every Lead row — makes it obvious whether a lead came
// in via the website form, an SMS, or an email reply.
const SOURCE_CONFIG = {
  website: { label: 'Website', icon: Globe,         badge: 'bg-bg-2 text-ink-3' },
  sms:     { label: 'SMS',     icon: Phone,         badge: 'bg-bg-2 text-ink-3' },
  email:   { label: 'Email',   icon: Mail,          badge: 'bg-bg-2 text-ink-3' },
  chat:    { label: 'Chat',    icon: MessageSquare, badge: 'bg-bg-2 text-ink-3' },
}

// The customer's ACTUAL service pick + the two pricing inputs (condition, pet
// hair) that the website quote engine uses. A Deep Clean with pets is bucketed
// to canonical "Residential", so without these the estimate looks unexplained.
const REQUESTED_SERVICE_LABELS = {
  standard: 'Standard clean', residential: 'Standard clean',
  deep: 'Deep clean', 'deep-clean': 'Deep clean', deep_clean: 'Deep clean',
  'move-in-out': 'Move-in / move-out', 'move-in': 'Move-in / move-out',
  'move-out': 'Move-in / move-out', move_in_out: 'Move-in / move-out',
  str: 'STR turnover', 'vacation-rental': 'STR turnover', airbnb: 'STR turnover',
  commercial: 'Commercial',
}
const CONDITION_LABELS = { maintenance: 'Well-maintained', moderate: 'Moderate build-up', heavy: 'Heavy / needs work' }
const PET_LABELS = { none: 'No pet hair', some: 'Some pet hair', heavy: 'Heavy pet hair' }
const requestedServiceLabel = (k) => REQUESTED_SERVICE_LABELS[(k || '').toLowerCase()] || null
const conditionLabel = (k) => k ? (CONDITION_LABELS[(k || '').toLowerCase()] || k) : null
const petLabel = (k) => (k && k.toLowerCase() !== 'none') ? (PET_LABELS[(k || '').toLowerCase()] || `${k} pet hair`) : null
// The pricing factors that aren't already obvious from the service icon —
// shown so the estimate explains itself. Returns [] when nothing noteworthy.
const pricingFactors = (o) => {
  const out = []
  const sv = requestedServiceLabel(o.requested_service)
  // Only surface the variant when it's more specific than a plain standard clean.
  if (sv && sv !== 'Standard clean') out.push(sv)
  const c = conditionLabel(o.condition)
  if (c && (o.condition || '').toLowerCase() !== 'maintenance') out.push(c)
  const p = petLabel(o.pet_hair)
  if (p) out.push(p)
  return out
}
// Estimate range → display text. Both bounds → "$130–$150"; only one bound
// (partial data from an old lead or a merge) → "~$150", never the broken
// "$?–$150" the old inline `?? '?'` template produced; both missing → null
// so the caller can fall back to "Custom quote" (STR/commercial) or "—".
const estimateText = (min, max) => {
  if (min != null && max != null) return `$${Math.round(min)}–$${Math.round(max)}`
  const only = max ?? min
  return only != null ? `~$${Math.round(only)}` : null
}

// True when a stored message is only a broken estimate placeholder — the
// "Estimate: $?–$?" / "$undefined–$undefined" strings older leads baked in
// before custom-quote services stopped fabricating a number. Nothing for the
// operator to read, so the card hides it.
const isJunkMessage = (msg) => {
  const t = (msg || '').replace(/<[^>]*>/g, '').trim().toLowerCase()
  if (!t) return false
  return /^(estimate:\s*)?\$?\s*(\?|undefined)\s*[-–—]\s*\$?\s*(\?|undefined)$/.test(t)
}

// Normalizers shared with the backend's name+address dedup so the page flags
// the SAME pairs the server would auto-merge in-window (and the older ones it
// deliberately leaves for manual review).
const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
const normAddr = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
function SourceChip({ source }) {
  const cfg = SOURCE_CONFIG[source] || SOURCE_CONFIG.website
  const Ic = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${cfg.badge}`}>
      <Ic className="w-3 h-3" /> {cfg.label}
    </span>
  )
}

const RequestCard = ({ intake, onViewDetails, onCreateQuote, onConvertToClient, onArchive, onDelete, selected, onToggleSelect }) => {
  const serviceConfig = SERVICE_TYPE_CONFIG[intake.service_type] || SERVICE_TYPE_CONFIG.residential
  // Prefer the backend-derived display_status (surfaces "converted", which the
  // stored status never reaches) and fall back to the raw status for older
  // payloads. Actions/filters still key off the stored status.
  const displayStatus = intake.display_status || intake.status
  const statusConfig = STATUS_CONFIG[displayStatus] || STATUS_CONFIG.new
  const priorityConfig = PRIORITY_CONFIG[intake.priority] || PRIORITY_CONFIG.normal
  const ServiceIcon = serviceConfig.icon

  const [showMenu, setShowMenu] = useState(false)

  return (
    <div className={`bg-panel rounded-lg border px-4 py-2.5 hover:bg-bg-2/60 transition-colors ${selected ? 'border-indigo-400 bg-indigo-50/30' : 'border-hairline'}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Bulk-select checkbox */}
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect?.(intake.id)}
            onClick={e => e.stopPropagation()}
            className="mt-2.5 w-3.5 h-3.5 rounded border-hairline cursor-pointer shrink-0"
            aria-label="Select lead"
          />
          {/* Service Type Icon */}
          <div className={`p-2 rounded ${serviceConfig.badge}`}>
            <ServiceIcon className="w-4 h-4" />
          </div>

          <div className="flex-1 min-w-0">
            {/* Name + Source + Status */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <h3 className="font-semibold text-ink truncate">{displayContactName(intake)}</h3>
              <SourceChip source={intake.source || 'website'} />
              <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 whitespace-nowrap">
                <span className={`h-1.5 w-1.5 rounded-full ${statusConfig.dot}`} />
                {statusConfig.label}
              </span>
              {/* Read-receipt: the customer opened the quote we sent for this
                  request. Only meaningful pre-conversion (a converted lead is
                  already won). */}
              {intake.quote_viewed_at && displayStatus !== 'converted' && (
                <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 whitespace-nowrap"
                  title={`Customer opened the quote on ${new Date(intake.quote_viewed_at).toLocaleString()}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" /> Quote opened
                </span>
              )}
              {/* Shares a name or address with another lead — the operator
                  can merge/archive from here. Same signal the backend uses to
                  auto-merge in-window; older matches surface here instead. */}
              {intake._possibleDuplicate && (
                <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2 whitespace-nowrap"
                  title="Shares a name or address with another lead — check for a duplicate">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" /> Possible duplicate
                </span>
              )}
            </div>

            {/* Contact + Priority */}
            <div className="space-y-1 mb-2">
              {intake.email && (
                <div className="flex items-center gap-1.5 text-xs text-ink-2">
                  <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{intake.email}</span>
                </div>
              )}
              {intake.phone && (
                <div className="flex items-center gap-1.5 text-xs text-ink-2">
                  <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{intake.phone}</span>
                </div>
              )}
              {intake.address && (
                <div className="flex items-center gap-1.5 text-xs text-ink-2">
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{intake.address}</span>
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="flex items-center gap-3 text-xs text-ink-3 flex-wrap">
              <span className={priorityConfig.color}>{priorityConfig.label} Priority</span>
              {intake.requested_date && <span>• {formatDate(intake.requested_date)}</span>}
              {intake.frequency && <span>• {intake.frequency}</span>}
              {estimateText(intake.estimate_min, intake.estimate_max) ? (
                <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {estimateText(intake.estimate_min, intake.estimate_max)}
                </span>
              ) : ['str', 'commercial'].includes(intake.service_type) ? (
                // STR / commercial are quoted by hand — the site shows no
                // instant number, so make the blank estimate read as
                // intentional rather than missing data.
                <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                  Custom quote
                </span>
              ) : (
                <span>—</span>
              )}
            </div>

            {/* Property specs — the inputs that DRIVE the estimate (sqft,
                bedrooms, bathrooms, guests). These land in the DB from the
                website form but used to render nowhere on this page, so an
                operator couldn't sanity-check the quote against the home
                size. Only shown when at least one value is present. */}
            {(intake.square_footage || intake.bedrooms || intake.bathrooms || intake.guests) && (
              <div className="flex items-center gap-3 text-xs text-ink-3 flex-wrap mt-1.5">
                {intake.square_footage ? <span>{intake.square_footage.toLocaleString()} sq ft</span> : null}
                {intake.bedrooms ? <span>• {intake.bedrooms} bd</span> : null}
                {intake.bathrooms ? <span>• {intake.bathrooms} ba</span> : null}
                {intake.guests ? <span>• {intake.guests} guests</span> : null}
              </div>
            )}

            {/* Pricing factors — the customer's service pick + condition + pet
                hair that push the estimate up. Without these a Deep Clean with
                pets reads as a plain "Residential" job with an unexplained price. */}
            {pricingFactors(intake).length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                {pricingFactors(intake).map((f, idx) => (
                  <span key={idx} className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-medium">
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Street View thumbnail of the property. Lazy — only fetches when the
            card scrolls into view (each is a paid Google call) — and collapses
            when there's no imagery, so cards without a photo look unchanged. */}
        <PropertyPhoto
          lazy
          address={[intake.address, intake.city, intake.state, intake.zip_code].filter(Boolean).join(', ')}
          className="hidden sm:block w-20 h-14 object-cover rounded-md border border-hairline bg-bg-2 shrink-0"
        />

        {/* Menu Button */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-2 hover:bg-bg-2 rounded transition-colors"
          >
            <MoreVertical className="w-4 h-4 text-ink-3" />
          </button>

          {showMenu && (
            <div className="absolute right-0 top-full mt-1 bg-panel border border-hairline rounded-lg shadow-lg z-10 w-48">
              <button
                onClick={() => {
                  onViewDetails(intake)
                  setShowMenu(false)
                }}
                className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-bg first:rounded-t-lg"
              >
                View Details
              </button>
              <button
                onClick={() => {
                  onCreateQuote(intake)
                  setShowMenu(false)
                }}
                className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-bg flex items-center gap-2"
              >
                <FileText className="w-4 h-4" />
                Create Quote
              </button>
              <button
                onClick={() => {
                  onConvertToClient(intake)
                  setShowMenu(false)
                }}
                className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-bg flex items-center gap-2"
              >
                <UserPlus className="w-4 h-4" />
                Convert to client
              </button>
              {intake.status !== 'archived' && (
                <button
                  onClick={() => {
                    onArchive(intake)
                    setShowMenu(false)
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-bg flex items-center gap-2"
                >
                  <Archive className="w-4 h-4" />
                  Archive
                </button>
              )}
              <button
                onClick={() => {
                  onDelete(intake)
                  setShowMenu(false)
                }}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 last:rounded-b-lg"
              >
                <Trash2 className="w-4 h-4" />
                Delete permanently
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Message Preview — skip a message that's only a broken estimate
          string ("Estimate: $?–$?", "$undefined–$undefined") baked into
          older rows before the custom-quote fixes; rendering it just
          confuses the operator. */}
      {intake.message && !isJunkMessage(intake.message) && (
        <p className="text-xs text-ink-2 bg-bg p-2 rounded line-clamp-2">
          "{htmlToText(intake.message)}"
        </p>
      )}

      {/* /book "essentials" — surfaced from LeadIntake.custom_fields.
          Only rendered if any of the six on-site fields came in, so a
          contact-form lead doesn't grow an empty block. */}
      {intake.custom_fields && (
        intake.custom_fields.entry_method
        || intake.custom_fields.parking_notes
        || intake.custom_fields.pets_detail
        || (intake.custom_fields.focus_areas && intake.custom_fields.focus_areas.length)
        || intake.custom_fields.special_instructions
        || intake.custom_fields.listing_url
        || intake.custom_fields.turnover_day
        || intake.custom_fields.pets_allowed
        || intake.custom_fields.arrival_window
        || (Array.isArray(intake.custom_fields.photos) && intake.custom_fields.photos.length)
      ) && (
        <div className="text-[11px] text-ink-2 bg-blue-50 border border-blue-200 rounded p-2 space-y-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 mb-1">Booking essentials</div>
          {intake.custom_fields.arrival_window && (
            <div><span className="text-ink-3">Arrival:</span> {ARRIVAL_WINDOW_LABELS[intake.custom_fields.arrival_window] || intake.custom_fields.arrival_window}</div>
          )}
          {intake.custom_fields.listing_url && (
            <div><span className="text-ink-3">Listing:</span>{' '}
              <a href={intake.custom_fields.listing_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline break-all">
                {intake.custom_fields.listing_url}
              </a>
            </div>
          )}
          {intake.custom_fields.turnover_day && (
            <div><span className="text-ink-3">Turnover day:</span> {intake.custom_fields.turnover_day}</div>
          )}
          {intake.custom_fields.pets_allowed && (
            <div><span className="text-ink-3">Pets allowed:</span> {intake.custom_fields.pets_allowed}</div>
          )}
          {intake.custom_fields.entry_method && (
            <div><span className="text-ink-3">Entry:</span> {intake.custom_fields.entry_method.replace('-', ' ')}</div>
          )}
          {intake.custom_fields.parking_notes && (
            <div><span className="text-ink-3">Parking:</span> {intake.custom_fields.parking_notes}</div>
          )}
          {intake.custom_fields.pets_detail && (
            <div><span className="text-ink-3">Pets:</span> {intake.custom_fields.pets_detail}</div>
          )}
          {intake.custom_fields.focus_areas && intake.custom_fields.focus_areas.length > 0 && (
            <div><span className="text-ink-3">Focus:</span> {intake.custom_fields.focus_areas.join(', ')}</div>
          )}
          {intake.custom_fields.special_instructions && (
            <div className="line-clamp-2"><span className="text-ink-3">Notes:</span> {intake.custom_fields.special_instructions}</div>
          )}
          {/* Customer-attached photos (custom_fields.photos, inline data URIs).
              Up to 3 thumbnails; click opens the full image in a new tab. */}
          {Array.isArray(intake.custom_fields.photos) && intake.custom_fields.photos.length > 0 && (
            <div>
              <span className="text-ink-3">Photos ({intake.custom_fields.photos.length}):</span>
              <div className="flex gap-1.5 mt-1">
                {intake.custom_fields.photos.slice(0, 3).map((src, i) => (
                  <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                    <img src={src} alt={`Attachment ${i + 1}`}
                      className="w-16 h-16 object-cover rounded border border-blue-200" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}



export default function Requests() {
  const navigate = useNavigate()
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedStatus, setSelectedStatus] = useState('all')
  const [selectedServiceType, setSelectedServiceType] = useState('all')
  const [selectedPriority, setSelectedPriority] = useState('all')
  const [searchTerm, setSearchTerm] = useState('')
  // "Possible duplicates" view — leads sharing a name or address with another
  // lead (but not already collapsed by contact). Lets the operator bulk-select
  // and archive the leftover cruft the auto-merge can't safely collapse.
  const [showDuplicatesOnly, setShowDuplicatesOnly] = useState(false)
  const [selectedRequest, setSelectedRequest] = useState(null)
  const [showDetailsDrawer, setShowDetailsDrawer] = useState(false)
  const [drawerTab, setDrawerTab] = useState('details') // 'details' | 'conversation'
  const [selectedIntakes, setSelectedIntakes] = useState(() => new Set()) // bulk-archive selection
  const [bulkArchiving, setBulkArchiving] = useState(false)
  const [showNewRequestModal, setShowNewRequestModal] = useState(false)
  const [creatingRequest, setCreatingRequest] = useState(false)
  const [newRequestForm, setNewRequestForm] = useState({
    name: '', phone: '', email: '', address: '', service_type: 'residential', message: '',
  })
  // ?new=1 (page assistant "Log a lead" quick action) opens the new-request
  // modal, then strips the flag so a refresh doesn't reopen it.
  const [reqParams, setReqParams] = useSearchParams()
  useEffect(() => {
    if (reqParams.get('new')) {
      setShowNewRequestModal(true)
      const next = new URLSearchParams(reqParams)
      next.delete('new')
      setReqParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqParams])

  // Requests is real service leads only — website booking-form submissions and
  // quote requests. Raw email/SMS conversations (vendor pitches, "thanks!"
  // texts, sales outreach) belong in Comms, not here, so they no longer get
  // merged into this feed.
  const loadRequests = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedStatus !== 'all') params.append('status', selectedStatus)
      if (selectedServiceType !== 'all') params.append('service_type', selectedServiceType)
      if (selectedPriority !== 'all') params.append('priority', selectedPriority)

      const intakes = await get(`/api/intake?${params.toString()}`).catch(() => [])
      setRequests(Array.isArray(intakes) ? intakes : [])
    } catch (err) {
      console.error('[Requests]', err)
    }
    setLoading(false)
  }

  useEffect(() => {
    loadRequests()
  }, [selectedStatus, selectedServiceType, selectedPriority])

  const handleCreateRequest = async () => {
    if (!newRequestForm.name.trim()) return
    setCreatingRequest(true)
    try {
      const created = await post('/api/intake', {
        name: newRequestForm.name.trim(),
        phone: newRequestForm.phone.trim() || null,
        email: newRequestForm.email.trim() || null,
        address: newRequestForm.address.trim() || null,
        service_type: newRequestForm.service_type,
        message: newRequestForm.message.trim() || null,
      })
      setShowNewRequestModal(false)
      setNewRequestForm({ name: '', phone: '', email: '', address: '', service_type: 'residential', message: '' })
      await loadRequests()
      if (created?.id) handleViewDetails(created)
    } catch (err) {
      console.error('[Requests] Create failed:', err)
      alert('Could not create the request. Check the details and try again.')
    }
    setCreatingRequest(false)
  }

  // De-duplicate then search. The same person can submit the booking form
  // twice (two near-identical leads); collapse by normalized email+phone and
  // keep the most recent, so the list reflects people, not raw submissions.
  const feed = useMemo(() => {
    const keyOf = (r) => {
      const email = (r.email || '').trim().toLowerCase()
      const phone = (r.phone || '').replace(/\D/g, '')
      return (email || phone) ? `${email}|${phone}` : `id-${r.id}`
    }
    const byKey = new Map()
    for (const r of requests) {
      const k = keyOf(r)
      const existing = byKey.get(k)
      // Keep the most recent submission for each person.
      if (!existing || (r.created_at || '') > (existing.created_at || '')) byKey.set(k, r)
    }
    let items = Array.from(byKey.values())
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

    // Flag possible duplicates: after the contact-collapse above, any lead
    // that still shares a normalized NAME or ADDRESS with another card is a
    // likely dup the auto-merge couldn't safely collapse (different contact,
    // or older than the merge window). Count only non-trivial keys so blank
    // addresses / one-word names don't group half the page together.
    const nameCounts = new Map()
    const addrCounts = new Map()
    for (const r of items) {
      const n = normName(r.name)
      const a = normAddr(r.address)
      if (n) nameCounts.set(n, (nameCounts.get(n) || 0) + 1)
      if (a) addrCounts.set(a, (addrCounts.get(a) || 0) + 1)
    }
    const dupIds = new Set()
    for (const r of items) {
      const n = normName(r.name)
      const a = normAddr(r.address)
      if ((n && nameCounts.get(n) > 1) || (a && addrCounts.get(a) > 1)) dupIds.add(r.id)
    }
    items.forEach(r => { r._possibleDuplicate = dupIds.has(r.id) })

    if (showDuplicatesOnly) items = items.filter(r => r._possibleDuplicate)

    if (!searchTerm.trim()) return items
    const q = searchTerm.toLowerCase()
    return items.filter(r => (
      r.name?.toLowerCase().includes(q) ||
      r.email?.toLowerCase().includes(q) ||
      r.phone?.includes(q) ||
      r.address?.toLowerCase().includes(q)
    ))
  }, [requests, searchTerm, showDuplicatesOnly])

  // Count of possible-duplicate cards regardless of the current toggle, for
  // the filter button's badge. Cheap (runs over the same collapsed list).
  const duplicateCount = useMemo(() => {
    const nameCounts = new Map(); const addrCounts = new Map()
    const byKey = new Map()
    const keyOf = (r) => {
      const email = (r.email || '').trim().toLowerCase()
      const phone = (r.phone || '').replace(/\D/g, '')
      return (email || phone) ? `${email}|${phone}` : `id-${r.id}`
    }
    for (const r of requests) {
      const k = keyOf(r); const ex = byKey.get(k)
      if (!ex || (r.created_at || '') > (ex.created_at || '')) byKey.set(k, r)
    }
    const items = Array.from(byKey.values())
    for (const r of items) {
      const n = normName(r.name); const a = normAddr(r.address)
      if (n) nameCounts.set(n, (nameCounts.get(n) || 0) + 1)
      if (a) addrCounts.set(a, (addrCounts.get(a) || 0) + 1)
    }
    return items.filter(r => {
      const n = normName(r.name); const a = normAddr(r.address)
      return (n && nameCounts.get(n) > 1) || (a && addrCounts.get(a) > 1)
    }).length
  }, [requests])

  const handleViewDetails = (intake) => {
    setSelectedRequest(intake)
    setDrawerTab('details')
    setShowDetailsDrawer(true)
  }

  const handleCreateQuote = (intake) => {
    // Hand off to /quoting with the intake attached. Quoting picks it up
    // via location.state and opens the new-quote form pre-filled with the
    // intake's contact, address, and message. Backend already transitions
    // lead_intake.status → 'quoted' when the quote is created with
    // intake_id, and → 'converted' when that quote becomes a job.
    navigate('/billing?view=quotes', { state: { openNewFromIntake: intake } })
  }

  // Twenty-style "convert lead → contact": promote a request to a Client
  // WITHOUT a quote. Inbound requests are an inbox and never auto-create a
  // client, so this (and Create Quote) are the explicit conversion actions.
  // The backend dedups — a returning customer links to their existing client
  // instead of spawning a duplicate.
  const handleConvertToClient = async (intake) => {
    try {
      const res = await post(`/api/intake/${intake.id}/convert-to-client`, {})
      const patchRow = (r) => r.id === intake.id
        ? { ...r, status: r.status === 'new' ? 'reviewed' : r.status, client_id: res.client_id }
        : r
      setRequests(prev => prev.map(patchRow))
      setSelectedRequest(prev => (prev && prev.id === intake.id ? patchRow(prev) : prev))
      toast.success(res.matched_existing ? 'Linked to existing client' : 'Client created from request')
      if (res.client_id) navigate(`/clients/${res.client_id}`)
    } catch (err) {
      console.error('[Requests] Convert to client failed:', err)
      toast.error('Convert to client failed. See console for details.')
    }
  }

  const handleArchive = async (intake) => {
    try {
      await patch(`/api/intake/${intake.id}`, { status: 'archived' })
      setRequests(requests.filter(r => r.id !== intake.id))
    } catch (err) {
      console.error('[Requests] Archive failed:', err)
    }
  }

  // Permanent delete — separate from Archive so accidental clicks don't
  // wipe rows. Backend already exposes DELETE /api/intake/{id} (admin +
  // manager only). Confirm with the request name/id so the operator can
  // eyeball what they're removing.
  const handleDelete = async (intake) => {
    const label = intake.name || intake.email || intake.phone || `Request #${intake.id}`
    if (!(await confirmDialog(`Permanently delete "${label}"? This can't be undone — Archive keeps it in the "Archived" filter instead.`, { confirmLabel: 'Delete', danger: true }))) return
    try {
      await del(`/api/intake/${intake.id}`)
      setRequests(prev => prev.filter(r => r.id !== intake.id))
      // Drop it from the bulk-select set too — otherwise a stale id lingers
      // in `selectedIntakes` (now invisible, since it's gone from `requests`)
      // and a later "Archive N selected" click PATCHes a deleted row and
      // reports a spurious failure (Codex review on #530).
      setSelectedIntakes(prev => {
        if (!prev.has(intake.id)) return prev
        const next = new Set(prev)
        next.delete(intake.id)
        return next
      })
      if (selectedRequest?.id === intake.id) {
        setShowDetailsDrawer(false)
        setSelectedRequest(null)
      }
    } catch (err) {
      console.error('[Requests] Delete failed:', err)
      toast.error('Delete failed. See console for details.')
    }
  }

  // Switches the drawer to its inline Conversation tab (RequestThreadPanel)
  // so the operator can read/reply without leaving the Requests page. The
  // panel itself still has a "Full inbox" link out to /comms?q=... for the
  // assign/priority/status controls that only make sense in the full inbox.
  const openConversation = () => setDrawerTab('conversation')

  const toggleSelectIntake = (id) => {
    setSelectedIntakes(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const clearIntakeSelection = () => setSelectedIntakes(new Set())
  const bulkArchive = async () => {
    const ids = Array.from(selectedIntakes)
    if (ids.length === 0) return
    if (!(await confirmDialog(`Archive ${ids.length} lead${ids.length === 1 ? '' : 's'}? You can still find them under the Archived filter.`, { confirmLabel: 'Archive' }))) return
    setBulkArchiving(true)
    try {
      const results = await Promise.allSettled(
        ids.map(id => patch(`/api/intake/${id}`, { status: 'archived' }))
      )
      const failed = results.filter(r => r.status === 'rejected').length
      const archived = new Set(ids.filter((_, i) => results[i].status === 'fulfilled'))
      setRequests(requests.filter(r => !archived.has(r.id)))
      clearIntakeSelection()
      if (failed > 0) toast.error(`Archived ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
    } finally {
      setBulkArchiving(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-4">
        <PageHero
          title="Requests"
          subtitle="Manually add a lead, or triage what's come in from the website"
          icon={Inbox}
          pods={[
            { label: 'All', value: requests.length },
            { label: 'New', value: requests.filter(r => (r.display_status || r.status) === 'new').length, tone: 'text-amber-300' },
            { label: 'Reviewed', value: requests.filter(r => (r.display_status || r.status) === 'reviewed').length },
            { label: 'Quoted', value: requests.filter(r => (r.display_status || r.status) === 'quoted').length, tone: 'text-indigo-200' },
          ]}
          actions={
            <button onClick={() => setShowNewRequestModal(true)}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-md text-xs font-medium transition-colors">
              <Plus className="w-4 h-4" /> New Request
            </button>
          }
        >
          {/* Search */}
          <div className="relative mb-4">
            <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by name, email, phone, or address..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-hairline rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
            />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-3 items-center">
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="px-3 py-2 border border-hairline rounded-lg text-sm bg-panel"
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
              className="px-3 py-2 border border-hairline rounded-lg text-sm bg-panel"
            >
              <option value="all">All Service Types</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="str">STR</option>
            </select>

            <select
              value={selectedPriority}
              onChange={(e) => setSelectedPriority(e.target.value)}
              className="px-3 py-2 border border-hairline rounded-lg text-sm bg-panel"
            >
              <option value="all">All Priorities</option>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>

            {/* Possible-duplicates filter — only appears when there's actually
                something to triage. Toggling it narrows the list to leads that
                share a name/address so they can be bulk-selected and archived. */}
            {duplicateCount > 0 && (
              <button
                onClick={() => setShowDuplicatesOnly(v => !v)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors ${
                  showDuplicatesOnly
                    ? 'bg-amber-100 border-amber-300 text-amber-800'
                    : 'bg-panel border-hairline text-ink-2 hover:bg-bg-2'
                }`}
                title="Show only leads that share a name or address with another lead"
              >
                <Copy className="w-3.5 h-3.5" />
                {showDuplicatesOnly ? 'Showing duplicates' : `Possible duplicates (${duplicateCount})`}
              </button>
            )}
          </div>
        </PageHero>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-4">
          {selectedIntakes.size > 0 && (
            <div className="flex items-center justify-between gap-3 mb-3 bg-panel border border-hairline rounded-lg px-3 py-2 sticky top-0 z-10">
              <span className="text-[12px] text-ink-2 font-medium">{selectedIntakes.size} selected</span>
              <div className="flex items-center gap-2">
                <button onClick={clearIntakeSelection}
                  className="text-[12px] text-ink-3 hover:text-ink-2 px-2 py-1 rounded">Clear</button>
                <button onClick={bulkArchive} disabled={bulkArchiving}
                  className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-3 border border-hairline text-ink-2 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50">
                  <Archive className="w-3.5 h-3.5" />
                  {bulkArchiving ? 'Archiving...' : `Archive ${selectedIntakes.size}`}
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <p className="text-center text-ink-2">Loading leads...</p>
          ) : feed.length === 0 ? (
            <GlassCard>
              <div className="text-center py-12">
                <AlertCircle className="w-12 h-12 text-ink-3 mx-auto mb-3" />
                <p className="text-ink-2">
                  {requests.length === 0 ? 'No leads yet' : 'No leads match your filters'}
                </p>
              </div>
            </GlassCard>
          ) : (
            <div className="grid gap-3">
              {feed.map(data => (
                <RequestCard
                  key={`intake-${data.id}`}
                  intake={data}
                  onViewDetails={handleViewDetails}
                  onCreateQuote={handleCreateQuote}
                  onConvertToClient={handleConvertToClient}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                  selected={selectedIntakes.has(data.id)}
                  onToggleSelect={toggleSelectIntake}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Details Drawer */}
      {showDetailsDrawer && selectedRequest && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 flex items-end sm:items-center sm:justify-center">
          <div className="w-full sm:w-full max-w-2xl bg-panel rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden sm:max-h-[90vh] flex flex-col max-h-[95vh]">
            {/* Header */}
            <div className="bg-panel border-b border-hairline p-4 sm:p-6 text-ink flex items-center justify-between">
              <div>
                <h2 className="text-xl sm:text-2xl font-bold">{selectedRequest.name}</h2>
                <p className="text-xs sm:text-sm text-ink-3">Request #{selectedRequest.id}</p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => navigate(`/requests/${selectedRequest.id}`)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-bg-2 rounded-lg transition-colors"
                  title="Open the full request page"
                >
                  <ArrowUpRight className="w-4 h-4" /> Open full view
                </button>
                <button
                  onClick={() => setShowDetailsDrawer(false)}
                  className="p-2 hover:bg-bg-2 text-ink-3 rounded transition-colors -mr-2 sm:mr-0"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Tab strip: Details (existing read-only fields) vs. Conversation
                (inline two-way thread — RequestThreadPanel). Kept as two
                fully separate bodies rather than showing both, so the
                thread panel gets real vertical space to scroll + compose
                in instead of being squeezed under the details fields. */}
            <div className="flex items-center gap-1 px-4 sm:px-6 pt-3 border-b border-hairline bg-panel shrink-0">
              {[
                { key: 'details', label: 'Details' },
                { key: 'conversation', label: 'Conversation' },
              ].map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setDrawerTab(tab.key)}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    drawerTab === tab.key
                      ? 'border-indigo-600 text-indigo-600'
                      : 'border-transparent text-ink-3 hover:text-ink-2'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Body */}
            {drawerTab === 'conversation' ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <RequestThreadPanel intake={selectedRequest} />
              </div>
            ) : (
            <div className="overflow-y-auto flex-1 p-4 sm:p-6 space-y-4">
              {/* AI-enriched gist of the lead: what they want + the next step. */}
              <AiInsight type="lead" id={selectedRequest.id} />
              {/* Front-of-house Street View photo of the service address — the
                  same one the customer sees on their quote. Hides itself when
                  photos are off or Google has no imagery. */}
              <PropertyPhoto
                address={[selectedRequest.address, selectedRequest.city, selectedRequest.state, selectedRequest.zip_code].filter(Boolean).join(', ')}
                className="w-full h-44 sm:h-52 object-cover rounded-xl border border-hairline"
              />
              {/* Quick contact row: one-tap Call / Text / Email / Open thread
                  so the operator can dig into questions before quoting
                  without leaving this page. `tel:` and `sms:` both open the
                  OS handler (native dialer / iMessage / etc.); Open Thread
                  switches to the Conversation tab above for a two-way
                  in-app reply instead of leaving the page. */}
              {(selectedRequest.email || selectedRequest.phone) && (
                <div className="flex flex-wrap gap-2">
                  {selectedRequest.phone && (
                    <a
                      href={`tel:${selectedRequest.phone}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                    >
                      <Phone className="w-3.5 h-3.5" /> Call
                    </a>
                  )}
                  {selectedRequest.phone && (
                    <a
                      href={`sms:${selectedRequest.phone}?body=${encodeURIComponent(`Hi ${selectedRequest.name || ''} — following up on your cleaning request.`)}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                    >
                      <MessageCircle className="w-3.5 h-3.5" /> Text
                    </a>
                  )}
                  {selectedRequest.email && (
                    <a
                      href={`mailto:${selectedRequest.email}?subject=${encodeURIComponent('Your cleaning request')}&body=${encodeURIComponent(`Hi ${selectedRequest.name || ''},\n\nThanks for reaching out — I wanted to follow up on your request before sending a quote.\n\n`)}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100"
                    >
                      <Mail className="w-3.5 h-3.5" /> Email
                    </a>
                  )}
                  <button
                    onClick={() => openConversation(selectedRequest)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                  >
                    <MessageSquare className="w-3.5 h-3.5" /> Open thread
                  </button>
                </div>
              )}
              {/* Once this lead has become a quote, link straight to it so a
                  quoted/converted request isn't a dead end. */}
              {selectedRequest.converted_quote_id && (
                <button
                  onClick={() => navigate(`/quotes/${selectedRequest.converted_quote_id}`)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800"
                >
                  <span className="flex items-center gap-1.5"><FileText className="w-4 h-4" /> View the quote this became</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Email</label>
                <p className="text-sm text-ink">
                  {selectedRequest.email ? (
                    <a href={`mailto:${selectedRequest.email}`} className="text-indigo-600 hover:underline">
                      {selectedRequest.email}
                    </a>
                  ) : '—'}
                </p>
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Phone</label>
                <p className="text-sm text-ink">
                  {selectedRequest.phone ? (
                    <a href={`tel:${selectedRequest.phone}`} className="text-indigo-600 hover:underline">
                      {selectedRequest.phone}
                    </a>
                  ) : '—'}
                </p>
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Address</label>
                <p className="text-sm text-ink">
                  {selectedRequest.address || '—'} {selectedRequest.city ? `, ${selectedRequest.city}` : ''} {selectedRequest.state}
                </p>
              </div>
              {/* Service type / status / priority — 3-up on desktop, but at
                  375px three columns are too cramped, so 2-up on mobile. */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Service</label>
                  <p className="text-sm text-ink">{SERVICE_TYPE_CONFIG[selectedRequest.service_type]?.label}</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Status</label>
                  <p className="text-sm text-ink">{STATUS_CONFIG[selectedRequest.display_status || selectedRequest.status]?.label}</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Priority</label>
                  <p className={`text-sm ${PRIORITY_CONFIG[selectedRequest.priority]?.color}`}>
                    {PRIORITY_CONFIG[selectedRequest.priority]?.label}
                  </p>
                </div>
              </div>

              {/* Quote & property — the customer-facing estimate plus the
                  inputs it was priced on. These lived only on the collapsed
                  list card; the drawer (the operator's "dig in" view) showed
                  none of them, so opening a request hid the estimate, cadence,
                  requested date, and home size. Surfaced here so View Details
                  is a superset of the card, not a subset. */}
              {(selectedRequest.estimate_min || selectedRequest.estimate_max || selectedRequest.frequency
                || selectedRequest.requested_date || selectedRequest.square_footage
                || selectedRequest.bedrooms || selectedRequest.bathrooms || selectedRequest.guests
                || selectedRequest.requested_service || selectedRequest.condition || selectedRequest.pet_hair) && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {estimateText(selectedRequest.estimate_min, selectedRequest.estimate_max) ? (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Estimate</label>
                      <p className="text-sm font-semibold text-emerald-700">
                        {estimateText(selectedRequest.estimate_min, selectedRequest.estimate_max)}
                      </p>
                    </div>
                  ) : ['str', 'commercial'].includes(selectedRequest.service_type) ? (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Estimate</label>
                      <p className="text-sm font-semibold text-violet-700">Custom quote</p>
                    </div>
                  ) : (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Estimate</label>
                      <p className="text-sm text-ink-3">—</p>
                    </div>
                  )}
                  {requestedServiceLabel(selectedRequest.requested_service) && (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Cleaning type</label>
                      <p className="text-sm text-ink">{requestedServiceLabel(selectedRequest.requested_service)}</p>
                    </div>
                  )}
                  {conditionLabel(selectedRequest.condition) && (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Home condition</label>
                      <p className="text-sm text-ink">{conditionLabel(selectedRequest.condition)}</p>
                    </div>
                  )}
                  {petLabel(selectedRequest.pet_hair) && (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Pet hair</label>
                      <p className="text-sm text-ink">{petLabel(selectedRequest.pet_hair)}</p>
                    </div>
                  )}
                  {selectedRequest.frequency && (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Frequency</label>
                      <p className="text-sm text-ink">{selectedRequest.frequency}</p>
                    </div>
                  )}
                  {selectedRequest.requested_date && (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Requested</label>
                      <p className="text-sm text-ink">{formatDate(selectedRequest.requested_date)}</p>
                    </div>
                  )}
                  {selectedRequest.square_footage ? (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Square feet</label>
                      <p className="text-sm text-ink">{selectedRequest.square_footage.toLocaleString()}</p>
                    </div>
                  ) : null}
                  {selectedRequest.bedrooms ? (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Bedrooms</label>
                      <p className="text-sm text-ink">{selectedRequest.bedrooms}</p>
                    </div>
                  ) : null}
                  {selectedRequest.bathrooms ? (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Bathrooms</label>
                      <p className="text-sm text-ink">{selectedRequest.bathrooms}</p>
                    </div>
                  ) : null}
                  {selectedRequest.guests ? (
                    <div>
                      <label className="text-xs font-semibold text-ink-2 uppercase">Guests</label>
                      <p className="text-sm text-ink">{selectedRequest.guests}</p>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Booking essentials from custom_fields — same on-site details
                  the card shows, mirrored here so the drawer is complete. */}
              {selectedRequest.custom_fields && (
                selectedRequest.custom_fields.entry_method
                || selectedRequest.custom_fields.parking_notes
                || selectedRequest.custom_fields.pets_detail
                || (selectedRequest.custom_fields.focus_areas && selectedRequest.custom_fields.focus_areas.length)
                || selectedRequest.custom_fields.special_instructions
                || selectedRequest.custom_fields.listing_url
                || selectedRequest.custom_fields.turnover_day
                || selectedRequest.custom_fields.pets_allowed
                || selectedRequest.custom_fields.arrival_window
                || (Array.isArray(selectedRequest.custom_fields.photos) && selectedRequest.custom_fields.photos.length)
              ) && (
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Booking essentials</label>
                  <div className="text-sm text-ink space-y-0.5 mt-1">
                    {selectedRequest.custom_fields.arrival_window && (
                      <div><span className="text-ink-3">Arrival:</span> {ARRIVAL_WINDOW_LABELS[selectedRequest.custom_fields.arrival_window] || selectedRequest.custom_fields.arrival_window}</div>
                    )}
                    {selectedRequest.custom_fields.listing_url && (
                      <div><span className="text-ink-3">Listing:</span>{' '}
                        <a href={selectedRequest.custom_fields.listing_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline break-all">
                          {selectedRequest.custom_fields.listing_url}
                        </a>
                      </div>
                    )}
                    {selectedRequest.custom_fields.turnover_day && (
                      <div><span className="text-ink-3">Turnover day:</span> {selectedRequest.custom_fields.turnover_day}</div>
                    )}
                    {selectedRequest.custom_fields.pets_allowed && (
                      <div><span className="text-ink-3">Pets allowed:</span> {selectedRequest.custom_fields.pets_allowed}</div>
                    )}
                    {selectedRequest.custom_fields.entry_method && (
                      <div><span className="text-ink-3">Entry:</span> {selectedRequest.custom_fields.entry_method.replace('-', ' ')}</div>
                    )}
                    {selectedRequest.custom_fields.parking_notes && (
                      <div><span className="text-ink-3">Parking:</span> {selectedRequest.custom_fields.parking_notes}</div>
                    )}
                    {selectedRequest.custom_fields.pets_detail && (
                      <div><span className="text-ink-3">Pets:</span> {selectedRequest.custom_fields.pets_detail}</div>
                    )}
                    {selectedRequest.custom_fields.focus_areas && selectedRequest.custom_fields.focus_areas.length > 0 && (
                      <div><span className="text-ink-3">Focus:</span> {selectedRequest.custom_fields.focus_areas.join(', ')}</div>
                    )}
                    {selectedRequest.custom_fields.special_instructions && (
                      <div><span className="text-ink-3">Notes:</span> {selectedRequest.custom_fields.special_instructions}</div>
                    )}
                    {/* Customer-attached photos (inline data URIs) — click to
                        open the full image in a new tab. */}
                    {Array.isArray(selectedRequest.custom_fields.photos) && selectedRequest.custom_fields.photos.length > 0 && (
                      <div>
                        <span className="text-ink-3">Photos ({selectedRequest.custom_fields.photos.length}):</span>
                        <div className="flex gap-2 mt-1">
                          {selectedRequest.custom_fields.photos.slice(0, 3).map((src, i) => (
                            <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                              <img src={src} alt={`Attachment ${i + 1}`}
                                className="w-16 h-16 object-cover rounded border border-hairline" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Message</label>
                <p className="text-sm text-ink whitespace-pre-wrap">{htmlToText(selectedRequest.message) || '—'}</p>
              </div>
              {selectedRequest.created_at && (
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Received</label>
                  <p className="text-sm text-ink">{formatDateTime(selectedRequest.created_at)}</p>
                </div>
              )}
              {selectedRequest.internal_notes && (
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Internal Notes</label>
                  <p className="text-sm text-ink whitespace-pre-wrap">{selectedRequest.internal_notes}</p>
                </div>
              )}
            </div>
            )}

            {/* Footer */}
            <div className="border-t border-hairline bg-bg p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 justify-end sticky bottom-0">
              <button
                onClick={() => handleDelete(selectedRequest)}
                className="w-full sm:w-auto sm:mr-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 border border-transparent hover:border-red-200"
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              <Button variant="secondary" onClick={() => setShowDetailsDrawer(false)} className="w-full sm:w-auto">
                Close
              </Button>
              <Button
                variant="secondary"
                className="w-full sm:w-auto flex items-center gap-2"
                onClick={() => {
                  setShowDetailsDrawer(false)
                  handleConvertToClient(selectedRequest)
                }}
              >
                <UserPlus className="w-4 h-4" />
                Convert to client
              </Button>
              <Button
                variant="primary"
                className="w-full sm:w-auto flex items-center gap-2"
                onClick={() => {
                  setShowDetailsDrawer(false)
                  handleCreateQuote(selectedRequest)
                }}
              >
                <FileText className="w-4 h-4" />
                Create Quote
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* New Request Modal */}
      {showNewRequestModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 flex items-end sm:items-center sm:justify-center">
          <div className="w-full sm:w-full max-w-lg bg-panel rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden sm:max-h-[90vh] flex flex-col max-h-[95vh]">
            <div className="bg-panel border-b border-hairline p-4 sm:p-6 text-ink flex items-center justify-between">
              <h2 className="text-xl font-bold">New Request</h2>
              <button onClick={() => setShowNewRequestModal(false)} className="text-ink-3 hover:text-ink">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 sm:p-6 space-y-4 overflow-y-auto">
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Name *</label>
                <input
                  type="text"
                  value={newRequestForm.name}
                  onChange={(e) => setNewRequestForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 border border-hairline rounded-lg text-sm"
                  placeholder="Customer name"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Phone</label>
                  <input
                    type="tel"
                    value={newRequestForm.phone}
                    onChange={(e) => setNewRequestForm(f => ({ ...f, phone: e.target.value }))}
                    className="w-full mt-1 px-3 py-2 border border-hairline rounded-lg text-sm"
                    placeholder="(207) 555-0100"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-ink-2 uppercase">Email</label>
                  <input
                    type="email"
                    value={newRequestForm.email}
                    onChange={(e) => setNewRequestForm(f => ({ ...f, email: e.target.value }))}
                    className="w-full mt-1 px-3 py-2 border border-hairline rounded-lg text-sm"
                    placeholder="name@example.com"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Address</label>
                <input
                  type="text"
                  value={newRequestForm.address}
                  onChange={(e) => setNewRequestForm(f => ({ ...f, address: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 border border-hairline rounded-lg text-sm"
                  placeholder="123 Main St, Portland, ME"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Service Type</label>
                <select
                  value={newRequestForm.service_type}
                  onChange={(e) => setNewRequestForm(f => ({ ...f, service_type: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 border border-hairline rounded-lg text-sm bg-panel"
                >
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                  <option value="str">STR</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-2 uppercase">Notes</label>
                <textarea
                  value={newRequestForm.message}
                  onChange={(e) => setNewRequestForm(f => ({ ...f, message: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 border border-hairline rounded-lg text-sm"
                  rows={3}
                  placeholder="What does the customer need?"
                />
              </div>
            </div>
            <div className="border-t border-hairline bg-bg p-4 sm:p-6 flex flex-col-reverse sm:flex-row gap-3 justify-end sticky bottom-0">
              <Button variant="secondary" onClick={() => setShowNewRequestModal(false)} className="w-full sm:w-auto">
                Cancel
              </Button>
              <Button
                variant="primary"
                className="w-full sm:w-auto"
                disabled={!newRequestForm.name.trim() || creatingRequest}
                onClick={handleCreateRequest}
              >
                {creatingRequest ? 'Creating…' : 'Create Request'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
