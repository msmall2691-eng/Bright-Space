import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users } from 'lucide-react'
import { post } from '../api'
import JobCreateModal from '../components/JobCreateModal'
import { EmptyState } from '../components/ui'
import CRMHealthPanel from "../components/CRMHealthPanel"
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'
import { useClients } from '../hooks/useClients'
import { useClientPhones } from '../hooks/useClientPhones'
import { useClientMutations } from '../hooks/useClientMutations'
import { useClientForm } from '../hooks/useClientForm'
import { useClientView } from '../hooks/useClientView'
import { useSelectionSet } from '../hooks/useSelectionSet'
import { CLIENT_COLUMNS } from '../components/clients/columns'
import { ClientForm } from '../components/clients/ClientForm'
import { MergeModal } from '../components/clients/MergeModal'
import { BulkActionBar } from '../components/clients/BulkActionBar'

// Group the duplicate-bucket rows into review pairs the automatic
// email-merge can't touch (both members have a real, non-placeholder
// name). Pair key is sorted (min id, max id) so (a,b) and (b,a) dedupe.
function _isPlaceholderClientName(name) {
  const n = (name || '').trim()
  if (!n) return true
  const stripped = n.replace(/[-().\s+]/g, '')
  return /^\d+$/.test(stripped)
}
function computeRealNamedDupPairs(rows) {
  const byKey = new Map()
  for (const c of rows) {
    if (_isPlaceholderClientName(c.name)) continue
    const emailKey = c.email && c.email.trim() ? `e:${c.email.trim().toLowerCase()}` : null
    const phoneKey = c.phone_tail ? `p:${c.phone_tail}` : (c.phone ? `p:${String(c.phone).replace(/\D/g, '').slice(-10)}` : null)
    for (const k of [emailKey, phoneKey]) {
      if (!k) continue
      if (!byKey.has(k)) byKey.set(k, [])
      byKey.get(k).push(c)
    }
  }
  const seen = new Set()
  const pairs = []
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [lo, hi] = group[i].id < group[j].id ? [group[i], group[j]] : [group[j], group[i]]
        const key = `${lo.id}:${hi.id}`
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push([lo, hi])
      }
    }
  }
  return pairs
}
import { ImportResultBanner } from '../components/clients/ImportResultBanner'
import { ClientCardRow } from '../components/clients/ClientCardRow'
import { ClientTableView } from '../components/clients/ClientTableView'
import { ClientsToolbar } from '../components/clients/ClientsToolbar'

/** Banner that appears when a CRM Health bucket is being filtered.
 *  Shows the count and offers a contextual bulk action:
 *   - spam_marketing / test → "Archive N" (soft — status=inactive)
 *   - duplicate → "Auto-merge safe duplicates" (placeholder-into-real by
 *     email) plus "Review pairs" for the real-named groups the auto-merge
 *     can't safely touch (walks pairs through the existing Merge modal).
 *   - incomplete → "Edit next →" (jumps into the edit form for the first
 *     row; each record needs a different missing field so there's no true
 *     bulk fix — this makes the workflow discoverable).
 *  All destructive-ish actions confirm the count first so a mis-click
 *  can't quietly wipe 40 records. */
