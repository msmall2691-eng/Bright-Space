import { useState, useEffect } from 'react'
import { subscribe } from '../../utils/toastBus'

// Renders toasts pushed onto the global bus (utils/toastBus). Mount once near
// the app root. Visuals match useToast()'s container so app-wide error toasts
// look identical to the per-page success toasts pages already raise.

const VARIANTS = {
  success: 'bg-emerald-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-zinc-800 text-white',
}

// Errors linger a touch longer than the 3s success toasts — a failure the user
// needs to read and act on shouldn't disappear as fast as a "Saved ✓".
const TTL = { error: 6000, success: 3000, info: 4000 }

export default function GlobalToasts() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    return subscribe((t) => {
      setToasts(prev => [...prev, t])
      const ttl = TTL[t.variant] ?? 4000
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), ttl)
    })
  }, [])

  if (!toasts.length) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] flex flex-col gap-2 max-w-[90vw]">
      {toasts.map(t => (
        <div
          key={t.id}
          role="status"
          onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
          className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium cursor-pointer ${VARIANTS[t.variant] || VARIANTS.info} animate-fade-in`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
