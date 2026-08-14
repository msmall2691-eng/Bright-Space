import PageTitle from './PageTitle'

/**
 * PageHero — legacy alias. Was a big panel card with up to four stat "pods";
 * page headers unified onto `PageTitle`, where pods become the quiet inline
 * stats line (label + bold value, dot-separated). This wrapper maps the old
 * props across so the call sites keep working unchanged. Prefer `PageTitle`
 * in new code.
 */
export default function PageHero({
  icon,
  title,
  subtitle,
  actions,
  pods = [],
  className = '',
  children,
}) {
  return (
    <PageTitle
      icon={icon}
      title={title}
      subtitle={subtitle}
      actions={actions}
      stats={pods.map(p => ({ label: p.label, value: p.value, tone: p.tone, onClick: p.onClick }))}
      className={className}
    >
      {children}
    </PageTitle>
  )
}
