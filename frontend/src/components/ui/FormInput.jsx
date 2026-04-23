/**
 * FormInput Component
 * Consistent form input styling with label support
 */

export default function FormInput({
  label,
  error,
  type = 'text',
  placeholder,
  required = false,
  className = '',
  ...props
}) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-xs font-semibold text-neutral-700 uppercase tracking-wide mb-2">
          {label}
          {required && <span className="text-red-600 ml-1">*</span>}
        </label>
      )}
      <input
        type={type}
        placeholder={placeholder}
        className={`
          w-full px-3 py-2 border rounded-lg
          focus:outline-none focus:ring-2 focus:ring-offset-2
          transition-colors duration-200
          ${error ? 'border-red-500 focus:ring-red-500' : 'border-neutral-300 focus:ring-blue-500 focus:border-transparent'}
          disabled:bg-neutral-100 disabled:text-neutral-500 disabled:cursor-not-allowed
          ${className}
        `}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
