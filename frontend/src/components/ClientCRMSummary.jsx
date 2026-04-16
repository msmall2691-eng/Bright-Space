import { useEffect, useState } from 'react'
import { get } from '../api'
import {
  DollarSign, TrendingUp, Mail, MessageSquare, FileText,
  CheckCircle, Clock, AlertCircle, Target, Calendar,
  Phone, Eye, Loader
} from 'lucide-react'

const STAGE_COLORS = {
  new:       'bg-amber-50 border-amber-200 text-amber-700',
  qualified: 'bg-blue-50 border-blue-200 text-blue-700',
  quoted:    'bg-purple-50 border-purple-200 text-purple-700',
  won:       'bg-emerald-50 border-emerald-200 text-emerald-700',
  lost:      'bg-red-50 border-red-200 text-red-700',
}

function StatCard({ icon: Icon, label, value, subtext, color = 'blue' }) {
  const colorMap = {
    blue:    'bg-blue-50 text-blue-600 border-blue-200',
    emerald: 'bg-emerald-50 text-emerald-600 border-emerald-200',
    amber:   'bg-amber-50 text-amber-600 border-amber-200',
    purple:  'bg-purple-50 text-purple-600 border-purple-200',
    red:     'bg-red-50 text-red-600 border-red-200',
  }
  return (
    <div className={`rounded-lg border ${colorMap[color]} p-4`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <Icon className="w-5 h-5" />
      </div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {subtext && <div className="text-xs text-gray-600 mt-1">{subtext}</div>}
    </div>
  )
}

export default function ClientCRMSummary({ clientId }) {
  const [crm, setCrm] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const data = await get(`/api/clients/${clientId}/crm-summary`)
        setCrm(data)
      } catch (error) {
        console.error('Error loading CRM summary:', error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [clientId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!crm) return null

  return (
    <div className="space-y-6">
      {/* Lifecycle Status */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Eye className="w-5 h-5 text-blue-500" />
          Lifecycle Status
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm text-gray-600">Stage</div>
            <div className="text-lg font-semibold text-gray-900 capitalize">{crm.lifecycle_stage || 'new'}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm text-gray-600">Type</div>
            <div className="text-lg font-semibold text-gray-900 capitalize">{crm.client_type || 'residential'}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm text-gray-600">Source</div>
            <div className="text-sm font-semibold text-gray-900">{crm.source_detail || crm.source || '—'}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm text-gray-600">Last Contacted</div>
            <div className="text-sm font-semibold text-gray-900">
              {crm.last_contacted_at ? new Date(crm.last_contacted_at).toLocaleDateString() : 'Never'}
            </div>
          </div>
        </div>
      </div>

      {/* Pipeline Summary */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Target className="w-5 h-5 text-purple-500" />
          Pipeline ({crm.pipeline.opportunities_count})
        </h3>
        <div className="mb-4">
          <div className="text-2xl font-bold text-gray-900">${crm.pipeline.total_value.toLocaleString('en-US', {maximumFractionDigits: 0})}</div>
          <div className="text-sm text-gray-600">Total pipeline value</div>
        </div>
        <div className="space-y-2">
          {Object.entries(crm.pipeline.by_stage).map(([stage, data]) => (
            <div key={stage} className={`rounded-lg border p-3 ${STAGE_COLORS[stage]}`}>
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold capitalize">{stage}</div>
                  <div className="text-sm">{data.count} opportunity(ies)</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">${data.value.toLocaleString('en-US', {maximumFractionDigits: 0})}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Financial Summary */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-emerald-500" />
          Financial Summary
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <StatCard
            icon={FileText}
            label="Quotes Sent"
            value={crm.financial.quotes_sent}
            subtext={`${crm.financial.quotes_accepted} accepted`}
            color="blue"
          />
          <StatCard
            icon={Calendar}
            label="Invoices"
            value={crm.financial.invoices_issued}
            subtext={`${crm.financial.invoices_paid} paid`}
            color="emerald"
          />
        </div>
        <div className="space-y-3 bg-gray-50 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">Total Invoiced</span>
            <span className="font-semibold text-gray-900">${crm.financial.total_invoiced.toLocaleString('en-US', {maximumFractionDigits: 2})}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600">Total Paid</span>
            <span className="font-semibold text-emerald-600">${crm.financial.total_paid.toLocaleString('en-US', {maximumFractionDigits: 2})}</span>
          </div>
          <div className="border-t border-gray-200 pt-3 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700">Outstanding</span>
            <span className={`font-bold ${crm.financial.outstanding > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
              ${crm.financial.outstanding.toLocaleString('en-US', {maximumFractionDigits: 2})}
            </span>
          </div>
        </div>
      </div>

      {/* Communications Summary */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-blue-500" />
          Communications
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <StatCard
            icon={Mail}
            label="Emails"
            value={crm.communications.emails_sent + crm.communications.emails_received}
            subtext={`↓${crm.communications.emails_received} ↑${crm.communications.emails_sent}`}
            color="blue"
          />
          <StatCard
            icon={Phone}
            label="SMS"
            value={crm.communications.sms_sent + crm.communications.sms_received}
            subtext={`↓${crm.communications.sms_received} ↑${crm.communications.sms_sent}`}
            color="purple"
          />
        </div>
        {crm.contact_emails.length > 0 && (
          <div className="mb-4">
            <div className="text-sm font-medium text-gray-700 mb-2">Email Addresses</div>
            <div className="space-y-1">
              {crm.contact_emails.map((email, i) => (
                <div key={i} className="text-sm text-gray-600 flex items-center gap-2">
                  {email.is_primary && <span className="w-2 h-2 bg-blue-500 rounded-full"></span>}
                  <span>{email.email}</span>
                  {email.verified && <CheckCircle className="w-3 h-3 text-emerald-500" />}
                </div>
              ))}
            </div>
          </div>
        )}
        {crm.contact_phones.length > 0 && (
          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">Phone Numbers</div>
            <div className="space-y-1">
              {crm.contact_phones.map((phone, i) => (
                <div key={i} className="text-sm text-gray-600 flex items-center gap-2">
                  {phone.is_primary && <span className="w-2 h-2 bg-blue-500 rounded-full"></span>}
                  <span>{phone.phone}</span>
                  {phone.type && <span className="text-xs text-gray-500 capitalize">({phone.type})</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Recent Activity */}
      {crm.recent_activity.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Clock className="w-5 h-5 text-amber-500" />
            Recent Activity
          </h3>
          <div className="space-y-3">
            {crm.recent_activity.map((activity) => (
              <div key={activity.id} className="flex gap-3 pb-3 border-b border-gray-100 last:border-0 last:pb-0">
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 text-xs font-semibold text-gray-600">
                  {activity.activity_type.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">{activity.summary}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {activity.activity_type.replace(/_/g, ' ')} {activity.actor && `by ${activity.actor}`}
                  </div>
                  {activity.created_at && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      {new Date(activity.created_at).toLocaleDateString()} {new Date(activity.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
