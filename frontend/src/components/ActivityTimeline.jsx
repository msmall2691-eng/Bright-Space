import { useState, useEffect } from 'react'
import { get } from '../api'
import {
  Mail, MessageSquare, Phone, Calendar, FileText, Receipt,
  TrendingUp, CheckCircle, AlertCircle, Loader, Filter
} from 'lucide-react'

const ACTIVITY_ICONS = {
  email_sent: Mail,
  email_received: Mail,
  sms_sent: MessageSquare,
  sms_received: MessageSquare,
  call_logged: Phone,
  job_created: Calendar,
  job_started: Calendar,
  job_completed: CheckCircle,
  quote_sent: FileText,
  quote_accepted: CheckCircle,
  invoice_sent: Receipt,
  invoice_paid: CheckCircle,
  opportunity_created: TrendingUp,
  opportunity_won: CheckCircle,
  opportunity_lost: AlertCircle,
  note_added: FileText,
}

const ACTIVITY_COLORS = {
  email_sent: 'text-blue-600 bg-blue-50',
  email_received: 'text-blue-600 bg-blue-50',
  sms_sent: 'text-purple-600 bg-purple-50',
  sms_received: 'text-purple-600 bg-purple-50',
  call_logged: 'text-green-600 bg-green-50',
  job_created: 'text-yellow-600 bg-yellow-50',
  job_completed: 'text-emerald-600 bg-emerald-50',
  quote_sent: 'text-orange-600 bg-orange-50',
  quote_accepted: 'text-emerald-600 bg-emerald-50',
  invoice_sent: 'text-cyan-600 bg-cyan-50',
  invoice_paid: 'text-green-600 bg-green-50',
  opportunity_created: 'text-pink-600 bg-pink-50',
  opportunity_won: 'text-emerald-600 bg-emerald-50',
  opportunity_lost: 'text-red-600 bg-red-50',
  note_added: 'text-gray-600 bg-gray-50',
}

function TimelineItem({ activity, isFirst, isLast }) {
  const Icon = ACTIVITY_ICONS[activity.activity_type] || FileText
  const colorClass = ACTIVITY_COLORS[activity.activity_type] || 'text-gray-600 bg-gray-50'
  const [bg, fg] = colorClass.split(' ')

  const date = new Date(activity.created_at)
  const today = new Date()
  const isToday = date.toDateString() === today.toDateString()
  const isYesterday = new Date(date.getTime() + 86400000).toDateString() === today.toDateString()

  let dateStr = date.toLocaleDateString()
  if (isToday) dateStr = 'Today'
  else if (isYesterday) dateStr = 'Yesterday'

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="relative">
      {/* Timeline line */}
      {!isLast && (
        <div className="absolute left-6 top-14 bottom-0 w-0.5 bg-gray-200"></div>
      )}

      {/* Item */}
      <div className="flex gap-4">
        {/* Icon circle */}
        <div className={`w-12 h-12 rounded-full ${bg} ${fg} flex items-center justify-center flex-shrink-0 mt-1 relative z-10`}>
          <Icon className="w-5 h-5" />
        </div>

        {/* Content */}
        <div className="flex-1 pt-2 pb-6 min-w-0">
          <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 text-sm">{activity.summary}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {activity.activity_type.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}
                </div>
              </div>
              {activity.actor && (
                <div className="text-xs text-gray-500 font-medium shrink-0">{activity.actor}</div>
              )}
            </div>
            <div className="text-xs text-gray-400 flex items-center gap-2">
              <span>{dateStr}</span>
              <span className="text-gray-300">·</span>
              <span>{timeStr}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ActivityTimeline({ clientId, opportunityId, limit = 50, entityType = null }) {
  const [activities, setActivities] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    loadActivities()
  }, [clientId, opportunityId, filter])

  const loadActivities = async () => {
    setLoading(true)
    try {
      let url = '/api/activities?'
      const params = new URLSearchParams()

      if (clientId) params.append('client_id', clientId)
      if (opportunityId) params.append('opportunity_id', opportunityId)
      if (limit) params.append('limit', limit)
      if (filter !== 'all') params.append('activity_type', filter)

      const data = await get('/api/activities?' + params.toString())
      setActivities(data || [])
    } catch (error) {
      console.error('Error loading activities:', error)
      setActivities([])
    } finally {
      setLoading(false)
    }
  }

  const groupedActivities = activities.reduce((acc, activity) => {
    const date = new Date(activity.created_at).toDateString()
    if (!acc[date]) acc[date] = []
    acc[date].push(activity)
    return acc
  }, {})

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  if (activities.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-400 mb-2">
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
        </div>
        <p className="text-gray-600 text-sm">No activities yet</p>
      </div>
    )
  }

  const filterOptions = [
    { value: 'all', label: 'All Activities' },
    { value: 'email_sent', label: 'Emails Sent' },
    { value: 'email_received', label: 'Emails Received' },
    { value: 'sms_sent', label: 'SMS Sent' },
    { value: 'quote_sent', label: 'Quotes Sent' },
    { value: 'invoice_sent', label: 'Invoices Sent' },
    { value: 'job_completed', label: 'Jobs Completed' },
    { value: 'opportunity_won', label: 'Opportunities Won' },
  ]

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        <Filter className="w-4 h-4 text-gray-400 flex-shrink-0" />
        {filterOptions.map(option => (
          <button
            key={option.value}
            onClick={() => setFilter(option.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
              filter === option.value
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div className="space-y-8">
        {Object.entries(groupedActivities).reverse().map(([date, dayActivities], dateIndex, arr) => (
          <div key={date}>
            {/* Date divider */}
            {dateIndex === 0 && (
              <div className="text-xs font-semibold text-gray-500 mb-4 uppercase tracking-wide">
                {new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </div>
            )}

            {/* Activities for this day */}
            <div className="space-y-0">
              {dayActivities.map((activity, i) => (
                <TimelineItem
                  key={activity.id}
                  activity={activity}
                  isFirst={i === 0}
                  isLast={dateIndex === arr.length - 1 && i === dayActivities.length - 1}
                />
              ))}
            </div>

            {/* Next day divider */}
            {dateIndex < arr.length - 1 && (
              <div className="text-xs font-semibold text-gray-500 my-4 uppercase tracking-wide">
                {new Date(Object.keys(groupedActivities).reverse()[dateIndex + 1]).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
