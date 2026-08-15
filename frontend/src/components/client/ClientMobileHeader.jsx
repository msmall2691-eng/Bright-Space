import {
  ArrowLeft, Phone, Mail, MapPin, Edit2, Save, AlertCircle,
} from 'lucide-react'
import { STATUS_COLORS } from './constants'

/** Mobile-only client identity header. The desktop >= lg viewport uses
 *  ClientLeftRail instead — this component is `lg:hidden`. */
export default function ClientMobileHeader({
  client, navigate, setTab,
  visitStats, upcomingJobs, totalRevenue, outstanding,
  quickContactOpen, setQuickContactOpen,
  quickContact, setQuickContact,
  quickContactSaving, openQuickContact, saveQuickContact,
}) {
  return (
    <div className="bg-panel border-b border-hairline px-4 sm:px-6 py-4 shrink-0 lg:hidden">
      <button onClick={() => navigate('/clients')}
        className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-3 mb-3 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Clients
      </button>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div className="w-11 h-11 sm:w-14 sm:h-14 rounded-2xl bg-blue-500/10 flex items-center justify-center shrink-0">
            <span className="text-blue-500 font-bold text-lg sm:text-xl">{(client.first_name || client.name)[0]?.toUpperCase()}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold text-ink tracking-tight truncate">{client.name}</h1>
              <span className="inline-flex items-center gap-1.5 text-[10px] sm:text-xs px-2 py-0.5 rounded-sm border border-hairline-2 bg-panel text-ink-2 capitalize">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[client.status] || 'bg-ink-3'}`} aria-hidden="true" />
                {client.status}
              </span>
              {client.lifecycle_stage && client.lifecycle_stage !== client.status && (
                <span className="text-[10px] sm:text-xs px-2 py-0.5 rounded-full border border-hairline bg-bg-2 text-ink-3 capitalize"
                  title="Lifecycle stage">
                  {client.lifecycle_stage}
                </span>
              )}
            </div>
            <div className="flex items-center gap-x-3 gap-y-1 mt-1 flex-wrap">
              {client.phone && <span className="flex items-center gap-1 text-xs sm:text-sm text-ink-3"><Phone className="w-3.5 h-3.5" />{client.phone}</span>}
              {client.email && <span className="flex items-center gap-1 text-xs sm:text-sm text-ink-3 truncate max-w-full"><Mail className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{client.email}</span></span>}
              {(client.city || client.address) && (
                <span className="flex items-center gap-1 text-xs sm:text-sm text-ink-3">
                  <MapPin className="w-3.5 h-3.5" />{client.city || client.address}
                </span>
              )}
            </div>
          </div>
        </div>

        <button onClick={() => {
            setTab('details')
            setTimeout(() => {
              document.querySelector('[data-testid="client-edit-contact"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 50)
          }}
          data-testid="client-header-edit"
          className="flex items-center justify-center gap-1.5 bg-bg-2 hover:bg-bg-2 border border-hairline px-3 py-1.5 rounded-lg text-sm transition-colors shrink-0 self-start">
          <Edit2 className="w-3.5 h-3.5" /> Edit Info
        </button>
      </div>

      {/* Stats bar — the three business numbers. (A 4th "GCal" card showed a
          cryptic ●/✓ sync diagnostic; that belongs on Schedule, not here.) */}
      <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-hairline">
        {/* Upcoming */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 sm:p-3">
          <div className="text-xs sm:text-sm text-indigo-600 font-medium">Upcoming</div>
          <div className="text-lg sm:text-base font-bold text-indigo-700 mt-0.5">{visitStats?.upcoming ?? upcomingJobs.length}</div>
        </div>

        {/* Revenue */}
        <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 sm:p-3">
          <div className="text-xs sm:text-sm text-green-600 font-medium">Revenue</div>
          <div className="text-lg sm:text-base font-bold text-green-700 mt-0.5">${totalRevenue.toFixed(0)}</div>
        </div>

        {/* Outstanding */}
        <div className={`border rounded-lg p-2.5 sm:p-3 ${outstanding > 0 ? 'bg-amber-50 border-amber-200' : 'bg-bg border-hairline'}`}>
          <div className={`text-xs sm:text-sm font-medium ${outstanding > 0 ? 'text-amber-600' : 'text-ink-2'}`}>Outstanding</div>
          <div className={`text-lg sm:text-base font-bold mt-0.5 ${outstanding > 0 ? 'text-amber-700' : 'text-ink-2'}`}>${outstanding.toFixed(0)}</div>
        </div>
      </div>


      {/* Missing contact info — tappable quick-add (mobile-friendly) */}
      {(!client.phone || !client.email) && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg overflow-hidden" data-testid="missing-contact-banner">
          {!quickContactOpen ? (
            <button
              type="button"
              onClick={openQuickContact}
              data-testid="missing-contact-open"
              className="w-full flex items-center gap-2.5 p-3 text-left hover:bg-amber-100/60 transition-colors">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-amber-900">Add {!client.phone && !client.email ? 'phone and email' : !client.phone ? 'phone number' : 'email'}</div>
                <p className="text-xs text-amber-700 mt-0.5">Tap to add now</p>
              </div>
              <span className="text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-md shrink-0">
                Add
              </span>
            </button>
          ) : (
            <div className="p-3 space-y-2.5">
              {!client.phone && (
                <div>
                  <label className="block text-[11px] font-medium text-amber-900 mb-1">Phone</label>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoFocus
                    value={quickContact.phone}
                    onChange={e => setQuickContact(q => ({ ...q, phone: e.target.value }))}
                    placeholder="+1 (555) 123-4567"
                    data-testid="missing-contact-phone"
                    className="w-full bg-panel border border-amber-200 rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/30" />
                </div>
              )}
              {!client.email && (
                <div>
                  <label className="block text-[11px] font-medium text-amber-900 mb-1">Email</label>
                  <input
                    type="email"
                    inputMode="email"
                    autoFocus={!!client.phone}
                    value={quickContact.email}
                    onChange={e => setQuickContact(q => ({ ...q, email: e.target.value }))}
                    placeholder="client@example.com"
                    data-testid="missing-contact-email"
                    className="w-full bg-panel border border-amber-200 rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/30" />
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setQuickContactOpen(false)}
                  className="px-3 py-2 text-sm text-amber-900 hover:bg-amber-100 rounded-lg transition-colors">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveQuickContact}
                  disabled={quickContactSaving || (!quickContact.phone.trim() && !quickContact.email.trim())}
                  data-testid="missing-contact-save"
                  className="flex-1 flex items-center justify-center gap-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
                  <Save className="w-3.5 h-3.5" />
                  {quickContactSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
