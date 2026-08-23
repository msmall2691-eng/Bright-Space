/**
 * ErrorNote — the one error treatment: hairline card + red dot + plain
 * words (design language: attention is a quiet card, never a red-50
 * banner). Renders nothing when there's no message, so call sites can
 * pass error state straight in:
 *
 *   <ErrorNote>{error}</ErrorNote>
 */
export default function ErrorNote({ children, className = '' }) {
  if (!children) return null
  return (
    <div className={`flex items-start gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px] text-ink-2 ${className}`}>
      <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}
