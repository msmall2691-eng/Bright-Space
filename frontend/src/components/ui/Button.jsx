export default function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  disabled = false,
  type = 'button',
  children,
  ...props
}) {
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 shadow-md hover:shadow-lg',
    secondary: 'bg-neutral-200 text-neutral-900 hover:bg-neutral-300',
    tertiary: 'bg-transparent text-neutral-600 hover:bg-neutral-100',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    glass: 'bg-white/10 backdrop-blur text-white hover:bg-white/20 border border-white/20',
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }

  const baseStyles = 'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'

  return (
    <button
      type={type}
      disabled={disabled}
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
