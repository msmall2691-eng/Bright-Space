import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { LayoutGrid, RefreshCw, GripVertical } from 'lucide-react'
import { get, patch } from '../api'

// Canonical opportunity pipeline (matches backend Opportunity.stage + the chips
// already used on the client profile / OpportunityLinker).
const STAGES = [
  { key: 'new',       label: 'New',       accent: 'border-amber-400',  dot: 'bg-amber-400' },
  { key: 'qualified', label: 'Qualified', accent: 'border-blue-400',   dot: 'bg-blue-400' },
  { key: 'quoted',    label: 'Quoted',    accent: 'border-purple-400', dot: 'bg-purple-400' },
  { key: 'won',       label: 'Won',       accent: 'border-emerald-400',dot: 'bg-emerald-400' },
  { key: 'lost',      label: 'Lost',      accent: 'border-red-400',    dot: 'bg-red-400' },
]
const STAGE_KEYS = STAGES.map(s => s.key)

const money = (n) => (n || n === 0)
  ? `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  : '—'

export default function Pipeline() {
  const [opps, setOpps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [dragId, setDragId] = useState(null)
  const [overStage, setOverStage] = useState(null)
  const [savingId, setSavingId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const rows = await get('/api/opportunities?limit=200')
      setOpps(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setError(e?.message || 'Failed to load pipeline')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Drag a card onto a column → optimistically move it, then persist the stage.
  // On failure, reload to snap back to the server's truth.
  async function moveTo(stage) {
    const id = dragId
    setOverStage(null); setDragId(null)
    if (!id) return
    const card = opps.find(o => o.id === id)
    if (!card || card.stage === stage || !STAGE_KEYS.includes(stage)) return

    const prev = card.stage
    setOpps(os => os.map(o => (o.id === id ? { ...o, stage } : o)))
    setSavingId(id)
    try {
      await patch(`/api/opportunities/${id}`, { stage })
    } catch {
      setOpps(os => os.map(o => (o.id === id ? { ...o, stage: prev } : o)))
      setError('Could not update stage — reverted.')
    } finally {
      setSavingId(null)
    }
  }

  const byStage = (s) => opps.filter(o => (o.stage || 'new') === s)
  const total = (rows) => rows.reduce((sum, o) => sum + (o.amount || 0), 0)

  return (
    <div className="p-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <LayoutGrid className="w-5 h-5 text-blue-500 shrink-0" />
          <h1 className="text-lg sm:text-xl font-bold text-ink tracking-tight">Pipeline</h1>
          <span className="text-xs text-ink-3 ml-1">{opps.length} {opps.length === 1 ? 'deal' : 'deals'}</span>
        </div>
        <button onClick={load}
          className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 border border-hairline px-3 py-1.5 rounded-lg text-sm transition-colors">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-ink-3 py-12 text-center">Loading pipeline…</div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {STAGES.map(stage => {
            const rows = byStage(stage.key)
            return (
              <div
                key={stage.key}
                onDragOver={(e) => { e.preventDefault(); setOverStage(stage.key) }}
                onDragLeave={() => setOverStage(s => (s === stage.key ? null : s))}
                onDrop={() => moveTo(stage.key)}
                className={`flex-1 min-w-[230px] rounded-xl border bg-bg-2/40 transition-colors
                  ${overStage === stage.key ? 'border-blue-400 bg-blue-500/5' : 'border-hairline'}`}
              >
                <div className={`flex items-center justify-between px-3 py-2 border-b-2 ${stage.accent}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${stage.dot}`} />
                    <span className="text-sm font-semibold text-ink">{stage.label}</span>
                    <span className="text-xs text-ink-3">{rows.length}</span>
                  </div>
                  <span className="text-xs font-medium text-ink-2">{money(total(rows))}</span>
                </div>

                <div className="p-2 space-y-2 min-h-[120px]">
                  {rows.length === 0 && (
                    <div className="text-[11px] text-ink-3 text-center py-6 select-none">Drop deals here</div>
                  )}
                  {rows.map(o => (
                    <div
                      key={o.id}
                      draggable
                      onDragStart={() => setDragId(o.id)}
                      onDragEnd={() => { setDragId(null); setOverStage(null) }}
                      className={`group bg-panel border border-hairline rounded-lg p-2.5 cursor-grab active:cursor-grabbing
                        hover:border-blue-300 transition-colors ${savingId === o.id ? 'opacity-60' : ''}
                        ${dragId === o.id ? 'ring-1 ring-blue-400' : ''}`}
                    >
                      <div className="flex items-start gap-1.5">
                        <GripVertical className="w-3.5 h-3.5 text-ink-3 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="min-w-0 flex-1">
                          <Link to={`/opportunities/${o.id}`}
                            className="text-[13px] font-medium text-ink hover:text-blue-500 truncate block">
                            {o.title || 'Untitled'}
                          </Link>
                          {o.client_name && (
                            <Link to={o.client_id ? `/clients/${o.client_id}` : '#'}
                              className="text-[11px] text-ink-3 hover:text-blue-500 truncate block">
                              {o.client_name}
                            </Link>
                          )}
                          <div className="text-[11px] font-semibold text-ink-2 mt-1">{money(o.amount)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
