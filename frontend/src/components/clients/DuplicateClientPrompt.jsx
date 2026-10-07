/**
 * The one "possible duplicate" prompt shown by every inline "+ New client"
 * affordance (Schedule, Property, Quoting) when the shared create helper finds
 * a match. Instead of blindly creating a second record, the operator is offered
 * the existing client ("Use this") or a deliberate "Create anyway".
 *
 * Design language: dot + word, hairline card, no filled pill/banner — "Use
 * this" is the quiet secondary button (the preferred path), "Create anyway" and
 * "Back" are tertiary text links. See brightbase-design-language.
 */
import { STATUS_DOT } from '../../theme/statusDots'
export default function DuplicateClientPrompt({
  duplicates = [],
  busy = false,
  onUseExisting,
  onCreateAnyway,
  onDismiss,
}) {
  if (!duplicates.length) return null
  return (
    <div className="rounded-lg border border-hairline bg-panel p-2.5 space-y-2" data-testid="duplicate-client-prompt">
      <div className="flex items-center gap-1.5 text-xs text-ink-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT.attention}`} aria-hidden />
        <span>
          {duplicates.length === 1 ? 'Possible duplicate' : `${duplicates.length} possible duplicates`}
          {' '}— already in your clients
        </span>
      </div>
      <div className="divide-y divide-hairline rounded-md border border-hairline">
        {duplicates.map(c => (
          <div key={c.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="min-w-0">
              <span className="block truncate text-sm text-ink font-medium">{c.name}</span>
              {(c.email || c.phone) && (
                <span className="block truncate text-[11px] text-ink-3">
                  {[c.email, c.phone].filter(Boolean).join(' · ')}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => onUseExisting?.(c)}
              disabled={busy}
              className="shrink-0 bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50"
            >
              Use this
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        {onDismiss ? (
          <button type="button" onClick={onDismiss} className="text-xs text-ink-3 hover:text-ink underline">
            Back
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => onCreateAnyway?.()}
          disabled={busy}
          className="text-xs text-ink-3 hover:text-ink underline disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create anyway'}
        </button>
      </div>
    </div>
  )
}
