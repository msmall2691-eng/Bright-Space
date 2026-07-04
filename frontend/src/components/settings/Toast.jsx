/** Bottom-centered toast stack used across Settings tabs. Pure props-in —
 *  the parent owns the {id, type, message} array; this just renders it.
 *
 *  Positioned bottom-CENTER (not bottom-right) so it doesn't overlap the
 *  floating Ask AI widget in the bottom-right corner — the previous position
 *  hid Connecteam / integration error toasts behind the widget and left the
 *  operator with no way to read the diagnostic. Z-index sits above the widget
 *  so even if the two rectangles brush, the toast wins. Long errors wrap
 *  instead of overflowing so a Connecteam response body stays readable. */
export default function Toast({ toasts }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] flex flex-col gap-2 max-w-[min(90vw,42rem)] pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`flex items-start gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-lg border pointer-events-auto break-words whitespace-pre-wrap
            ${t.type === 'success' ? 'bg-panel border-hairline text-ink' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${t.type === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="min-w-0">{t.message}</span>
        </div>
      ))}
    </div>
  )
}
