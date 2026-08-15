import { useState } from 'react'
import { del, get, patch, post, upload } from '../api'
import { EMPTY } from '../components/clients/constants'
import { confirmDialog } from '../utils/confirmBus'

/** Owns every server-hitting mutation on the Clients list page:
 *  save / delete a single client (with optimistic status inline-edit
 *  via `updateStatus`), XLSX/CSV import, bulk delete over the current
 *  selection, and the two-client merge flow (openMerge picks a
 *  default survivor by "most complete + active" scoring; doMerge
 *  POSTs the loser onto the winner).
 *
 *  Also owns the in-flight/result flags each mutation surfaces
 *  (`saving`, `saveError`, `importing`, `importResult`,
 *  `bulkDeleting`, `merging`, plus the merge-modal state). The page
 *  passes in the load/clients/selection callbacks it already owns
 *  so we don't fork the source of truth. */
export function useClientMutations({
  load, clients, setClients,
  selected, setSelected, form, setForm,
  dupes, setDupes,
  setShowForm, setShowBilling,
  resetPhones,
  selectedIds, clearSelection,
  toast,
}) {
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [mergeModal, setMergeModal] = useState(null)
  const [mergeWinner, setMergeWinner] = useState(null)
  const [merging, setMerging] = useState(false)

  // Inline-edit: change a client's status straight from the table
  // (optimistic; reverts on failure). Twenty's click-a-cell pattern.
  const updateStatus = async (c, status) => {
    const prev = c.status
    setClients(cs => cs.map(x => (x.id === c.id ? { ...x, status } : x)))
    try {
      await patch(`/api/clients/${c.id}`, { status })
    } catch (err) {
      console.error('[Clients] status update failed', err)
      setClients(cs => cs.map(x => (x.id === c.id ? { ...x, status: prev } : x)))
    }
  }

  const save = async () => {
    setSaving(true); setSaveError('')
    try {
      // Dupe check on create — non-blocking. First save surfaces any matches;
      // saving again (dupes already shown) creates anyway.
      if (!selected && dupes.length === 0) {
        const q = new URLSearchParams()
        const nm = `${form.first_name || ''} ${form.last_name || ''}`.trim()
        if (nm) q.set('name', nm)
        if (form.phone) q.set('phone', form.phone)
        if (form.email) q.set('email', form.email)
        if ([...q.keys()].length) {
          const res = await get(`/api/clients/check-duplicate?${q.toString()}`).catch(() => null)
          if (res?.duplicates?.length) { setDupes(res.duplicates); setSaving(false); return }
        }
      }
      const url = selected
        ? `/api/clients/${selected.id}`
        // POST bypasses the server-side dedup guard when the operator has
        // already reviewed the matches on this create attempt (dupes.length > 0).
        // Without force the server 409s on a duplicate hit — that path is what
        // catches webhooks / API callers that skip check-duplicate.
        : `/api/clients${dupes.length ? '?force=true' : ''}`
      selected ? await patch(url, form) : await post(url, form)
      await load(); setShowForm(false); setSelected(null); setForm(EMPTY); resetPhones(); setDupes([])
    } catch (e) {
      // Server-side dedup 409 — the client-side check missed something (a
      // ContactPhone match, a race). Surface the same dupes UI so the operator
      // can review and retry with force.
      const serverDupes = e?.detail?.duplicates || e?.body?.duplicates
      if (Array.isArray(serverDupes) && serverDupes.length) {
        setDupes(serverDupes)
        setSaveError('')
      } else {
        setSaveError(e.message || 'Failed to save')
      }
    }
    setSaving(false)
  }

  const handleImport = async (e) => {
    const f = e.target.files?.[0]; if (!f) return
    setImporting(true); setImportResult(null)
    const fd = new FormData(); fd.append('file', f)
    try {
      const data = await upload('/api/clients/import-xlsx', fd)
      setImportResult(data); await load()
    } catch (err) { setImportResult({ error: err.message }) }
    setImporting(false); e.target.value = ''
  }

  // The backend hard-deletes the client AND cascades over everything attached
  // (properties, jobs, quotes, invoices, conversations, activity history) with
  // no dependent-record guard — the confirm has to carry the full weight.
  const deleteClient = async (id) => {
    const ok = await confirmDialog(
      'This permanently deletes the client and everything attached to them — ' +
      'their properties, jobs, quotes, invoices, and message history. It cannot be undone.\n\n' +
      'To keep the history, set their status to Inactive instead.',
      { title: 'Delete client?', confirmLabel: 'Delete permanently', danger: true }
    )
    if (!ok) return
    try {
      await del(`/api/clients/${id}`)
      await load(); setShowForm(false); setSelected(null); resetPhones()
    } catch (e) {
      toast.error('Could not delete: ' + (e?.message || 'unknown error'))
    }
  }

  const bulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const ok = await confirmDialog(
      `Permanently delete ${ids.length} client${ids.length === 1 ? '' : 's'}? ` +
      `Each client's properties, jobs, quotes, invoices, and message history are deleted with them. ` +
      `This cannot be undone.`,
      { title: `Delete ${ids.length} client${ids.length === 1 ? '' : 's'}?`, confirmLabel: 'Delete permanently', danger: true }
    )
    if (!ok) return
    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(ids.map(id => del(`/api/clients/${id}`)))
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) toast.error(`Deleted ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      clearSelection()
      await load()
    } finally {
      setBulkDeleting(false)
    }
  }

  const openMerge = () => {
    const [a, b] = Array.from(selectedIds).map(id => clients.find(c => c.id === id)).filter(Boolean)
    if (!a || !b) return
    setMergeModal({ a, b })
    // Default the survivor to the more-complete / active record.
    const score = c => (c.status === 'active' ? 2 : 0) + (c.email ? 1 : 0) + (c.phone ? 1 : 0)
    setMergeWinner(score(b) > score(a) ? b.id : a.id)
  }

  const doMerge = async () => {
    if (!mergeModal || !mergeWinner) return
    const winner = mergeWinner
    const loser = mergeModal.a.id === winner ? mergeModal.b.id : mergeModal.a.id
    setMerging(true)
    try {
      await post(`/api/clients/${winner}/merge`, { loser_id: loser })
      toast.success('Clients merged')
      setMergeModal(null); clearSelection(); await load()
    } catch (e) {
      toast.error('Could not merge: ' + (e?.message || 'unknown error'))
    }
    setMerging(false)
  }

  return {
    saving, saveError,
    importing, importResult, setImportResult,
    bulkDeleting,
    mergeModal, setMergeModal,
    mergeWinner, setMergeWinner,
    merging,
    updateStatus, save, handleImport, deleteClient, bulkDelete, openMerge, doMerge,
  }
}
