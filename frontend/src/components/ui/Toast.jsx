import { useState, useCallback, useRef } from 'react'

const VARIANTS = {
  success: 'bg-emerald-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-ink text-bg',
}

// Toasts with an `action` button hold longer than plain ones so the user has
// time to actually click it; the plain 3s dismiss is too tight for an
// interactive prompt.
const DISMISS_MS = 3000
const DISMISS_MS_WITH_ACTION = 8000

export function useToast() {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)

  const show = useCallback((message, variant = 'info', opts = {}) => {
    const id = ++idRef.current
    const { action } = opts
    setToasts(prev => [...prev, { id, message, variant, action }])
    const ttl = action ? DISMISS_MS_WITH_ACTION : DISMISS_MS
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), ttl)
    return id
  }, [])

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = {
    success: (msg, opts) => show(msg, 'success', opts),
    error:   (msg, opts) => show(msg, 'error', opts),
    info:    (msg, opts) => show(msg, 'info', opts),
    dismiss,
  }

  function ToastContainer() {
    if (!toasts.length) return null
    return (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium flex items-center gap-3 ${VARIANTS[t.variant]} animate-fade-in`}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  try { t.action.onClick() } finally { dismiss(t.id) }
                }}
                className="ml-2 px-2.5 py-1 rounded-md bg-white/20 hover:bg-white/30 text-white text-xs font-semibold whitespace-nowrap"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    )
  }

  return { toast, ToastContainer }
}