function BucketFilterBanner({
  bucketFilter, filteredCount, baseCount, onClear, onArchived, onArchiveError,
  idsToArchive, reviewablePairCount, onReviewPairs, onEditFirst,
}) {
  const [busy, setBusy] = useState(false)
  const [dupPreview, setDupPreview] = useState(null)
  const isArchivable = ['spam_marketing', 'test'].includes(bucketFilter.key)
  const isDuplicate = bucketFilter.key === 'duplicate'
  const isIncomplete = bucketFilter.key === 'incomplete'

  const doArchive = async () => {
    if (!idsToArchive.length) return
    const ok = await confirmDialog(
      `Archive ${idsToArchive.length} ${bucketFilter.label.toLowerCase()} client${idsToArchive.length === 1 ? '' : 's'}?\n\n` +
      `They'll be set to inactive but not deleted — you can un-archive them later. ` +
      `Existing jobs/quotes/invoices stay intact.`,
      { confirmLabel: 'Archive' }
    )
    if (!ok) return
    setBusy(true)
    try {
      await post('/api/clients/bulk-status', { ids: idsToArchive, status: 'inactive' })
      onArchived?.()
    } catch (e) {
      onArchiveError?.(e?.message || 'Archive failed')
    } finally { setBusy(false) }
  }

  const previewMerge = async () => {
    setBusy(true)
    try {
      const r = await post('/api/clients/cleanup-duplicates-by-email?dry_run=true', {})
      setDupPreview(r?.merges || [])
    } catch (e) {
      onArchiveError?.(e?.message || 'Merge preview failed')
    } finally { setBusy(false) }
  }
  const applyMerge = async () => {
    if (!dupPreview?.length) return
    const ok = await confirmDialog(
      `Merge ${dupPreview.length} duplicate group${dupPreview.length === 1 ? '' : 's'}?\n\n` +
      `The keeper for each group is the client with a real name; placeholder-named ` +
      `duplicates get merged into it. All jobs/quotes/invoices are reassigned first. ` +
      `This cannot be undone.`,
      { confirmLabel: 'Merge', danger: true }
    )
    if (!ok) return
    setBusy(true)
    try {
      await post('/api/clients/cleanup-duplicates-by-email?dry_run=false', {})
      setDupPreview(null)
      onArchived?.()
    } catch (e) {
      onArchiveError?.(e?.message || 'Merge failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Showing <span className="font-semibold">{bucketFilter.label}</span> —
          {' '}{filteredCount} of {baseCount}
        </span>
        <div className="flex items-center gap-2">
          {isArchivable && (
            <button onClick={doArchive} disabled={busy || !filteredCount}
              className="font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 px-2.5 py-1 rounded-md">
              {busy ? 'Archiving…' : `Archive ${filteredCount}`}
            </button>
          )}
          {isDuplicate && !dupPreview && (
            <button onClick={previewMerge} disabled={busy}
              className="font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 px-2.5 py-1 rounded-md">
              {busy ? 'Analyzing…' : 'Auto-merge safe duplicates'}
            </button>
          )}
          {isDuplicate && reviewablePairCount > 0 && (
            <button onClick={onReviewPairs} disabled={busy}
              title="Step through real-named duplicate pairs the auto-merge can't touch"
              className="font-semibold text-amber-800 border border-amber-400 hover:bg-amber-100 disabled:opacity-50 px-2.5 py-1 rounded-md">
              Review {reviewablePairCount} pair{reviewablePairCount === 1 ? '' : 's'}
            </button>
          )}
          {isIncomplete && filteredCount > 0 && (
            <button onClick={onEditFirst}
              title="Open the first record's edit form to add missing phone / email"
              className="font-semibold text-amber-800 border border-amber-400 hover:bg-amber-100 px-2.5 py-1 rounded-md">
              Edit next →
            </button>
          )}
          <button onClick={onClear}
            className="font-semibold underline underline-offset-2 hover:text-amber-900">
            Clear filter
          </button>
        </div>
      </div>
      {isDuplicate && dupPreview && (
        <div className="mt-2 text-amber-900">
          {dupPreview.length === 0 ? (
            <span>No auto-safe merges found. Duplicates need manual review — pick two rows and use the toolbar's Merge action.</span>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Preview: {dupPreview.length} group{dupPreview.length === 1 ? '' : 's'} can be auto-merged (placeholder-named rows into real-named keepers by email).</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setDupPreview(null)}
                  className="font-semibold text-amber-800 hover:text-amber-900 underline underline-offset-2">
                  Cancel
                </button>
                <button onClick={applyMerge} disabled={busy}
                  className="font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-50 px-2.5 py-1 rounded-md">
                  {busy ? 'Merging…' : `Apply merge (${dupPreview.length})`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Clients() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const { clients, setClients, filtered: baseFiltered, statusCounts, load } = useClients(statusFilter, search)
  // CRM Health "bucket" filter — when a bucket badge in CRMHealthPanel is
  // clicked we narrow the visible list to just those client IDs. Null
  // means "no bucket filter"; empty array means the bucket has no rows
  // (still narrows, showing nothing).
  const [bucketFilter, setBucketFilter] = useState(null) // { key, label, ids: Set }
  const filtered = bucketFilter
    ? baseFiltered.filter(c => bucketFilter.ids.has(c.id))
    : baseFiltered
  // Real-named duplicate review workflow. `pairQueue` is the remaining
  // pairs still to visit (stored as [idA, idB] so we can re-resolve them
  // after each merge shrinks the list). `reviewTotal` is fixed at start
  // for the "Pair X of Y" counter. `reviewing` gates the queue-advance
  // effect so a modal opened from elsewhere (toolbar's Merge action)
  // doesn't get pulled into this flow.
  const [pairQueue, setPairQueue] = useState([])
  const [reviewTotal, setReviewTotal] = useState(0)
  const [reviewing, setReviewing] = useState(false)
  const reviewablePairs = bucketFilter?.key === 'duplicate'
    ? computeRealNamedDupPairs(filtered)
    : []
  const [selected, setSelected] = useState(null)
  // Quick "Schedule" from a client row → opens the job modal with that client.
  const [jobClient, setJobClient] = useState(null)
  const {
    viewMode, setViewMode,
    columns, setColumns, visibleColumns,
    viewConfig, applyView,
  } = useClientView({ statusFilter, setStatusFilter })
  const fileInputRef = useRef(null)
  const {
    phoneNumbers,
    newPhoneNumber, setNewPhoneNumber,
    newPhoneType, setNewPhoneType,
    loadingPhones,
    loadPhones,
    addPhoneNumber,
    deletePhoneNumber,
    setPhonePrimary,
    resetPhones,
  } = useClientPhones({ selected, refreshList: load })
  const {
    showForm, setShowForm,
    form, setForm,
    showBilling, setShowBilling,
    dupes, setDupes,
    openNew, openEdit,
  } = useClientForm({ setSelected, loadPhones, resetPhones })
  const { selectedIds, toggle: toggleSelect, toggleAll, clear: clearSelection } = useSelectionSet()
  const toggleSelectAll = () => toggleAll(filtered.map(c => c.id))

  const {
    saving, saveError,
    importing, importResult, setImportResult,
    bulkDeleting,
    mergeModal, setMergeModal,
    mergeWinner, setMergeWinner,
    merging,
    updateStatus, save, handleImport, deleteClient, bulkDelete, openMerge, doMerge,
  } = useClientMutations({
    load, clients, setClients,
    selected, setSelected, form, setForm,
    dupes, setDupes,
    setShowForm, setShowBilling,
    resetPhones,
    selectedIds, clearSelection,
    toast,
  })

  useEffect(() => { clearSelection() }, [statusFilter, search])

  // While reviewing, auto-open the next pair when the merge modal closes
  // (post-merge or user-clicked Skip). Skips pairs whose members have
  // already been merged away. Gated on `!merging` so we advance only
  // after the post-merge reload has updated the clients list — otherwise
  // we could reopen with a stale record that was just deleted server-side.
  // When the queue drains, exit review mode.
  useEffect(() => {
    if (!reviewing || mergeModal || merging) return
    let next = null
    let rest = pairQueue
    while (rest.length && !next) {
      const [pairIds, ...tail] = rest
      const a = clients.find(c => c.id === pairIds[0])
      const b = clients.find(c => c.id === pairIds[1])
      rest = tail
      if (a && b) next = [a, b]
    }
    if (rest !== pairQueue) setPairQueue(rest)
    if (next) {
      setMergeModal({ a: next[0], b: next[1] })
      const score = c => (c.status === 'active' ? 2 : 0) + (c.email ? 1 : 0) + (c.phone ? 1 : 0)
      setMergeWinner(score(next[1]) > score(next[0]) ? next[1].id : next[0].id)
    } else if (rest.length === 0) {
      setReviewing(false); setReviewTotal(0)
    }
  }, [reviewing, mergeModal, merging, pairQueue, clients, setMergeModal, setMergeWinner])

  const startPairReview = () => {
    if (!reviewablePairs.length) return
    const queue = reviewablePairs.map(([a, b]) => [a.id, b.id])
    setPairQueue(queue)
    setReviewTotal(queue.length)
    setReviewing(true)
  }
  const stopPairReview = () => {
    setReviewing(false); setReviewTotal(0); setPairQueue([]); setMergeModal(null)
  }
  const skipPairReview = () => {
    // Closing the modal triggers the advance effect above.
    setMergeModal(null)
  }
  const reviewProgress = reviewing && mergeModal
    ? { current: reviewTotal - pairQueue.length, total: reviewTotal, onSkip: skipPairReview, onStop: stopPairReview }
    : null

  const editFirstIncomplete = () => {
    const first = filtered[0]
    if (first) openEdit(first)
  }

  return (
    <div className="flex h-full">
      {/* Main list */}
      <div className="flex-1 flex flex-col p-4 sm:p-6 min-w-0">
        <ClientsToolbar
          search={search} setSearch={setSearch}
          viewConfig={viewConfig} applyView={applyView}
          clientColumns={CLIENT_COLUMNS} columns={columns} setColumns={setColumns}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter} statusCounts={statusCounts}
          fileInputRef={fileInputRef} importing={importing} handleImport={handleImport}
          viewMode={viewMode} setViewMode={setViewMode}
          openNew={openNew}
        />

        {/* Read-only CRM health snapshot — see the real/dup/spam breakdown before cleanup.
            Bucket clicks narrow the list below to that bucket's members. */}
        <CRMHealthPanel
          onSelectBucket={(key, ids) => {
            const label = ({
              duplicate: 'Duplicates', spam_marketing: 'Spam / marketing',
              incomplete: 'Incomplete', test: 'Test / junk',
            })[key] || key
            setBucketFilter({ key, label, ids: new Set(ids) })
            clearSelection()
          }}
        />

        {bucketFilter && (
          <BucketFilterBanner
            bucketFilter={bucketFilter}
            filteredCount={filtered.length}
            baseCount={baseFiltered.length}
            onClear={() => setBucketFilter(null)}
            onArchived={async () => {
              // Refresh both the list and the health snapshot after archiving,
              // otherwise the bucket keeps showing the pre-archive count.
              setBucketFilter(null)
              await load()
              toast.success(`Archived ${filtered.length} client${filtered.length === 1 ? '' : 's'}`)
            }}
            onArchiveError={(msg) => toast.error(msg)}
            idsToArchive={filtered.map(c => c.id)}
            reviewablePairCount={reviewablePairs.length}
            onReviewPairs={startPairReview}
            onEditFirst={editFirstIncomplete}
          />
        )}

        {importResult && (
          <ImportResultBanner importResult={importResult} onDismiss={() => setImportResult(null)} />
        )}

        <BulkActionBar
          filtered={filtered}
          selectedIds={selectedIds}
          toggleSelectAll={toggleSelectAll}
          clearSelection={clearSelection}
          openMerge={openMerge}
          bulkDelete={bulkDelete}
          bulkDeleting={bulkDeleting}
        />

        {/* Client rows — Card view */}
        {viewMode === 'cards' && (
          <div className="space-y-1.5 overflow-y-auto flex-1">
            {filtered.map(c => (
              <ClientCardRow
                key={c.id}
                c={c}
                selected={selectedIds.has(c.id)}
                toggleSelect={toggleSelect}
                setJobClient={setJobClient}
                navigate={navigate}
              />
            ))}
            {filtered.length === 0 && (
              <EmptyState icon={Users} title={search || statusFilter ? 'No matching clients' : 'No clients yet'}
                description={search || statusFilter ? 'Try a different search or filter.' : undefined}
                action={!search && !statusFilter && (
                  <button onClick={openNew} className="text-xs font-semibold text-blue-600 hover:text-blue-700">Add your first client →</button>
                )} />
            )}
          </div>
        )}

        {/* Client rows — Table view (Twenty CRM-inspired) */}
        {viewMode === 'table' && (
          <ClientTableView
            filtered={filtered}
            visibleColumns={visibleColumns}
            selectedIds={selectedIds}
            toggleSelect={toggleSelect}
            toggleSelectAll={toggleSelectAll}
            updateStatus={updateStatus}
            setJobClient={setJobClient}
            navigate={navigate}
            search={search}
            statusFilter={statusFilter}
            openNew={openNew}
          />
        )}
      </div>

      {showForm && (
        <ClientForm
          selected={selected}
          form={form} setForm={setForm}
          onClose={() => { setShowForm(false); resetPhones() }}
          phoneNumbers={phoneNumbers} loadingPhones={loadingPhones}
          newPhoneNumber={newPhoneNumber} setNewPhoneNumber={setNewPhoneNumber}
          newPhoneType={newPhoneType} setNewPhoneType={setNewPhoneType}
          setPhonePrimary={setPhonePrimary}
          deletePhoneNumber={deletePhoneNumber}
          addPhoneNumber={addPhoneNumber}
          showBilling={showBilling} setShowBilling={setShowBilling}
          dupes={dupes}
          saveError={saveError}
          saving={saving}
          save={save}
          deleteClient={deleteClient}
          navigate={navigate}
        />
      )}
      {mergeModal && (
        <MergeModal
          mergeModal={mergeModal}
          mergeWinner={mergeWinner}
          setMergeWinner={setMergeWinner}
          merging={merging}
          setMergeModal={setMergeModal}
          doMerge={doMerge}
          reviewProgress={reviewProgress}
        />
      )}
      {jobClient && (
        <JobCreateModal
          clientId={jobClient.id}
          clientName={jobClient.name}
          onClose={() => setJobClient(null)}
          onCreated={() => { setJobClient(null); toast.success('Job scheduled ✓') }}
        />
      )}
    </div>
  )
}
