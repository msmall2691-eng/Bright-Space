import { X } from 'lucide-react'

/** Result banner shown after an XLSX/CSV client import — green with
 *  added/skipped counts on success, red with the error message on
 *  failure. Dismissible via the X button. */
export function ImportResultBanner({ importResult, onDismiss }) {
  return (
    <div className={`mb-3 px-3 py-2 rounded-lg text-[12px] border flex items-center justify-between ${
      importResult.error
        ? 'bg-red-50 border-red-200 text-red-600'
        : 'bg-emerald-50 border-emerald-200 text-emerald-600'
    }`}>
      <span>
        {importResult.error
          ? `Import failed: ${importResult.error}`
          : `Imported ${importResult.added} clients${importResult.skipped ? `, skipped ${importResult.skipped} duplicates` : ''}`}
      </span>
      <button onClick={onDismiss} className="ml-3 opacity-60 hover:opacity-100"><X className="w-3 h-3" /></button>
    </div>
  )
}
