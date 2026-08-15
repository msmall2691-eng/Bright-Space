import { useState, useRef, useEffect } from 'react'
import { Plus, MoreHorizontal, Star, Trash2 } from 'lucide-react'
import { useSavedViews } from '../hooks/useSavedViews'

/**
 * Deep, key-order-insensitive equality for saved-view config blobs.
 *
 * Configs are plain JSON (strings/numbers/booleans/null, arrays, nested
 * objects — e.g. the Clients config carries a `columns` array). A shallow
 * `===` over Object.keys reported those permanently dirty, so we recurse:
 * arrays compare element-wise in order, objects compare by key set regardless
 * of key order, primitives by Object.is.
 */
function sameConfig(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameConfig(v, b[i]))
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameConfig(a[k], b[k]))
}

/**
 * Attio-style view-tabs row for a list page.
 *
 * Renders a horizontal tab row: the "no view" default tab first, then one tab
 * per saved view (default view first — the hook sorts), then a trailing "+"
 * that opens an inline naming input (Enter saves, Escape cancels). The active
 * saved-view tab grows a "⋯" menu (make/remove default, delete) and — when the
 * page's filters have drifted from the stored config — a blue dot plus an
 * inline `Update "<name>"` affordance. The parent owns the actual list state;
 * this component only reads `currentConfig` and calls `onApply(config)` to
 * push a chosen view's settings back up.
 *
 * No container border here on purpose: every call site embeds the bar inside
 * a toolbar row whose neighbors already carry their own borders (Properties
 * even has a bordered type-tabs row directly beneath), so a `border-b` on the
 * bar would double up.
 *
 * Props (unchanged contract):
 *   entityType    – e.g. "client" (namespaces the views)
 *   currentConfig – serializable snapshot of the page's current filters/layout
 *   onApply       – (config) => void, applies a view's config to the page
 *   defaultLabel  – label for the "no view" tab (e.g. "All clients")
 */
export default function SavedViewsBar({ entityType, currentConfig, onApply, defaultLabel = 'All' }) {
  const { views, loaded, createView, updateView, deleteView } = useSavedViews(entityType)
  const [activeId, setActiveId] = useState(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuLeft, setMenuLeft] = useState(0)
  const wrapRef = useRef(null)
  const appliedDefault = useRef(false)

  // Apply the user's default view once, on first load.
  useEffect(() => {
    if (!loaded || appliedDefault.current) return
    appliedDefault.current = true
    const def = views.find(v => v.is_default)
    if (def) { setActiveId(def.id); onApply(def.config || {}) }
  }, [loaded, views, onApply])

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const active = views.find(v => v.id === activeId) || null
  const dirty = active ? !sameConfig(active.config || {}, currentConfig || {}) : false

  const selectDefault = () => { setActiveId(null); onApply({}); setMenuOpen(false) }
  const selectView = (v) => { setActiveId(v.id); onApply(v.config || {}); setMenuOpen(false) }

  const saveNew = async () => {
    const n = name.trim()
    if (!n) return
    const v = await createView(n, currentConfig, false)
    setActiveId(v.id); setNaming(false); setName('')
  }

  // Anchor the ⋯ dropdown against the outer (non-scrolling) wrapper: absolute
  // children of the overflow-x-auto scroller would be clipped vertically.
  const toggleMenu = (e) => {
    const btn = e.currentTarget.getBoundingClientRect()
    const wrap = wrapRef.current.getBoundingClientRect()
    setMenuLeft(Math.max(0, Math.min(btn.left - wrap.left, wrap.width - 190)))
    setMenuOpen(o => !o)
  }

  // h-8 + min-h-0 opts these compact desktop tabs out of the 44px base rule.
  const tabBase = 'h-8 min-h-0 px-1 mx-2 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors'
  const tabActive = 'text-ink shadow-[inset_0_-2px_0_var(--ink)]'
  const tabIdle = 'text-ink-3 hover:text-ink-2'

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <div className="flex items-center overflow-x-auto scrollbar-thin">
        {/* "No view" default tab */}
        <button type="button" aria-pressed={!activeId} onClick={selectDefault}
          className={`${tabBase} ${!activeId ? tabActive : tabIdle}`}>
          {defaultLabel}
        </button>

        {views.map(v => {
          const isActive = v.id === activeId
          return (
            <span key={v.id} className="flex items-center shrink-0">
              <button type="button" aria-pressed={isActive} onClick={() => selectView(v)}
                className={`${tabBase} ${isActive ? tabActive : tabIdle} ${isActive ? 'mr-0.5' : ''}`}>
                <span className="max-w-[180px] truncate inline-block align-middle">{v.name}</span>
                {isActive && dirty && (
                  <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-blue-500 align-middle" title="Unsaved changes" />
                )}
              </button>
              {/* Per-view management, only on the active tab */}
              {isActive && (
                <button type="button" aria-label={`Options for view "${v.name}"`} aria-haspopup="menu"
                  aria-expanded={menuOpen} onClick={toggleMenu}
                  className="h-8 min-h-0 px-0.5 mr-1 rounded text-ink-3 hover:text-ink-2">
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
              )}
            </span>
          )
        })}

        {/* Push the drifted filters into the active view */}
        {active && dirty && (
          <button type="button" onClick={() => updateView(active.id, { config: currentConfig })}
            className="h-8 min-h-0 px-1 mx-2 text-[12px] font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap shrink-0">
            Update “{active.name}”
          </button>
        )}

        {/* Trailing "+": save the current filters as a new view */}
        {naming ? (
          <span className="flex items-center gap-1.5 mx-2 shrink-0">
            <input autoFocus value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveNew(); if (e.key === 'Escape') { setNaming(false); setName('') } }}
              placeholder="View name…"
              className="w-36 bg-bg border border-hairline rounded-md px-2 py-1 text-[12px] text-ink placeholder-ink-3 focus:outline-none focus:border-blue-400" />
            <button type="button" onClick={saveNew}
              className="min-h-0 px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-medium">Save</button>
          </span>
        ) : (
          <button type="button" title="Save current filters as a view" aria-label="Save current filters as a new view"
            onClick={() => { setNaming(true); setName('') }}
            className="h-8 min-h-0 px-1 mx-2 rounded text-ink-3 hover:text-ink-2 shrink-0">
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ⋯ menu for the active saved view */}
      {menuOpen && active && (
        <div role="menu" style={{ left: menuLeft }}
          className="absolute z-30 top-full mt-1 min-w-[180px] bg-panel border border-hairline rounded-lg shadow-lg py-1">
          <button type="button" role="menuitem"
            onClick={() => { updateView(active.id, { is_default: !active.is_default }); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-ink-2 hover:bg-bg-2 flex items-center gap-2">
            <Star className={`w-3.5 h-3.5 ${active.is_default ? 'fill-amber-400 text-amber-400' : 'text-ink-3'}`} />
            {active.is_default ? 'Remove default' : 'Make default'}
          </button>
          <button type="button" role="menuitem"
            onClick={() => { deleteView(active.id); setActiveId(null); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-red-600 hover:bg-bg-2 flex items-center gap-2">
            <Trash2 className="w-3.5 h-3.5" /> Delete view
          </button>
        </div>
      )}
    </div>
  )
}
