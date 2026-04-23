export default function GlassCard({
  title,
  subtitle,
  className = '',
  children,
}) {
  return (
    <div className={`rounded-xl bg-white/70 backdrop-blur-md border border-white/20 p-6 shadow-sm hover:shadow-md transition-shadow ${className}`}>
      {(title || subtitle) && (
        <div className="mb-4">
          {title && <h3 className="text-lg font-semibold text-neutral-900">{title}</h3>}
          {subtitle && <p className="text-sm text-neutral-600 mt-1">{subtitle}</p>}
        </div>
      )}
      {children}
    </div>
  )
}
