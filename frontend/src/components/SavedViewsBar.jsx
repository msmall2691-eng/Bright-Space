import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Star, Trash2, Plus, Check } from 'lucide-react'
import { useSavedViews } from '../hooks/useSavedViews'

/** Shallow equality for the small flat config objects list pages persist. */
function sameConfig(a, b) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {})
  if (ka.length !== kb.length) return false
  return ka.every(k => a[k] === b[k])
}

/**
 * Twenty-style saved-views switcher for a list page.
 *
 * Shows the active view name with a dropdown to switch between saved views,
 * star one as the default, delete, save the current filters as a new view, or
 * update the active view when its filters have drifted. The parent owns the
 * actual list state; this component only reads `currentConfig` and calls
 * `onApply(config)` to push a chosen view's settings back up.
 *
 * Props:
 *   entityType    – e.g. "client" (namespaces the views)
 *   currentConfig – serializable snapshot of the page's current filters/layout
 *   onApply       – (config) => void, applies a view's config to the page
 *   defaultLabel  – label shown when no saved view is active (e.g. "All clients")
 */
export default function SavedViewsBar({ entityType, currentConfig, onApply, defaultLabel = 'All' }) {
  const { views, loaded, createView, updateView, deleteView } = useSavedViews(entityType)
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef(null)
  const appliedDefault = useRef(false)

  // Apply the user's default view once, on first load.
  useEffect(() => {
    if (!loaded || appliedDefault.current) return
    appliedDefault.current = true
    const def = views.find(v => v.is_default)
    if (def) { setActiveId(def.id); onApply(def.config || {}) }
  }, [loaded, views, onApply])

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setNaming(false) } }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const active = views.find(v => v.id === activeId) || null
  const dirty = active ? !sameConfig(active.config, currentConfig) : false

  const applyView = (v) => { setActiveId(v.id); onApply(v.config || {}); setOpen(false) }

  const saveNew = async () => {
    const n = name.trim()
    if (!n) return
    const v = await createView(n, currentConfig, false)
    setActiveId(v.id); setNaming(false); setName(''); setOpen(false)
  }

  const label = active ? active.name : defaultLabel

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 bg-bg-2 hover:bg-bg-2 text-ink-2 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors border border-hairline">
        <span className="max-w-[160px] truncate">{label}</span>
        {dirty && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" title="Unsaved changes" />}
        <ChevronDown className="w-3.5 h-3.5 text-ink-3" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 left-0 min-w-[240px] bg-panel border border-hairline rounded-lg shadow-lg py-1">
          {/* "All" / reset to no view */}
          <button type="button" onClick={() => { setActiveId(null); onApply({}); setOpen(false) }}
            className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-bg-2 flex items-center justify-between ${!activeId ? 'font-semibold text-ink' : 'text-ink-2'}`}>
            <span>{defaultLabel}</span>
            {!activeId && <Check className="w-3.5 h-3.5 text-blue-500" />}
          </button>

          {views.length > 0 && <div className="my-1 border-t border-hairline" />}

          {views.map(v => (
            <div key={v.id}
              className={`group flex items-center gap-1 px-2 py-1 hover:bg-bg-2 rounded ${v.id === activeId ? 'text-ink' : 'text-ink-2'}`}>
              <button type="button" onClick={() => applyView(v)}
                className="flex-1 text-left px-1 py-0.5 text-[12px] truncate">
                <span className={v.id === activeId ? 'font-semibold' : ''}>{v.name}</span>
              </button>
              <button type="button" title={v.is_default ? 'Default view' : 'Set as default'}
                onClick={() => updateView(v.id, { is_default: !v.is_default })}
                className="p-1 rounded hover:bg-panel">
                <Star className={`w-3.5 h-3.5 ${v.is_default ? 'fill-amber-400 text-amber-400' : 'text-ink-3'}`} />
              </button>
              <button type="button" title="Delete view"
                onClick={() => { deleteView(v.id); if (v.id === activeId) setActiveId(null) }}
                className="p-1 rounded hover:bg-panel opacity-0 group-hover:opacity-100 transition-opacity">
                <Trash2 className="w-3.5 h-3.5 text-ink-3 hover:text-red-500" />
              </button>
            </div>
          ))}

          <div className="my-1 border-t border-hairline" />

          {/* Update the active view to the current filters (when drifted) */}
          {active && dirty && (
            <button type="button"
              onClick={() => { updateView(active.id, { config: currentConfig }); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-ink-2 hover:bg-bg-2 flex items-center gap-2">
              <Check className="w-3.5 h-3.5 text-blue-500" /> Update “{active.name}”
            </button>
          )}

          {/* Save current filters as a new view */}
          {naming ? (
            <div className="px-2 py-1.5 flex items-center gap-1.5">
              <input autoFocus value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveNew(); if (e.key === 'Escape') { setNaming(false); setName('') } }}
                placeholder="View name…"
                className="flex-1 bg-bg border border-hairline rounded-md px-2 py-1 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400" />
              <button type="button" onClick={saveNew}
                className="px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-medium">Save</button>
            </div>
          ) : (
            <button type="button" onClick={() => { setNaming(true); setName('') }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-ink-2 hover:bg-bg-2 flex items-center gap-2">
              <Plus className="w-3.5 h-3.5" /> Save current as view…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
