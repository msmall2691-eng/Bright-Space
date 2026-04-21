import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { get } from '../api'
import { ArrowRight, Plus, Inbox, FileText, Calendar, FileCheck } from 'lucide-react'
import AgentWidget from '../components/AgentWidget'

const STAGE_CONFIG = {
  requests: {
    label: 'Requests',
    icon: Inbox,
    color: 'bg-amber-50 border-amber-200',
    badge: 'bg-amber-100 text-amber-700',
    status_colors: {
      new: 'bg-red-50 text-red-700',
      reviewed: 'bg-blue-50 text-blue-700',
      quoted: 'bg-purple-50 text-purple-700',
    }
  },
  quotes: {
    label: 'Quotes',
    icon: FileText,
    color: 'bg-purple-50 border-purple-200',
    badge: 'bg-purple-100 text-purple-700',
    status_colors: {
      draft: 'bg-zinc-50 text-zinc-700',
      sent: 'bg-blue-50 text-blue-700',
    }
  },
  jobs: {
    label: 'Jobs',
    icon: Calendar,
    color: 'bg-blue-50 border-blue-200',
    badge: 'bg-blue-100 text-blue-700',
    status_colors: {
      scheduled: 'bg-blue-50 text-blue-700',
      in_progress: 'bg-amber-50 text-amber-700',
    }
  },
  invoices: {
    label: 'Invoices',
    icon: FileCheck,
    color: 'bg-emerald-50 border-emerald-200',
    badge: 'bg-emerald-100 text-emerald-700',
    status_colors: {
      draft: 'bg-zinc-50 text-zinc-700',
      sent: 'bg-blue-50 text-blue-700',
      overdue: 'bg-red-50 text-red-700',
    }
  }
}

function WorkCard({ item, stage, onCardClick }) {
  const amount = item.amount ? `$${item.amount.toFixed(0)}` : '—'
  const age = item.age_days === 0 ? 'today' : item.age_days === 1 ? '1d' : `${item.age_days}d`
  const config = STAGE_CONFIG[stage]
  const statusColor = config.status_colors[item.status] || 'bg-zinc-50 text-zinc-700'

  return (
    <div
      onClick={() => onCardClick(item, stage)}
      className="bg-white border border-zinc-200 rounded-lg p-3 hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-zinc-900 truncate">{item.client_name}</p>
          {item.quote_number && <p className="text-xs text-zinc-500">{item.quote_number}</p>}
          {item.invoice_number && <p className="text-xs text-zinc-500">{item.invoice_number}</p>}
        </div>
        <span className="text-xs font-semibold text-emerald-600 shrink-0 ml-2">{amount}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded-full border ${statusColor}`}>
          {item.status}
        </span>
        <span className="text-xs text-zinc-500">{age}</span>
      </div>
    </div>
  )
}

export default function Work() {
  const navigate = useNavigate()
  const [board, setBoard] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const data = await get('/api/work/board')
        setBoard(data)
      } catch (err) {
        console.error('[Work]', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleCardClick = (item, stage) => {
    if (stage === 'requests') {
      navigate(`/clients/${item.client_id}`)
    } else if (stage === 'quotes') {
      navigate('/quoting', { state: { quoteId: item.id } })
    } else if (stage === 'jobs') {
      navigate('/scheduling')
    } else if (stage === 'invoices') {
      navigate('/invoicing', { state: { invoiceId: item.id } })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-zinc-500">Loading board...</p>
      </div>
    )
  }

  const stages = ['requests', 'quotes', 'jobs', 'invoices']

  return (
    <div className="flex h-full flex-col min-w-0 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">Work Board</h1>
        <p className="text-sm text-zinc-500 mt-1">All active pipeline stages at a glance</p>
      </div>

      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-6 min-w-min h-full">
          {stages.map(stage => {
            const config = STAGE_CONFIG[stage]
            const Icon = config.icon
            const stageData = board?.[stage] || []

            return (
              <div key={stage} className="flex flex-col w-80 shrink-0">
                <div className="flex items-center gap-2 mb-4">
                  <Icon className="w-5 h-5 text-zinc-600" />
                  <h2 className="font-semibold text-zinc-900">{config.label}</h2>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${config.badge}`}>
                    {stageData.length}
                  </span>
                </div>

                <div className={`flex-1 overflow-y-auto rounded-lg border ${config.color} p-3 space-y-2`}>
                  {stageData.length === 0 ? (
                    <p className="text-xs text-zinc-500 text-center py-8">No items</p>
                  ) : (
                    stageData.map(item => (
                      <WorkCard
                        key={`${stage}-${item.id}`}
                        item={item}
                        stage={stage}
                        onCardClick={handleCardClick}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <AgentWidget
        pageContext="work"
        prompts={[
          'Which requests need follow-up today?',
          'Show me quotes older than 7 days',
          'What jobs are scheduled this week?',
        ]}
      />
    </div>
  )
}
