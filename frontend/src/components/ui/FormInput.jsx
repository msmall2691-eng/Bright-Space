export default function FormInput({
  label,
  error,
  required = false,
  type = 'text',
  className = '',
  ...props
}) {
  return (
    <div className="flex flex-col gap-2">
      {label && (
        <label className="text-sm font-semibold text-neutral-700">
          {label}
          {required && <span className="text-red-600 ml-1">*</span>}
        </label>
      )}
      <input
        type={type}
        className={`px-4 py-2 rounded-lg border border-neutral-200/50 bg-white/50 hover:bg-white/70 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
          error ? 'border-red-200 focus:ring-red-500' : ''
        } ${className}`}
        {...props}
      />
      {error && (
        <span className="text-sm text-red-600">{error}</span>
      )}
    </div>
  )
}
