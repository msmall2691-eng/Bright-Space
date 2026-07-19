import { PROPERTY_TYPE_CONFIG } from './constants'

const TYPES = [
  { key: 'residential', description: 'Home or apartment' },
  { key: 'commercial',  description: 'Business or office space' },
  { key: 'str',         description: 'Airbnb, VRBO, or vacation rental' },
]

/** Small modal shown when starting a new property — the operator picks a
 *  type first (residential / commercial / STR) so the main form knows
 *  which type-specific fields to render. Confirm calls onConfirm(), which
 *  the parent uses to seed the empty form with `property_type` set and
 *  swap to the main edit modal. */
export function TypeSelectorModal({ selected, onSelect, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-panel rounded-xl shadow-xl max-w-sm w-full mx-4">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-ink mb-4">What kind of property?</h2>
          <div className="space-y-2">
            {TYPES.map(({ key, description }) => (
              <button
                key={key}
                onClick={() => onSelect(key)}
                className={`w-full p-3 rounded-lg border-2 text-left transition-all ${
                  selected === key
                    ? 'border-indigo-600 bg-blue-50'
                    : 'border-hairline hover:border-hairline'
                }`}
              >
                <div className="font-medium text-ink">{PROPERTY_TYPE_CONFIG[key].label}</div>
                <div className="text-sm text-ink-3 mt-1">{description}</div>
              </button>
            ))}
          </div>
          <div className="flex gap-2 mt-6">
            <button onClick={onCancel}
              className="flex-1 bg-bg-2 hover:bg-bg-2 text-ink px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              Cancel
            </button>
            <button onClick={onConfirm}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
