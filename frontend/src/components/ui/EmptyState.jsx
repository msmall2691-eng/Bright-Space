/**
 * EmptyState — consistent "nothing here yet" placeholder.
 *
 * Every page invented its own empty message ("No clients yet", centered divs,
 * varying icon sizes). This standardizes the icon + title + description +
 * optional action, token-themed.
 *
 *   <EmptyState icon={Inbox} title="Inbox zero"
 *     description="Nothing needs your attention." />
 *   <EmptyState icon={Users} title="No clients yet"
 *     action={<Button onClick={addClient}>Add client</Button>} />
 *
 * `compact` tightens padding for use inside a Card body.
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className = '',
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? 'py-8 px-4' : 'py-14 px-6'
      } ${className}`}
    >
      {Icon && (
        <div className="w-12 h-12 rounded-2xl bg-bg border border-hairline flex items-center justify-center mb-3">
          <Icon className="w-5 h-5 text-ink-3" />
        </div>
      )}
      {title && <p className="text-sm font-semibold text-ink">{title}</p>}
      {description && (
        <p className="text-[13px] text-ink-3 mt-1 max-w-xs">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
