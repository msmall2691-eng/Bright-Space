import { useEffect, useState } from 'react'
import { CLIENT_COLUMNS } from '../components/clients/columns'
import { DEFAULT_CLIENT_COLUMNS } from '../components/clients/constants'

/** Owns the Clients page's "how do I want to see this list?" state:
 *  the current viewMode (cards vs table), the ordered list of
 *  visible column ids, and the derived `visibleColumns` array the
 *  table renders. Both viewMode and columns are persisted to
 *  localStorage as the session default; each saved view (Twenty-style)
 *  overrides them via `applyView(cfg)`.
 *
 *  Stale stored ids (renamed/removed column) are filtered against
 *  the current registry on read so a legacy value can't break
 *  rendering. Empty `columns` falls back to DEFAULT_CLIENT_COLUMNS.
 *
 *  `statusFilter` + `setStatusFilter` are threaded through so the
 *  hook can expose a complete `viewConfig` / `applyView` pair (the
 *  three pieces a saved view persists). */
export function useClientView({ statusFilter, setStatusFilter }) {
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('clients_view') || 'table')
  useEffect(() => { localStorage.setItem('clients_view', viewMode) }, [viewMode])

  const [columns, setColumns] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('clients_columns') || 'null')
      if (Array.isArray(saved)) return saved.filter(id => CLIENT_COLUMNS.some(c => c.id === id))
    } catch { /* fall through */ }
    return DEFAULT_CLIENT_COLUMNS
  })
  useEffect(() => { localStorage.setItem('clients_columns', JSON.stringify(columns)) }, [columns])

  const visibleColumns = columns.length
    ? columns.map(id => CLIENT_COLUMNS.find(c => c.id === id)).filter(Boolean)
    : CLIENT_COLUMNS.filter(c => DEFAULT_CLIENT_COLUMNS.includes(c.id))

  const viewConfig = { statusFilter, viewMode, columns }
  const applyView = (cfg) => {
    setStatusFilter(cfg.statusFilter ?? '')
    if (cfg.viewMode) setViewMode(cfg.viewMode)
    if (Array.isArray(cfg.columns)) setColumns(cfg.columns.filter(id => CLIENT_COLUMNS.some(c => c.id === id)))
  }

  return { viewMode, setViewMode, columns, setColumns, visibleColumns, viewConfig, applyView }
}
