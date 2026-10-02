import { useCallback, useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Modal — the one dialog shell for the office app.
 *
 * The app grew ~40 hand-rolled `fixed inset-0` modals, none of which trapped
 * focus, closed on Esc, restored focus on close, locked body scroll, or set an
 * ARIA dialog role. This is the single place all of that lives, so every modal
 * that adopts it becomes keyboard- and screen-reader-correct for free and looks
 * identical to the next one.
 *
 *   <Modal open onClose={close} title="Merge clients" maxWidth="md">
 *     …body…
 *     <Modal.Footer>…buttons…</Modal.Footer>   // optional helper
 *   </Modal>
 *
 * Behaviour: Esc and backdrop click close (unless dismissable=false — e.g. while
 * a save is in flight); Tab is trapped inside the panel and wraps; focus goes to
 * initialFocusRef (or the panel) on open and returns to the trigger on close;
 * body scroll is locked while open. Enter animation is a quiet fade+scale that
 * honours prefers-reduced-motion (see .bb-modal-* in index.css). No exit
 * animation — closing unmounts immediately, which keeps callers simple.
 *
 * Design language: bg-panel + border-hairline, one calm shadow, no tint.
 */
const MAX_W = {
  sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl', '2xl': 'max-w-2xl', '3xl': 'max-w-3xl',
}

const FOCUSABLE =
  'a[href],area[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),' +
  'button:not([disabled]),iframe,object,embed,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'

export default function Modal({
  open,
  onClose,
  title,
  titleRight,
  maxWidth = 'md',
  dismissable = true,
  initialFocusRef,
  ariaLabel,
  className = '',
  hideClose = false,
  children,
}) {
  const panelRef = useRef(null)
  const returnFocusRef = useRef(null)

  const close = useCallback(() => { if (dismissable) onClose?.() }, [dismissable, onClose])

  // Remember what had focus, focus into the panel, and lock body scroll.
  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement
    const panel = panelRef.current
    const target = initialFocusRef?.current
      || panel?.querySelector(FOCUSABLE)
      || panel
    // Defer a tick so the element exists and the browser doesn't fight us.
    const id = window.setTimeout(() => target?.focus?.(), 0)

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.clearTimeout(id)
      document.body.style.overflow = prevOverflow
      // Return focus to the trigger, if it's still in the document.
      const el = returnFocusRef.current
      if (el && document.contains(el)) el.focus?.()
    }
  }, [open, initialFocusRef])

  // Esc closes; Tab is trapped within the panel and wraps.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE))
        .filter(n => n.offsetParent !== null || n === document.activeElement)
      if (nodes.length === 0) { e.preventDefault(); panel.focus(); return }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  const labelledByTitle = typeof title === 'string' ? title : undefined

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 bb-backdrop-in" onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || labelledByTitle || 'Dialog'}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`bb-modal-in relative flex max-h-[90dvh] w-full ${MAX_W[maxWidth] || MAX_W.md} flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-2xl outline-hidden ${className}`}
      >
        {title != null && (
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-5 py-3.5">
            <div className="min-w-0 flex-1 text-[15px] font-bold leading-snug text-ink">{title}</div>
            <div className="flex shrink-0 items-center gap-2">
              {titleRight}
              {!hideClose && (
                <button type="button" onClick={close} title="Close (Esc)" aria-label="Close"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-bg-2 hover:text-ink-2">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </header>
        )}
        {children}
      </div>
    </div>
  )
}

/** Standard scrolling body — most modals want their content to scroll while the
 *  header/footer stay put. Optional; a modal can lay out its own body instead. */
Modal.Body = function ModalBody({ className = '', children }) {
  return <div className={`flex-1 overflow-y-auto overscroll-contain px-5 py-4 ${className}`}>{children}</div>
}

/** Standard footer row — right-aligned actions above the safe area. */
Modal.Footer = function ModalFooter({ className = '', children }) {
  return (
    <footer className={`flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-5 py-3.5 ${className}`}>
      {children}
    </footer>
  )
}
