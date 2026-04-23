/**
 * StatusBadge Component
 * Status indicator with semantic colors
 */

export default function StatusBadge({
  status,
  variant = 'filled',
  className = '',
  children,
}) {
  const statusStyles = {
    success: {
      filled: 'bg-green-100 text-green-700',
      outline: 'border border-green-200 text-green-700',
    },
    warning: {
      filled: 'bg-amber-100 text-amber-700',
      outline: 'border border-amber-200 text-amber-700',
    },
    danger: {
      filled: 'bg-red-100 text-red-700',
      outline: 'border border-red-200 text-red-700',
    },
    info: {
      filled: 'bg-blue-100 text-blue-700',
      outline: 'border border-blue-200 text-blue-700',
    },
    neutral: {
      filled: 'bg-neutral-200 text-neutral-700',
      outline: 'border border-neutral-300 text-neutral-600',
    },
  }

  const style = statusStyles[status] || statusStyles.neutral
  const baseStyles = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold'

  return (
    <span className={`${baseStyles} ${style[variant]} ${className}`}>
      {children}
    </span>
  )
}
