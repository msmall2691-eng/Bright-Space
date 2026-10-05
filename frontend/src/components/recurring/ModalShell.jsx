import { X } from 'lucide-react'

export default function ModalShell({ title, onClose, wide = false, children }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center sm:justify-center p-0 sm:p-4">
      <div className={`w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} bg-panel rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[92dvh]`}>
        <div className="flex items-center justify-between bg-panel border-b border-hairline p-4">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="p-1.5 text-ink-3 hover:text-ink-2 hover:bg-bg-2 rounded" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain flex-1 p-4 sm:p-5 space-y-3">
          {children}
        </div>
      </div>
    </div>
  )
}

// ─── Series list row ─────────────────────────────────────────────────────
