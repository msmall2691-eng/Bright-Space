/** Bottom-right toast stack used across Settings tabs. Pure props-in —
 *  the parent owns the {id, type, message} array; this just renders it. */
export default function Toast({ toasts }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-lg border pointer-events-auto
            ${t.type === 'success' ? 'bg-panel border-hairline text-ink' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${t.type === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {t.message}
        </div>
      ))}
    </div>
  )
}
