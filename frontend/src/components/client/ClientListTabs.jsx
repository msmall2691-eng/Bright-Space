/**
 * The five small list-style tabs on the client profile:
 *   RecurringTab, JobsListTab, QuotesListTab, InvoicesListTab, OpportunitiesTab
 *
 * Each renders a list of `<RecordLink>`/`OpportunityLinker`-shaped rows against
 * an array in props. Bundled in one file because they're each 30–70 lines and
 * share the same "list of cards" pattern; splitting into five files would just
 * add noise to the components/client/ directory.
 */
import { Plus, Calendar, MapPin, RefreshCw, TrendingUp } from 'lucide-react'
import RecordLink from '../RecordLink'
import OpportunityLinker from '../OpportunityLinker'
import { JOB_COLORS, INVOICE_COLORS, QUOTE_COLORS, OPP_COLORS } from './constants'

export function RecurringTab({ schedules }) {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-ink-3">{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</p>
        <a href="/recurring"
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add Schedule
        </a>
      </div>
      {schedules.length === 0 && (
        <div className="text-center py-10">
          <RefreshCw className="w-8 h-8 mx-auto mb-2 text-ink-2" />
          <p className="text-ink-3 text-sm mb-3">No recurring schedules</p>
          <a href="/recurring" className="text-xs text-blue-500 hover:text-sky-300">Set one up on the Recurring page</a>
        </div>
      )}
      <div className="space-y-2">
        {schedules.map(s => {
          const FREQ = { weekly: 'Every week', biweekly: 'Every 2 wks', monthly: 'Monthly' }
          const DAYS_S = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
          const typeColors = {
            residential: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
            commercial:  'text-green-400 bg-green-500/10 border-green-500/20',
          }
          return (
            <div key={s.id} className={`bg-panel border rounded-xl p-4 ${s.active ? 'border-hairline' : 'border-hairline opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-ink">{s.title}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${typeColors[s.job_type] || typeColors.residential}`}>
                      {s.job_type}
                    </span>
                    {!s.active && <span className="text-[10px] text-ink-3 bg-bg-2 px-2 py-0.5 rounded-full">Paused</span>}
                  </div>
                  <div className="text-xs text-ink-3">
                    {FREQ[s.frequency]} · {s.frequency !== 'monthly' ? `${DAYS_S[s.day_of_week]}s` : `day ${s.day_of_month}`} · {s.start_time}–{s.end_time}
                  </div>
                  {s.address && <div className="text-[10px] text-ink-3 mt-0.5 flex items-center gap-1"><MapPin className="w-2.5 h-2.5" />{s.address}</div>}
                </div>
                <a href={`/recurring?series=${s.id}`} className="text-xs text-ink-3 hover:text-ink-3 bg-bg-2 hover:bg-bg-2 px-2.5 py-1.5 rounded-lg transition-colors shrink-0">
                  Manage
                </a>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function JobsListTab({ jobs, upcomingJobs, pastJobs, clientId, onLinked }) {
  return (
    <div className="max-w-2xl space-y-5">
      {jobs.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No jobs yet</p>}

      {/* Upcoming */}
      {upcomingJobs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-semibold text-ink-2 uppercase tracking-wide">Upcoming ({upcomingJobs.length})</span>
          </div>
          <div className="space-y-2">
            {upcomingJobs.map(j => (
              <div key={j.id} className="bg-panel border border-blue-400/30 rounded-xl p-4 flex items-center gap-4">
                <div className="text-center w-16 shrink-0">
                  <div className="text-sm font-semibold text-blue-600">
                    {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                  <div className="text-xs text-blue-500">{j.start_time}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <RecordLink type="job" id={j.id} label={j.title} className="font-medium" />
                  {j.address && <div className="text-xs text-ink-3 flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" />{j.address}</div>}
                </div>
                <div className="flex items-center gap-2">
                  {j.dispatched && <span className="text-xs bg-purple-100 text-purple-700 border border-purple-200 px-2 py-0.5 rounded-full">Dispatched</span>}
                  <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${JOB_COLORS[j.status]}`}>{j.status.replace('_', ' ')}</span>
                  <OpportunityLinker
                    clientId={clientId}
                    itemType="job"
                    itemId={j.id}
                    itemName={j.title}
                    currentOpportunityId={j.opportunity_id}
                    onLinked={onLinked}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Past */}
      {pastJobs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-ink-3 uppercase tracking-wide mb-3">Past ({pastJobs.length})</p>
          <div className="space-y-2">
            {pastJobs.map(j => (
              <div key={j.id} className="bg-bg border border-hairline rounded-xl p-4 flex items-center gap-4">
                <div className="text-center w-16 shrink-0">
                  <div className="text-sm font-medium text-ink-3">
                    {new Date(j.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                  <div className="text-xs text-ink-3">{j.start_time}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <RecordLink type="job" id={j.id} label={j.title} className="font-medium" />
                  {j.address && <div className="text-xs text-ink-3 flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" />{j.address}</div>}
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${JOB_COLORS[j.status]}`}>{j.status.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function QuotesListTab({ quotes, clientId, onLinked }) {
  return (
    <div className="max-w-2xl space-y-2">
      {quotes.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No quotes yet</p>}
      {quotes.map(q => (
        <div key={q.id} className="bg-panel border border-hairline rounded-xl p-4 flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <RecordLink type="quote" id={q.id} label={`$${q.total?.toFixed(2)} · ${q.quote_number}`} className="font-medium" />
            <div className="text-xs text-ink-3 mt-0.5">{q.items?.length || 0} items · {new Date(q.created_at).toLocaleDateString()}</div>
          </div>
          <div className="flex items-center gap-2 ml-4">
            <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${QUOTE_COLORS[q.status] || QUOTE_COLORS.draft}`}>{(q.status || '').replace(/_/g, ' ')}</span>
            <OpportunityLinker
              clientId={clientId}
              itemType="quote"
              itemId={q.id}
              itemName={`Quote $${q.total?.toFixed(2)}`}
              currentOpportunityId={q.opportunity_id}
              onLinked={onLinked}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export function InvoicesListTab({ invoices, clientId, onLinked }) {
  return (
    <div className="max-w-2xl space-y-2">
      {invoices.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No invoices yet</p>}
      {invoices.map(inv => (
        <div key={inv.id} className="bg-panel border border-hairline rounded-xl p-4 flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <RecordLink type="invoice" id={inv.id} label={inv.invoice_number} className="font-medium" />
            <div className="text-xs text-ink-3 mt-0.5">Due {inv.due_date || 'N/A'} · ${inv.total?.toFixed(2)}</div>
          </div>
          <div className="flex items-center gap-2 ml-4">
            <span className={`text-xs px-2.5 py-1 rounded-full capitalize ${INVOICE_COLORS[inv.status]}`}>{inv.status}</span>
            <OpportunityLinker
              clientId={clientId}
              itemType="invoice"
              itemId={inv.id}
              itemName={inv.invoice_number}
              currentOpportunityId={inv.opportunity_id}
              onLinked={onLinked}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export function OpportunitiesTab({ opportunities, navigate }) {
  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-ink-3">{opportunities.length} opportunit{opportunities.length !== 1 ? 'ies' : 'y'}</p>
        <button onClick={() => navigate('/pipeline')}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
          <Plus className="w-3.5 h-3.5" /> New Deal
        </button>
      </div>
      {opportunities.length === 0 && <p className="text-ink-3 text-sm text-center py-10">No opportunities yet</p>}
      {opportunities.map(opp => (
        <div key={opp.id} className="bg-panel border border-hairline rounded-xl p-4 hover:shadow-sm transition-all">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-amber-500" />
                <RecordLink type="opportunity" id={opp.id} label={opp.title} className="font-medium" />
                <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${OPP_COLORS[opp.stage] || 'bg-bg-2 text-ink-3'}`}>
                  {opp.stage}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
                {opp.service_type && <span className="capitalize">{opp.service_type.replace('_', ' ')}</span>}
                {opp.owner && <span>Owner: {opp.owner}</span>}
                {opp.close_date && <span>Close: {opp.close_date}</span>}
                {opp.probability != null && <span>{opp.probability}% likely</span>}
              </div>
              {opp.notes && <p className="text-xs text-ink-3 mt-2 italic">{opp.notes}</p>}
            </div>
            {opp.amount != null && (
              <span className="text-lg font-bold text-emerald-600 shrink-0">${opp.amount.toLocaleString()}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
