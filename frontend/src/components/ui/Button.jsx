/**
 * Button Component
 * Reusable button with multiple variants and sizes
 */

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  disabled = false,
  ...props
}) {
  const baseStyles = 'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed'

  const variants = {
    primary: 'bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg focus:ring-blue-500',
    secondary: 'bg-neutral-200 hover:bg-neutral-300 text-neutral-900 focus:ring-neutral-500',
    tertiary: 'text-blue-600 hover:text-blue-700 hover:bg-blue-50 focus:ring-blue-500',
    danger: 'bg-red-600 hover:bg-red-700 text-white shadow-md hover:shadow-lg focus:ring-red-500',
    glass: 'bg-white/30 backdrop-blur-sm border border-white/50 text-neutral-900 hover:bg-white/40 focus:ring-blue-500',
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-xs font-medium',
    md: 'px-4 py-2 text-sm font-medium',
    lg: 'px-6 py-2.5 text-base font-semibold',
  }

  const combinedStyles = `${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`

  return (
    <button
      className={combinedStyles}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}
