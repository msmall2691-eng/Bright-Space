/**
 * GlassCard Component
 * Modern glassmorphic card with backdrop blur
 */

export default function GlassCard({
  children,
  className = '',
  title,
  subtitle,
  interactive = true,
  hover = true,
  ...props
}) {
  const baseStyles = 'bg-white/70 backdrop-blur-lg border border-white/20 rounded-xl shadow-glass'
  const hoverStyles = hover ? 'transition-all duration-200 hover:shadow-glass-lg hover:bg-white/80' : ''
  const combinedStyles = `${baseStyles} ${hoverStyles} ${className}`

  return (
    <div className={combinedStyles} {...props}>
      {(title || subtitle) && (
        <div className="px-6 py-4 border-b border-white/10">
          {title && <h3 className="text-lg font-semibold text-neutral-900">{title}</h3>}
          {subtitle && <p className="text-sm text-neutral-600 mt-1">{subtitle}</p>}
        </div>
      )}
      <div className="p-6">
        {children}
      </div>
    </div>
  )
}
