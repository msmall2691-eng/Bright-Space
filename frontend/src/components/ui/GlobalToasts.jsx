import { useState, useEffect, useCallback } from 'react'
import { subscribe } from '../../utils/toastBus'

// Renders toasts pushed onto the global bus (utils/toastBus). Mounted once at
// the app root (main.jsx) — the single toast surface for the whole app; every
// page-level useToast()/bespoke Toast component has been migrated onto this
// bus (audit: 4 toast implementations in 3 screen positions consolidated
// into 1). Visuals + action-button support match the old useToast() hook's
// container so migrating a caller was a drop-in swap.

const VARIANTS = {
  success: 'bg-emerald-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-ink text-bg',
}

// Errors linger a touch longer than the 3s success toasts — a failure the user
// needs to read and act on shouldn't disappear as fast as a "Saved ✓". A toast
// with an action button holds longest — the user needs time to actually click it.
const TTL = { error: 6000, success: 3000, info: 4000 }
const TTL_WITH_ACTION = 8000

export default function GlobalToasts() {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  useEffect(() => {
    return subscribe((t) => {
      setToasts(prev => [...prev, t])
      const ttl = t.action ? TTL_WITH_ACTION : (TTL[t.variant] ?? 4000)
      setTimeout(() => dismiss(t.id), ttl)
    })
  }, [dismiss])

  if (!toasts.length) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] flex flex-col gap-2 max-w-[90vw]">
      {toasts.map(t => (
        <div
          key={t.id}
          role="status"
          onClick={() => dismiss(t.id)}
          className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium flex items-center gap-3 cursor-pointer ${VARIANTS[t.variant] || VARIANTS.info} animate-fade-in`}
        >
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                try { t.action.onClick() } finally { dismiss(t.id) }
              }}
              className="px-2.5 py-1 rounded-md bg-white/20 hover:bg-white/30 text-white text-xs font-semibold whitespace-nowrap"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
