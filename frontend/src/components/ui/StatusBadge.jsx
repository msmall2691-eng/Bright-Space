export default function StatusBadge({
  status,
  variant = 'filled',
  className = '',
  children,
}) {
  const statusStyles = {
    success: {
      filled: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      outline: 'border border-green-200 text-green-700 dark:border-green-800 dark:text-green-300',
    },
    warning: {
      filled: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
      outline: 'border border-amber-200 text-amber-700 dark:border-amber-800 dark:text-amber-300',
    },
    danger: {
      filled: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
      outline: 'border border-red-200 text-red-700 dark:border-red-800 dark:text-red-300',
    },
    info: {
      filled: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      outline: 'border border-blue-200 text-blue-700 dark:border-blue-800 dark:text-blue-300',
    },
    neutral: {
      filled: 'bg-bg-2 text-ink-2',
      outline: 'border border-hairline text-ink-3',
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
