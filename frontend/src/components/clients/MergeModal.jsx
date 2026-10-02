/** Modal for merging two duplicate client records into one.
 *  The winner keeps the surviving row id; the loser is deleted server-side
 *  and all its jobs, invoices, properties, messages and contact info are
 *  reparented onto the survivor. Fully controlled — parent owns the
 *  {a, b} pair, the selected winner id, the merging flag and doMerge.
 *
 *  When walking a queue of duplicate pairs (CRM health "Review pairs"
 *  flow), pass reviewProgress = { current, total, onSkip, onStop } — the
 *  footer shows "Pair X of Y" plus a Skip and Stop control so the user
 *  can move through the queue without dropping out unintentionally. */
import { Modal } from '../ui'

export function MergeModal({
  mergeModal,
  mergeWinner, setMergeWinner,
  merging,
  setMergeModal,
  doMerge,
  reviewProgress,
}) {
  const close = () => { if (reviewProgress) reviewProgress.onStop?.(); else setMergeModal(null) }
  return (
    <Modal
      open={!!mergeModal}
      onClose={close}
      dismissable={!merging}
      maxWidth="md"
      title="Merge clients"
      titleRight={reviewProgress && (
        <span className="text-[11px] font-medium text-ink-3 shrink-0 tabular-nums">
          Pair {reviewProgress.current} of {reviewProgress.total}
        </span>
      )}
    >
      <Modal.Body>
        <p className="text-[12px] text-ink-3 mb-4">
          Pick the record to keep. The other is deleted and all its jobs, invoices, properties,
          messages and contact info move onto the survivor. This can't be undone.
        </p>
        <div className="space-y-2">
          {[mergeModal.a, mergeModal.b].map(c => (
            <label key={c.id}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${mergeWinner === c.id ? 'border-hairline-2 bg-bg-2' : 'border-hairline hover:bg-bg-2'}`}>
              <input type="radio" name="merge-winner" checked={mergeWinner === c.id}
                onChange={() => setMergeWinner(c.id)} className="mt-0.5" />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink truncate">{c.name}
                  <span className="ml-2 text-[10px] font-medium text-ink-3 uppercase">{c.status}</span>
                </div>
                <div className="text-[11px] text-ink-3 truncate">
                  {[c.phone, c.email, c.city].filter(Boolean).join(' · ') || 'No contact info'}
                </div>
              </div>
              <span className="ml-auto text-[10px] font-medium text-ink-3 shrink-0">
                {mergeWinner === c.id ? 'Keep' : 'Remove'}
              </span>
            </label>
          ))}
        </div>
      </Modal.Body>
      <Modal.Footer>
        {reviewProgress ? (
          <>
            <button onClick={() => reviewProgress.onStop?.()} disabled={merging}
              className="px-4 py-2 text-[13px] text-ink-2 border border-hairline rounded-lg hover:bg-bg-2 transition-colors font-medium">
              Stop review
            </button>
            <button onClick={() => reviewProgress.onSkip?.()} disabled={merging}
              className="flex-1 px-4 py-2 text-[13px] text-ink-2 border border-hairline rounded-lg hover:bg-bg-2 transition-colors font-medium">
              Skip
            </button>
          </>
        ) : (
          <button onClick={() => setMergeModal(null)} disabled={merging}
            className="flex-1 px-4 py-2 text-[13px] text-ink-2 border border-hairline rounded-lg hover:bg-bg-2 transition-colors font-medium">
            Cancel
          </button>
        )}
        <button onClick={doMerge} disabled={merging || !mergeWinner}
          className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-bg-2 disabled:text-ink-3 text-white px-4 py-2 rounded-lg text-[13px] font-medium transition-colors">
          {merging ? 'Merging...' : 'Merge'}
        </button>
      </Modal.Footer>
    </Modal>
  )
}
