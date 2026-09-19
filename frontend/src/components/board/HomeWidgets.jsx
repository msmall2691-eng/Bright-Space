import { useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'

/**
 * The customizable widget zone on Home — the owner asked to arrange the
 * "little boxes" (quick actions, notes, the Nova chat) to her own taste.
 *
 * Each child is a self-contained widget card; this only wraps them with a
 * drag handle and reorders them. Order persists to localStorage, per device —
 * the same way the rest of Home persists its layout state (the cleared-set and
 * the folded groups), and matching the page's own "saved on this device" note.
 *
 * Dependency-free on purpose: native HTML5 drag for the mouse (gated to the
 * grip so a click inside a widget — typing a note, tapping an action — never
 * starts a drag), and Arrow keys on the focused grip for keyboard reorder, so
 * it's operable without a pointer. No dnd library added to a plain-JSX app for
 * three tiles.
 */
const ORDER_KEY = 'brightbase_home_widgets_order'

function loadOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null')
    return Array.isArray(v) ? v.filter(k => typeof k === 'string') : null
  } catch { return null }
}
function saveOrder(order) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)) } catch { /* per-device nicety; fine to drop */ }
}

// Reconcile a saved order against the widgets that actually exist this render:
// keep the saved order for keys we still have, drop keys for a widget that's
// gone, and append any new key (a widget added in a later release) at the end.
// So a stale saved order can never hide a widget or point at a dead one.
export function reconcile(saved, keys) {
  if (!saved || !saved.length) return keys
  const known = new Set(keys)
  const kept = saved.filter(k => known.has(k))
  const seen = new Set(kept)
  const appended = keys.filter(k => !seen.has(k))
  return [...kept, ...appended]
}

export default function HomeWidgets({ items }) {
  const keys = useMemo(() => items.map(i => i.key), [items])
  const keySig = keys.join('|')
  const [order, setOrder] = useState(() => reconcile(loadOrder(), keys))
  const [dragKey, setDragKey] = useState(null)
  const [overKey, setOverKey] = useState(null)
  const armed = useRef(false)   // a drag may only begin from a grip mousedown

  // Keep the order valid if the set of available widgets changes.
  useEffect(() => { setOrder(prev => reconcile(prev, keys)) }, [keySig]) // eslint-disable-line react-hooks/exhaustive-deps

  const nodeByKey = useMemo(() => Object.fromEntries(items.map(i => [i.key, i])), [items])

  // Move `key` to sit just before `target` (or to the end when target is null).
  const move = (key, target) => {
    setOrder(prev => {
      if (key === target) return prev
      const next = prev.filter(k => k !== key)
      const at = target == null ? next.length : next.indexOf(target)
      next.splice(at < 0 ? next.length : at, 0, key)
      saveOrder(next)
      return next
    })
  }

  // Keyboard reorder: swap the focused tile with its neighbour.
  const nudge = (key, dir) => {
    setOrder(prev => {
      const i = prev.indexOf(key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      saveOrder(next)
      return next
    })
  }

  if (!items.length) return null

  return (
    <div className="grid grid-cols-1 items-start gap-4 shell:grid-cols-2" data-testid="home-widgets">
      {order.map(key => {
        const item = nodeByKey[key]
        if (!item) return null
        const isDragging = dragKey === key
        const isOver = overKey === key && dragKey && dragKey !== key
        return (
          <div
            key={key}
            data-widget={key}
            draggable
            onDragStart={e => {
              if (!armed.current) { e.preventDefault(); return }
              setDragKey(key)
              e.dataTransfer.effectAllowed = 'move'
              try { e.dataTransfer.setData('text/plain', key) } catch { /* some browsers restrict this */ }
            }}
            onDragEnd={() => { armed.current = false; setDragKey(null); setOverKey(null) }}
            onDragOver={e => { if (dragKey) { e.preventDefault(); setOverKey(key) } }}
            onDrop={e => {
              e.preventDefault()
              if (dragKey && dragKey !== key) move(dragKey, key)
              setDragKey(null); setOverKey(null)
            }}
            className={`group/tile relative rounded-2xl transition ${isDragging ? 'opacity-50' : ''} ${
              isOver ? 'ring-2 ring-indigo-400 ring-offset-2 ring-offset-bg' : ''
            }`}
          >
            {item.node}
            {/* Grip sits over the widget's own leading icon (non-interactive),
                so it never covers a header action. Shown on hover/focus. */}
            <button
              type="button"
              aria-label={`Reorder ${item.label} — use arrow keys`}
              title="Drag to reorder"
              onMouseDown={() => { armed.current = true }}
              onMouseUp={() => { armed.current = false }}
              onKeyDown={e => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); nudge(key, -1) }
                else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); nudge(key, +1) }
              }}
              className="absolute left-1 top-2 grid h-6 w-6 cursor-grab place-items-center rounded-md text-ink-3 opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 active:cursor-grabbing group-hover/tile:opacity-100"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
