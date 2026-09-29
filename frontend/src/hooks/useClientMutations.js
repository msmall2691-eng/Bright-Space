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
      if (selected) {
        await patch(`/api/clients/${selected.id}`, form)
      } else {
        // Create flow: one submit creates the client, then (best-effort) its
        // extra phone numbers and a first property + STR iCal feed, so the
        // operator isn't bounced across three screens. The client POST is the
        // only hard requirement; the follow-ups are non-fatal so a hiccup on
        // one never loses the client that was just created.
        //
        // ?force=true bypasses the server-side dedup guard once the operator has
        // reviewed the matches on this attempt (dupes.length > 0). Underscore-
        // prefixed keys are create-only UI state and must not reach ClientCreate.
        const clientPayload = Object.fromEntries(
          Object.entries(form).filter(([k]) => !k.startsWith('_')))
        const created = await post(`/api/clients${dupes.length ? '?force=true' : ''}`, clientPayload)
        const cid = created?.id

        if (cid && Array.isArray(form._extraPhones)) {
          for (const ph of form._extraPhones) {
            const num = (ph?.phone || '').trim()
            if (!num) continue
            try { await post(`/api/clients/${cid}/phones`, { phone: num, phone_type: ph.phone_type || 'mobile' }) }
            catch (err) { console.error('[Clients] extra phone add failed', err) }
          }
        }

        const addr = (form.address || '').trim()
        if (cid && form._addProperty && addr) {
          try {
            const prop = await post('/api/properties', {
              client_id: cid,
              name: addr,
              address: addr,
              city: form.city || null,
              state: form.state || null,
              zip_code: form.zip_code || null,
              property_type: form._propertyType || 'residential',
            })
            const icalUrl = (form._icalUrl || '').trim()
            if (prop?.id && form._propertyType === 'str' && icalUrl) {
              try { await post(`/api/properties/${prop.id}/icals`, { url: icalUrl, source: form._icalSource || 'airbnb' }) }
              catch (err) {
                console.error('[Clients] iCal feed add failed', err)
                toast.error('Client + property added, but the calendar feed didn’t save — add it from the property.')
              }
            }
          } catch (err) {
            console.error('[Clients] property create failed', err)
            toast.error('Client added, but the property didn’t save — add it from the client page.')
          }
        }
      }
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
      // BB-SEC-09: the server now refuses to cascade a client with real
      // history unless forced — surface ITS counts in a second, escalated
      // confirm so the final yes is informed by the database, not the UI's
      // guess.
      if (e?.status === 409) {
        let counts = null
        try { counts = JSON.parse(e.detail)?.counts } catch { /* not json */ }
        const parts = counts
          ? Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')
          : 'linked history'
        const really = await confirmDialog(
          `The server checked: this client has ${parts} that will be permanently deleted with them.\n\nDelete everything anyway?`,
          { title: 'Client has history', confirmLabel: 'Delete everything', danger: true }
        )
        if (!really) return
        try {
          await del(`/api/clients/${id}?force=true`)
          await load(); setShowForm(false); setSelected(null); resetPhones()
        } catch (e2) {
          toast.error('Could not delete: ' + (e2?.message || 'unknown error'))
        }
        return
      }
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
      // Bulk is a deliberate multi-select behind its own maximal confirm, so
      // it carries force — per-row second confirms for N clients would just
      // train click-through. (BB-SEC-09's guard still protects every other
      // caller.)
      const results = await Promise.allSettled(ids.map(id => del(`/api/clients/${id}?force=true`)))
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
