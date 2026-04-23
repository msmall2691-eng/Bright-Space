import { useState } from 'react'
import { Settings, X, CheckCircle, Loader2 } from 'lucide-react'

export default function PageSettings({ pageName, settings, onSave, children }) {
  const [isOpen, setIsOpen] = useState(false)
  const [localSettings, setLocalSettings] = useState(settings)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(localSettings)
      setIsOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    setLocalSettings(settings)
    setIsOpen(false)
  }

  return (
    <>
      {/* Settings button */}
      <button
        onClick={() => setIsOpen(true)}
        className="p-2 rounded-lg hover:bg-neutral-100 transition-colors text-neutral-500 hover:text-neutral-700"
        title={`${pageName} settings`}
      >
        <Settings className="w-5 h-5" />
      </button>

      {/* Settings modal */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-auto">
            <div className="sticky top-0 bg-white border-b border-neutral-200 p-6 flex items-center justify-between">
              <h2 className="text-xl font-bold text-neutral-900">{pageName} Settings</h2>
              <button
                onClick={handleClose}
                className="p-2 rounded-lg hover:bg-neutral-100 transition-colors"
              >
                <X className="w-5 h-5 text-neutral-600" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {children({ settings: localSettings, setSettings: setLocalSettings })}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-neutral-200 p-6 flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm font-semibold text-neutral-700 hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
