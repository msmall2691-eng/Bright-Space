import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { iconChipClass } from './iconChip'
import RecordLink from '../RecordLink'

/**
 * RecordShell — the standard record-detail layout (Twenty-style).
 *
 * Every detail page (Request, Job, Quote, Opportunity, Property, Invoice) shares
 * the same shape: a back link, a header row (icon chip + title + subtitle +
 * status badge + actions), a main content column, and an optional right rail of
 * related-record cards. Centralizing it means one place controls the header,
 * spacing, and the related-records pattern — instead of each page hand-rolling
 * its own, which is the biggest source of the "pages feel inconsistent" gap.
 *
 * Props:
 *  - title, subtitle            — header text
 *  - icon, iconColor            — tinted chip (semantic key: blue/violet/…)
 *  - status                     — node rendered next to the title (e.g. StatusBadge)
 *  - actions                    — right-aligned header buttons
 *  - backTo / backLabel         — where the ← link goes (default: history back)
 *  - related                    — array of { label, items: [{type,id,label,meta}] }
 *                                 rendered as the right-rail related-record cards
 *  - children                   — the main content column
 */
export default function RecordShell({
  title, subtitle,
  icon: Icon, iconColor = 'blue',
  status, actions,
  backTo, backLabel = 'Back',
  related = [],
  children,
}) {
  const navigate = useNavigate()
  const goBack = () => (backTo ? navigate(backTo) : navigate(-1))

  return (
    <div className="flex-1 overflow-y-auto bg-bg" data-testid="record-shell">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-4 sm:py-5">
        {/* Back */}
        <button onClick={goBack}
          className="inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2 mb-3">
          <ArrowLeft className="w-3.5 h-3.5" /> {backLabel}
        </button>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
          <div className="flex items-center gap-3 min-w-0">
            {Icon && (
              <span className={`bb-icon-chip grid place-items-center w-11 h-11 rounded-xl shrink-0 ${iconChipClass(iconColor)}`}>
                <Icon className="w-5 h-5" />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-xl font-bold text-ink tracking-tight truncate">{title}</h1>
                {status}
              </div>
              {subtitle && <p className="text-[13px] text-ink-3 mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>

        {/* Body: main column + related rail */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
          <div className="lg:col-span-2 space-y-5 min-w-0">{children}</div>
          {related.length > 0 && (
            <div className="space-y-4 lg:sticky lg:top-4">
              {related.map((group) => (
                <RelatedCard key={group.label} label={group.label} items={group.items} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** One related-records card: a titled list of RecordLinks. Renders an empty-state
 *  line when the group has no items, so the panel is honest about what's linked. */
function RelatedCard({ label, items }) {
  return (
    <div className="bb-surface bg-panel border border-hairline rounded-2xl">
      <div className="px-4 py-2.5 border-b border-hairline">
        <h2 className="text-xs font-semibold text-ink-2 uppercase tracking-wide">{label}</h2>
      </div>
      <div className="p-2">
        {(!items || items.length === 0) ? (
          <p className="px-2 py-3 text-xs text-ink-3">Nothing linked yet.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {items.map((it, i) => (
              <li key={`${it.type}-${it.id}-${i}`} className="px-2 py-2 flex items-center justify-between gap-2">
                <RecordLink type={it.type} id={it.id} label={it.label} icon />
                {it.meta && <span className="text-[11px] text-ink-3 shrink-0">{it.meta}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
