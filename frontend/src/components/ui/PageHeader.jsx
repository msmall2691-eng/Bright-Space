import PageTitle from './PageTitle'

/**
 * PageHeader — legacy alias. The app's page headers unified onto `PageTitle`
 * (one compact pattern instead of three); this wrapper keeps the old call
 * sites working. `iconColor` is accepted-and-ignored: header icons are now
 * flat glyphs — color belongs to data, not chrome. Prefer `PageTitle` in new
 * code.
 */
export default function PageHeader({
  title,
  subtitle,
  icon,
  iconColor, // eslint-disable-line no-unused-vars -- legacy prop, no longer rendered
  actions,
  className = '',
  children,
}) {
  return (
    <PageTitle
      title={title}
      subtitle={subtitle}
      icon={icon}
      actions={actions}
      className={`px-4 sm:px-8 pt-4 sm:pt-5 pb-3 ${className}`}
    >
      {children}
    </PageTitle>
  )
}
