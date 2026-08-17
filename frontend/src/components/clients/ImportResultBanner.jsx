import { X } from 'lucide-react'

/** Result banner shown after an XLSX/CSV client import — hairline card with
 *  a colored dot: emerald with added/skipped counts on success, red with
 *  the error message on failure. Dismissible via the X button. */
export function ImportResultBanner({ importResult, onDismiss }) {
  return (
    <div className="mb-3 px-3 py-2 rounded-lg text-[12px] border border-hairline bg-panel text-ink flex items-center justify-between">
      <span className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${importResult.error ? 'bg-red-500' : 'bg-emerald-500'}`} aria-hidden="true" />
        {importResult.error
          ? `Import failed: ${importResult.error}`
          : `Imported ${importResult.added} clients${importResult.skipped ? `, skipped ${importResult.skipped} duplicates` : ''}`}
      </span>
      <button onClick={onDismiss} className="ml-3 text-ink-3 hover:text-ink-2"><X className="w-3 h-3" /></button>
    </div>
  )
}
