/**
 * Clients | Crew switch at the top of the Messages page's left panel — quiet
 * text tabs (no pills, no bubbles): active = ink, inactive = muted, unread =
 * small dot + plain bold number per the design language.
 */
export function InboxViewToggle({ view, onChange, clientUnread = 0, crewUnread = 0 }) {
  const Tab = ({ k, label, unread }) => (
    <button onClick={() => onChange(k)} aria-pressed={view === k}
      className={`inline-flex items-baseline gap-1.5 text-[15px] tracking-tight transition-colors ${
        view === k ? 'font-semibold text-ink' : 'font-medium text-ink-3 hover:text-ink-2'}`}>
      {label}
      {unread > 0 && (
        <span className="inline-flex items-center gap-1" aria-label={`${unread} unread`}>
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" aria-hidden="true" />
          <span className="text-[11px] font-bold tabular-nums text-ink">{unread > 99 ? '99+' : unread}</span>
        </span>
      )}
    </button>
  )
  return (
    <div className="flex items-center gap-4">
      <Tab k="inbox" label="Clients" unread={clientUnread} />
      <Tab k="crew" label="Crew" unread={crewUnread} />
    </div>
  )
}
