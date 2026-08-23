/**
 * CustomerActions — "message them / book them" wherever a customer is on screen.
 *
 * Before this, the only places you could message a customer were their
 * profile's Messages tab, the /comms inbox, the Clients peek panel and the
 * schedule's visit drawer. Looking at a job, a house, a lead or a deal, there
 * wasn't even a `tel:` link — you had to leave the record you were working on,
 * go find the person, message them, and navigate back. Owner: "make sure we
 * can easily schedule and communicate with customers within their profile and
 * all other places."
 *
 * Drop-in: one line per page.
 *
 *   <CustomerActions clientId={job.client_id} clientName={job.client_name}
 *                    propertyId={job.property_id} onBooked={reload} />
 *
 * This is a THIN WRAPPER on purpose. Composing reuses the app's existing
 * ComposeModal (already behind the Clients peek panel, the schedule's visit
 * drawer and the Comms inbox) and booking reuses JobCreateModal. A fifth
 * hand-rolled message form would be one more thing to keep in sync with
 * Twilio, threading and the send-failure copy.
 *
 * Economy (brightbase-economy rule 3): host pages carry `client_id` but not
 * the phone/email, and fetching contact details on every job/property/deal
 * page load would be a request per view for a button most views never press.
 * The contact is fetched ONCE, lazily, on first press — and not at all when
 * the caller already has it (leads pass theirs straight in). Nothing on mount.
 */
import { useCallback, useState } from 'react'
import { MessageSquare, CalendarPlus, Loader2 } from 'lucide-react'
import { get } from '../../api'
import { toast } from '../../utils/toastBus'
import { ComposeModal } from './ComposeModal'
import JobCreateModal from '../JobCreateModal'

const BTN = 'inline-flex items-center gap-1.5 rounded-md border border-hairline-2 bg-panel ' +
  'px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-bg-2 ' +
  'disabled:opacity-40 disabled:hover:bg-panel'

export default function CustomerActions({
  clientId = null,
  clientName = '',
  propertyId = null,
  phone = null,        // pass when the host already has it (skips the fetch)
  email = null,
  onBooked = null,     // called after a visit is created, so the page refreshes
  onSent = null,       // called after a message goes out
  showBook = true,
  className = '',
}) {
  const [contact, setContact] = useState(
    phone || email ? { phone, email } : null)
  const [loading, setLoading] = useState(false)
  const [composing, setComposing] = useState(false)
  const [booking, setBooking] = useState(false)

  const openCompose = useCallback(async () => {
    if (contact || !clientId) { setComposing(true); return }
    setLoading(true)
    try {
      const c = await get(`/api/clients/${clientId}`)
      setContact({ phone: c?.phone || null, email: c?.email || null })
    } catch {
      // Open anyway with an empty recipient rather than blocking the send —
      // the operator can type the number they already know.
      toast.error("Couldn't load this customer's contact details.")
      setContact({ phone: null, email: null })
    } finally {
      setLoading(false)
      setComposing(true)
    }
  }, [contact, clientId])

  // A lead has a phone/email but no client record yet: messaging works (the
  // SMS endpoint threads by number), but you can't book a visit for a customer
  // who doesn't exist yet.
  const canBook = showBook && !!clientId
  if (!clientId && !phone && !email) return null

  // Prefer whichever channel the customer actually has.
  const channel = contact?.phone ? 'sms' : (contact?.email ? 'email' : 'sms')
  const to = channel === 'sms' ? (contact?.phone || '') : (contact?.email || '')

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <button onClick={openCompose} disabled={loading} className={BTN}
        data-testid="customer-message">
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
        Message
      </button>

      {canBook && (
        <button onClick={() => setBooking(true)} className={BTN} data-testid="customer-book">
          <CalendarPlus className="h-3.5 w-3.5" /> Book a visit
        </button>
      )}

      {composing && (
        <ComposeModal
          initialTo={to}
          initialChannel={channel}
          clientId={clientId}
          onClose={() => setComposing(false)}
          onSent={(res) => { setComposing(false); onSent?.(res) }} />
      )}

      {booking && (
        <JobCreateModal
          clientId={clientId}
          clientName={clientName}
          initialPropertyId={propertyId}
          onClose={() => setBooking(false)}
          onCreated={() => { setBooking(false); onBooked?.() }} />
      )}
    </div>
  )
}
