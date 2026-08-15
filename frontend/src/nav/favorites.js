import { useSyncExternalStore } from 'react'

/**
 * Sidebar favorites — pinned pages and records, persisted per-browser in
 * localStorage (no backend round-trip; this is a personal working set, and
 * losing it on a new device costs a few clicks to rebuild).
 *
 * Shape: [{ to, label, kind: 'page' | 'record' }]. Paths only — never store
 * anything sensitive in the label (it renders in the sidebar).
 */
const KEY = 'bb_favorites'
const EVENT = 'bb:favorites'
const MAX = 20

let cache = null

function read() {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    cache = Array.isArray(raw) ? raw.filter(f => f && f.to && f.label) : []
  } catch {
    cache = []
  }
  return cache
}

function write(list) {
  cache = list.slice(0, MAX)
  try { localStorage.setItem(KEY, JSON.stringify(cache)) } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVENT))
}

export function getFavorites() { return read() }
export function isFavorite(to) { return read().some(f => f.to === to) }

export function toggleFavorite({ to, label, kind = 'page' }) {
  const list = read()
  write(list.some(f => f.to === to) ? list.filter(f => f.to !== to) : [...list, { to, label, kind }])
}

function subscribe(cb) {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb) // other tabs
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

/** React hook — re-renders on any favorites change (this tab or another). */
export function useFavorites() {
  return useSyncExternalStore(subscribe, read, () => [])
}
