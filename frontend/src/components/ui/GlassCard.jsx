export default function GlassCard({
  title,
  subtitle,
  className = '',
  children,
}) {
  return (
    <div className={`rounded-xl bg-panel/80 backdrop-blur-md border border-hairline p-6 shadow-sm hover:shadow-md transition-shadow ${className}`}>
      {(title || subtitle) && (
        <div className="mb-4">
          {title && <h3 className="text-lg font-semibold text-ink">{title}</h3>}
          {subtitle && <p className="text-sm text-ink-3 mt-1">{subtitle}</p>}
        </div>
      )}
      {children}
    </div>
  )
}
