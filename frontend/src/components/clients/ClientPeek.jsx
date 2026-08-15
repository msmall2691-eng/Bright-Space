import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseISO, format } from 'date-fns'
import { Phone, Mail, MapPin, Home, CalendarDays, StickyNote, MessageCircle } from 'lucide-react'
import { get, patch } from '../../api'
import { toast } from '../../utils/toastBus'
import { PeekPanel, StatusBadge, Skeleton, ErrorState } from '../ui'
import { ComposeModal } from '../comms/ComposeModal'
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

/** Click-to-edit contact row at InfoRow's compact density (13px text, same
 *  icon + spacing) — same interaction as ClientLeftRail's EditableField
 *  (click value to edit, Enter/blur saves, Escape cancels) so editing a
 *  client never requires leaving the Clients list for the full page. */
function EditableRow({ icon: Icon, value, displayValue, placeholder = 'Add', type = 'text', saving = false, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  useEffect(() => { setDraft(value || '') }, [value])
  const commit = () => {
    setEditing(false)
    const v = (draft || '').trim()
    if (v !== (value || '')) onSave(v)
  }
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-1">
      <Icon className="h-4 w-4 shrink-0 text-ink-3" />
      {editing ? (
        <input
          autoFocus
          type={type}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') { setDraft(value || ''); setEditing(false) }
          }}
          className="min-w-0 flex-1 rounded-sm border border-indigo-400 bg-panel px-1.5 py-0.5 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-indigo-400/30"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          title="Click to edit"
          className="-mx-1 min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left text-[13px] text-ink-2 transition-colors hover:bg-bg-2"
        >
          {(displayValue ?? value) || <span className="italic text-ink-3">{placeholder}</span>}
          {saving && <span className="ml-1.5 text-[11px] text-ink-3/70">saving…</span>}
        </button>
      )}
    </div>
  )
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
 *
 * Phone/email/address are click-to-edit in place (PATCH /api/clients/{id}) —
 * fixing a wrong phone number no longer requires leaving the list to find
 * the field on the full profile page. Edits patch the field and merge the
 * response into local state; they never trigger a full profile refetch
 * (economy rule: one fetch per screen per need).
 */
export default function ClientPeek({ clientId, onClose, onPrev, onNext, hasPrev, hasNext }) {
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [savingField, setSavingField] = useState(null)
  const [composing, setComposing] = useState(false)

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

  // Same PATCH-and-merge-locally pattern as ClientProfile's saveField
  // (useClientProfileData / ClientLeftRail) — no refetch of the whole
  // profile just to reflect one field.
  const saveField = async (key, value) => {
    setSavingField(key)
    try {
      const updated = await patch(`/api/clients/${clientId}`, { [key]: value })
      setProfile(p => ({ ...p, ...(updated && typeof updated === 'object' ? updated : {}), [key]: value }))
      toast.success('Saved')
    } catch (e) {
      toast.error('Could not save: ' + (e?.message || 'unknown error'))
    } finally {
      setSavingField(null)
    }
  }

  const c = profile || {}
  const av = avatarColor(c.name || '')
  const upcoming = (c.upcoming_visits || []).slice(0, 4)
  const recent = (c.past_visits || []).slice(0, 4)
  const stats = c.visit_stats

  return (
    <>
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
        <ErrorState
          compact
          description={error}
          onRetry={() => { setError(null); setLoading(true); get(`/api/clients/${clientId}/profile`).then(d => { setProfile(d); setLoading(false) }).catch(e => { setError(e?.message || 'Could not load client'); setLoading(false) }) }}
        />
      ) : (
        <div className="px-4 pb-6 pt-2">
          {/* Contact — click any value to edit in place; saves on blur/Enter,
              PATCHes /api/clients/{id} directly (no profile refetch). */}
          <EditableRow icon={Phone} type="tel" value={c.phone} placeholder="Add phone"
            saving={savingField === 'phone'} onSave={v => saveField('phone', v)} />
          <EditableRow icon={Mail} type="email" value={c.email} placeholder="Add email"
            saving={savingField === 'email'} onSave={v => saveField('email', v)} />
          <EditableRow icon={MapPin} value={c.address} placeholder="Add street address"
            displayValue={[c.address, c.city, c.state].filter(Boolean).join(', ')}
            saving={savingField === 'address'} onSave={v => saveField('address', v)} />

          {/* Message — compose without leaving the list. Reuses the same
              ComposeModal the Schedule visit drawer opens. */}
          {(c.phone || c.email) && (
            <button
              onClick={() => setComposing(true)}
              className="mt-2 flex min-h-[28px] items-center gap-1.5 rounded-md border border-hairline-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2"
            >
              <MessageCircle className="h-3.5 w-3.5" /> Message
            </button>
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
    {composing && (
      <ComposeModal
        initialTo={c.phone || c.email || ''}
        initialChannel={c.phone ? 'sms' : 'email'}
        clientId={clientId}
        onClose={() => setComposing(false)}
        onSent={() => { setComposing(false); toast.success('Message sent') }}
      />
    )}
    </>
  )
}
