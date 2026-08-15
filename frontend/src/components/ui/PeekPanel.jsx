import { useEffect, useRef } from 'react'
import { X, ArrowUpRight, ChevronUp, ChevronDown } from 'lucide-react'

/**
 * PeekPanel — the record peek: a right-side slide-over for previewing a
 * record without leaving the list (Attio/Twenty pattern), so a look at a
 * client no longer costs a navigation and your scroll position.
 *
 *   <PeekPanel open onClose={…} title={<…/>} onExpand={…}
 *     onPrev={…} onNext={…} hasPrev hasNext>…body…</PeekPanel>
 *
 * Esc closes. ↑/↓ move to the previous/next record when onPrev/onNext are
 * provided (ignored while typing in an input). "Open" (onExpand) goes to the
 * record's full page. Renders nothing when `open` is false.
 */
export default function PeekPanel({
  open,
  onClose,
  onExpand,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  title,
  children,
}) {
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowUp' && onPrev && hasPrev) { e.preventDefault(); onPrev() }
      else if (e.key === 'ArrowDown' && onNext && hasNext) { e.preventDefault(); onNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, onPrev, onNext, hasPrev, hasNext])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <>
      {/* Click-away catcher — transparent; the list stays visible behind. */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-hairline-2 bg-panel shadow-glass-lg outline-none lg:inset-y-2 lg:right-2 lg:rounded-lg lg:border"
      >
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline pl-4 pr-2">
          <div className="min-w-0 flex-1">{title}</div>
          {(onPrev || onNext) && (
            <>
              <button
                onClick={onPrev}
                disabled={!hasPrev}
                title="Previous (↑)"
                className="flex h-7 w-7 min-h-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2 disabled:opacity-30"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                onClick={onNext}
                disabled={!hasNext}
                title="Next (↓)"
                className="flex h-7 w-7 min-h-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2 disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <div className="mx-1 h-4 w-px bg-hairline-2" />
            </>
          )}
          {onExpand && (
            <button
              onClick={onExpand}
              title="Open full page"
              className="flex h-7 min-h-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink-2 transition-colors hover:bg-bg-2 hover:text-ink"
            >
              Open <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            title="Close (esc)"
            className="flex h-7 w-7 min-h-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </aside>
    </>
  )
}
