import { AlertTriangle, XOctagon } from 'lucide-react'

export default function ConflictWarning({ conflicts }) {
  if (!conflicts || conflicts.length === 0) return null

  return (
    <div className="space-y-2">
      {conflicts.map((c, i) => {
        const isError = c.severity === 'error'
        return (
          <div
            key={i}
            className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-xs border ${
              isError
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}
          >
            {isError
              ? <XOctagon className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
              : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            }
            <div>
              <span className="font-semibold">
                {c.type === 'cleaner_double_booking' ? 'Cleaner Conflict' : 'Property Conflict'}
              </span>
              <span className="ml-1">{c.message}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
