export default function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  disabled = false,
  type = 'button',
  children,
  ...props
}) {
  // Calmer, Twenty-style buttons: flat surfaces, hairline borders, no loud
  // drop shadows. The primary stays clearly the primary — just not shouting.
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm',
    secondary: 'bg-panel text-ink-2 border border-hairline hover:bg-bg-2 hover:text-ink',
    tertiary: 'bg-transparent text-ink-2 hover:bg-bg-2',
    danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
    glass: 'bg-white/10 backdrop-blur text-white hover:bg-white/20 border border-white/20',
  }

  const sizes = {
    sm: 'px-2.5 py-1.5 text-xs',
    md: 'px-3.5 py-2 text-sm',
    lg: 'px-5 py-2.5 text-sm',
  }

  const baseStyles = 'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500'

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
