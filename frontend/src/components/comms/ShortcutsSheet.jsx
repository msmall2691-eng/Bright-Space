import { useEffect } from 'react'
import { Kbd } from './primitives'

const KEYS = [
  [['j'], 'Next conversation'],
  [['k'], 'Previous conversation'],
  [['e'], 'Mark the open thread done'],
  [['/'], 'Search'],
  [['⌘', 'Enter'], 'Send the reply'],
  [['Esc'], 'Leave the search box or composer'],
  [['?'], 'This list'],
]

/** The `?` sheet — what the page's docstring claimed existed for a long time
 *  and did not.
 *
 *  Quiet by the house rules: a hairline panel on a dimmed backdrop, plain ink
 *  text, no tinted header and no accent fill. The one primary button is Close,
 *  and the whole thing renders nothing when shut, so it costs no layout. */
export function ShortcutsSheet({ open, onClose }) {
  // While this is up it owns the keyboard: useInboxShortcuts is disabled, so
  // closing is this component's job. Both keys, because a sheet opened with `?`
  // that cannot be closed with `?` is a small lie about how it works.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); onClose?.() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const mod = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac')
    ? '⌘' : 'Ctrl'
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center p-4"
      role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
      onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative w-full max-w-xs rounded-lg border border-hairline bg-panel p-4 shadow-lg"
        onClick={e => e.stopPropagation()}>
        <h2 className="mb-3 text-[13px] font-semibold text-ink">Keyboard</h2>
        <dl className="space-y-2">
          {KEYS.map(([keys, label]) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <dt className="text-[12px] text-ink-2">{label}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {keys.map(k => <Kbd key={k}>{k === '⌘' ? mod : k}</Kbd>)}
              </dd>
            </div>
          ))}
        </dl>
        <button onClick={onClose}
          className="mt-4 w-full rounded-md border border-hairline-2 bg-panel py-2 text-[12px] font-medium text-ink-2 transition-colors hover:bg-bg-2">
          Close
        </button>
      </div>
    </div>
  )
}
