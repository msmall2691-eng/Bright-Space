/** Bottom-right stack of transient status toasts (success / error /
 *  info) used by the Invoicing page for save/send/mark-paid feedback.
 *  Fully controlled — parent owns the queue and the auto-dismiss
 *  timer; this component is purely presentational. */
export function Toast({ toasts }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium shadow-lg border pointer-events-auto
            ${t.type === 'success'
              ? 'bg-panel border-emerald-200 text-emerald-700'
              : t.type === 'error'
              ? 'bg-panel border-red-200 text-red-700'
              : 'bg-panel border-hairline text-ink-2'}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0
            ${t.type === 'success' ? 'bg-emerald-500' : t.type === 'error' ? 'bg-red-500' : 'bg-ink-3'}`} />
          {t.message}
        </div>
      ))}
    </div>
  )
}
