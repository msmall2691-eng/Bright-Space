import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseISO, format } from 'date-fns'
import { Phone, Mail, MapPin, Home, CalendarDays, StickyNote } from 'lucide-react'
import { get } from '../../api'
import { PeekPanel, StatusBadge, Skeleton, ErrorState } from '../ui'
import { avatarColor } from './constants'

const STATUS_KIND = { active: 'success', lead: 'warning', inactive: 'neutral' }

// A visit date is a calendar date — parseISO reads "2026-08-13" as local
// midnight (never `new Date(str)`, which shifts it a day in Maine).
const visitDate = (d) => {
  try { return format(parseISO(d), 'EEE MMM d') } catch { return d || '' }
}

function InfoRow({ icon: Icon, children, href }) {
  const body = (
    <span className="flex min-w-0 items-center gap-2.5 text-[13px] text-ink-2">
      <Icon className="h-4 w-4 shrink-0 text-ink-3" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
  if (!href) return <div className="py-1">{body}</div>
  return (
    <a href={href} className="block min-h-0 rounded-sm py-1 no-underline hover:bg-bg-2">
      {body}
    </a>
  )
}

function SectionLabel({ children }) {
  return <p className="pb-1 pt-4 text-[11px] font-medium text-ink-3">{children}</p>
}

function VisitRow({ v }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-hairline py-1.5 text-[13px] last:border-b-0">
      <span className="whitespace-nowrap tabular-nums text-ink">{visitDate(v.scheduled_date)}</span>
      {v.start_time && <span className="whitespace-nowrap text-[11px] text-ink-3">{v.start_time}</span>}
      <span className="min-w-0 flex-1 truncate text-ink-2">{v.title || v.property_name || v.address || ''}</span>
      <span className="shrink-0 text-[11px] capitalize text-ink-3">{v.status}</span>
    </div>
  )
}

/**
 * ClientPeek — the Clients table's record peek. One fetch
 * (/api/clients/{id}/profile) covers identity, contact links, properties,
 * upcoming/recent visits, and lifetime stats. Opening the full page is one
 * click (or ⏎ never steals it — the panel is preview-only).
 */
export default function ClientPeek({ clientId, onClose, onPrev, onNext, hasPrev, hasNext }) {
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!clientId) return
    let ignore = false
    setLoading(true)
    setError(null)
    get(`/api/clients/${clientId}/profile`)
      .then(data => { if (!ignore) { setProfile(data); setLoading(false) } })
      .catch(e => { if (!ignore) { setError(e?.message || 'Could not load client'); setLoading(false) } })
    return () => { ignore = true }
  }, [clientId])

  const c = profile || {}
  const av = avatarColor(c.name || '')
  const upcoming = (c.upcoming_visits || []).slice(0, 4)
  const recent = (c.past_visits || []).slice(0, 4)
  const stats = c.visit_stats

  return (
    <PeekPanel
      open={Boolean(clientId)}
      onClose={onClose}
      onExpand={() => navigate(`/clients/${clientId}`)}
      onPrev={onPrev}
      onNext={onNext}
      hasPrev={hasPrev}
      hasNext={hasNext}
      title={
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${av}`}>
            {(c.name || '?')[0]?.toUpperCase()}
          </span>
          <span className="truncate text-[13px] font-semibold text-ink">{c.name || 'Client'}</span>
          {c.status && <StatusBadge status={STATUS_KIND[c.status] || 'neutral'}>{c.status}</StatusBadge>}
        </div>
      }
    >
      {loading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => { setError(null); setLoading(true); get(`/api/clients/${clientId}/profile`).then(d => { setProfile(d); setLoading(false) }).catch(e => { setError(e?.message || 'Could not load client'); setLoading(false) }) }} />
      ) : (
        <div className="px-4 pb-6 pt-2">
          {/* Contact */}
          {c.phone && <InfoRow icon={Phone} href={`tel:${c.phone}`}>{c.phone}</InfoRow>}
          {c.email && <InfoRow icon={Mail} href={`mailto:${c.email}`}>{c.email}</InfoRow>}
          {(c.address || c.city) && (
            <InfoRow icon={MapPin}>
              {[c.address, c.city, c.state].filter(Boolean).join(', ')}
            </InfoRow>
          )}
          {!c.phone && !c.email && (
            <p className="py-1 text-[13px] text-ink-3">No contact info on file.</p>
          )}

          {/* Lifetime stats */}
          {stats && stats.total > 0 && (
            <p className="pt-3 text-[13px] text-ink-3">
              Visits <b className="font-semibold tabular-nums text-ink">{stats.total}</b>
              <span className="mx-2 text-ink-3/50">·</span>
              Completed <b className="font-semibold tabular-nums text-ink">{stats.completed}</b>
              <span className="mx-2 text-ink-3/50">·</span>
              Upcoming <b className="font-semibold tabular-nums text-ink">{stats.upcoming}</b>
            </p>
          )}

          {/* Properties */}
          {(c.properties || []).length > 0 && (
            <>
              <SectionLabel>Properties</SectionLabel>
              {c.properties.map(p => (
                <InfoRow key={p.id} icon={Home}>
                  <span className="text-ink">{p.name}</span>
                  {p.address && <span className="text-ink-3"> — {p.address}</span>}
                </InfoRow>
              ))}
            </>
          )}

          {/* Visits */}
          {upcoming.length > 0 && (
            <>
              <SectionLabel>Upcoming</SectionLabel>
              {upcoming.map(v => <VisitRow key={v.id} v={v} />)}
            </>
          )}
          {recent.length > 0 && (
            <>
              <SectionLabel>Recent</SectionLabel>
              {recent.map(v => <VisitRow key={v.id} v={v} />)}
            </>
          )}
          {upcoming.length === 0 && recent.length === 0 && (
            <>
              <SectionLabel>Visits</SectionLabel>
              <p className="flex items-center gap-2 py-1 text-[13px] text-ink-3">
                <CalendarDays className="h-4 w-4" /> No visits yet.
              </p>
            </>
          )}

          {/* Notes */}
          {c.notes && (
            <>
              <SectionLabel>Notes</SectionLabel>
              <p className="flex items-start gap-2.5 whitespace-pre-wrap py-1 text-[13px] leading-relaxed text-ink-2">
                <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
                <span className="min-w-0">{c.notes}</span>
              </p>
            </>
          )}
        </div>
      )}
    </PeekPanel>
  )
}
