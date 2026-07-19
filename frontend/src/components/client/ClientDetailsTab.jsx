import { Calendar, ChevronRight, Save } from 'lucide-react'

/** The Details / Edit tab: upcoming-cleanings strip, contact info form,
 *  service address, collapsible billing address, and the save button. */
export default function ClientDetailsTab({
  form, setForm,
  upcomingJobs,
  saving, save,
  showBilling, setShowBilling,
}) {
  return (
    <div className="max-w-lg space-y-5">

      {/* Upcoming cleanings */}
      {upcomingJobs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">Upcoming Cleanings</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {upcomingJobs.slice(0, 5).map(j => {
              const typeColor = j.job_type === 'str_turnover' ? 'border-orange-400/30 bg-orange-500/10' : j.job_type === 'commercial' ? 'border-green-400/30 bg-green-500/10' : 'border-blue-400/30 bg-blue-500/10'
              const textColor = j.job_type === 'str_turnover' ? 'text-orange-600' : j.job_type === 'commercial' ? 'text-green-600' : 'text-indigo-600'
              return (
                <div key={j.id} className={`flex-shrink-0 ${typeColor} border rounded-lg px-3 py-2 min-w-[130px]`}>
                  <div className={`text-xs font-semibold ${textColor}`}>
                    {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </div>
                  <div className={`text-[11px] ${textColor} mt-0.5`}>{j.start_time} – {j.end_time}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Contact info */}
      <div className="bg-panel border border-hairline rounded-xl p-4 sm:p-6 space-y-4" data-testid="client-edit-contact">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-1">Contact Info</div>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="block text-xs text-ink-3 mb-1">First Name</label>
            <input value={form.first_name || ''} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-ink-3 mb-1">Last Name</label>
            <input value={form.last_name || ''} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
              className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
          </div>
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1">Phone</label>
          <input type="tel" value={form.phone || ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            placeholder="+1 (555) 123-4567"
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1">Email</label>
          <input type="email" value={form.email || ''} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            placeholder="client@example.com"
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1">Lead Source</label>
          <input value={form.source || ''} onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
            placeholder="e.g., Google, Referral, Facebook"
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400" />
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1">Status</label>
          <select value={form.status || 'lead'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400">
            <option value="lead">Lead</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-ink-3 mb-1">Notes</label>
          <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
            placeholder="Any special notes about this client"
            className="w-full bg-panel border border-hairline rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-blue-400 resize-none" />
        </div>
      </div>

      {/* Service address */}
      <div className="bg-panel border border-hairline rounded-xl p-4 sm:p-6 space-y-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">Service Address</div>
        {[
          { label: 'Street', key: 'address' },
          { label: 'City', key: 'city' },
          { label: 'State', key: 'state' },
          { label: 'ZIP', key: 'zip_code' },
        ].map(({ label, key }) => (
          <div key={key} className="flex flex-col sm:flex-row sm:items-center sm:gap-4">
            <span className="text-xs text-ink-3 sm:w-24 sm:shrink-0 mb-1 sm:mb-0">{label}</span>
            <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 sm:py-1.5 text-sm text-ink focus:outline-none focus:border-blue-400" />
          </div>
        ))}
      </div>

      {/* Billing address — collapsed by default when empty */}
      <div className="bg-panel border border-hairline rounded-xl p-4 sm:p-6">
        <button
          type="button"
          onClick={() => setShowBilling(s => !s)}
          className="w-full flex items-center justify-between text-left"
          data-testid="client-billing-toggle"
        >
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">Billing Address</div>
            {!showBilling && (
              <p className="text-xs text-ink-3 mt-1">Same as service address on invoices</p>
            )}
          </div>
          <ChevronRight className={`w-4 h-4 text-ink-3 transition-transform ${showBilling ? 'rotate-90' : ''}`} />
        </button>
        {showBilling && (
          <div className="space-y-3 mt-4">
            {[
              { label: 'Street', key: 'billing_address' },
              { label: 'City', key: 'billing_city' },
              { label: 'State', key: 'billing_state' },
              { label: 'ZIP', key: 'billing_zip' },
            ].map(({ label, key }) => (
              <div key={key} className="flex flex-col sm:flex-row sm:items-center sm:gap-4">
                <span className="text-xs text-ink-3 sm:w-24 sm:shrink-0 mb-1 sm:mb-0">{label}</span>
                <input value={form[key] || ''} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="flex-1 bg-panel border border-hairline rounded-lg px-3 py-2 sm:py-1.5 text-sm text-ink focus:outline-none focus:border-blue-400" />
              </div>
            ))}
          </div>
        )}
      </div>

      <button onClick={save} disabled={saving}
        data-testid="client-save-changes"
        className="w-full sm:w-auto flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-bg-2 px-5 py-2.5 sm:py-2 rounded-lg text-sm font-medium transition-colors">
        <Save className="w-4 h-4" />{saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  )
}
