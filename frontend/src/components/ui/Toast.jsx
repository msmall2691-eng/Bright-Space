import { useState, useCallback, useRef } from 'react'

const VARIANTS = {
  success: 'bg-emerald-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-zinc-800 text-white',
}

export function useToast() {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)

  const show = useCallback((message, variant = 'info') => {
    const id = ++idRef.current
    setToasts(prev => [...prev, { id, message, variant }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000)
  }, [])

  const toast = {
    success: (msg) => show(msg, 'success'),
    error: (msg) => show(msg, 'error'),
    info: (msg) => show(msg, 'info'),
  }

  function ToastContainer() {
    if (!toasts.length) return null
    return (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium ${VARIANTS[t.variant]} animate-fade-in`}>
            {t.message}
          </div>
        ))}
      </div>
    )
  }

  return { toast, ToastContainer }
}
