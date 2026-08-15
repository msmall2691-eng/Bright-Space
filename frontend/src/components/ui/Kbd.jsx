/**
 * Kbd — a rendered keycap for shortcut hints ("⌘K"), Attio-style: a tiny
 * bordered key with a 1px inset bottom edge so it reads as physical. Used in
 * the sidebar Search/Ask AI rows and anywhere a shortcut is worth surfacing.
 */
export default function Kbd({ children, className = '' }) {
  return (
    <kbd
      className={`inline-flex h-[18px] min-h-0 min-w-[18px] items-center justify-center rounded-xs border border-hairline-2 bg-bg px-1 font-sans text-[10px] font-medium text-ink-3 shadow-[inset_0_-1px_0_var(--hairline-2)] ${className}`}
    >
      {children}
    </kbd>
  )
}
