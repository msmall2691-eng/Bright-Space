import { useCallback, useState } from 'react'
import { del, patch, post } from '../api'
import { toast } from '../utils/toastBus'
import { confirmDialog } from '../utils/confirmBus'

/** Server-side mutations for the Properties page.
 *
 *  Owns transient action state:
 *   • saving         — save() in flight (form save button spinner)
 *   • syncing        — null | property id | 'all' (Sync button spinner)
 *   • syncResult     — banner payload from the last sync
 *   • sweep          — turnover-health payload from the last check
 *   • sweeping       — check-all in flight
 *   • rebuildingId   — property id being rebuilt right now
 *   • bulkDeleting   — bulk archive/delete in flight
 *
 *  Every mutation ends by calling `load()` from useProperties so the list
 *  reflects the change. UI state (form open/close, selection Set, iCal
 *  form draft) stays in Properties.jsx — the parent still coordinates
 *  those with the mutation results. */
export function usePropertyMutations({ load }) {
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(null)
  const [syncResult, setSyncResult] = useState(null)
  const [sweep, setSweep] = useState(null)
  const [sweeping, setSweeping] = useState(false)
  const [rebuildingId, setRebuildingId] = useState(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const save = useCallback(async ({ selected, form }) => {
    setSaving(true)
    try {
      const url = selected ? `/api/properties/${selected.id}` : '/api/properties'
      // Number inputs hold strings (and '' when blank). Coerce to a number or
      // null — sending '' to the backend's Optional[int]/Optional[float] fields
      // 422s the whole save. NaN (non-numeric) serializes to null in JSON, so a
      // stray keystroke degrades to "unset" rather than an error.
      const numOrNull = (v, parse) =>
        (v === '' || v === null || v === undefined ? null : parse(v))
      const body = {
        ...form,
        client_id: parseInt(form.client_id),
        default_duration_hours: parseFloat(form.default_duration_hours),
        default_crew_size: form.default_crew_size ? parseInt(form.default_crew_size) : null,
        bedrooms: numOrNull(form.bedrooms, (v) => parseInt(v, 10)),
        bathrooms: numOrNull(form.bathrooms, parseFloat),
        square_footage: numOrNull(form.square_footage, (v) => parseInt(v, 10)),
        year_built: numOrNull(form.year_built, (v) => parseInt(v, 10)),
      }
      selected ? await patch(url, body) : await post(url, body)
      await load()
      return { ok: true }
    } catch (e) {
      toast.error('Error saving property: ' + e.message)
      return { ok: false, error: e }
    } finally {
      setSaving(false)
    }
  }, [load])

  const addIcal = useCallback(async (propId, icalDraft) => {
    if (!icalDraft.url.trim()) return { ok: false, reason: 'empty' }
    try {
      // Timing/access (checkout time, duration, house code) come from the
      // property's own STR settings — no need to re-enter them per feed.
      await post(`/api/properties/${propId}/icals`, {
        url: icalDraft.url.trim(),
        source: icalDraft.source,
      })
      await load()
      return { ok: true }
    } catch (e) {
      toast.error('Error adding iCal: ' + e.message)
      return { ok: false, error: e }
    }
  }, [load])

  const removeIcal = useCallback(async (propId, icalId) => {
    if (!(await confirmDialog('Remove this iCal URL?'))) return
    try {
      await del(`/api/properties/${propId}/icals/${icalId}`)
      await load()
    } catch (e) {
      toast.error('Error removing iCal: ' + e.message)
    }
  }, [load])

  const syncOne = useCallback(async (id) => {
    setSyncing(id)
    setSyncResult(null)
    try {
      const data = await post(`/api/properties/${id}/sync`)
      setSyncResult({ id, ...data, ok: true })
      await load()
    } catch (e) {
      setSyncResult({ id, ok: false, error: String(e) })
    }
    setSyncing(null)
  }, [load])

  const syncAll = useCallback(async () => {
    setSyncing('all')
    setSyncResult(null)
    try {
      const data = await post('/api/properties/sync-all')
      setSyncResult({ id: 'all', ...data, ok: true })
      await load()
    } catch (e) {
      setSyncResult({ id: 'all', ok: false, error: String(e) })
    }
    setSyncing(null)
  }, [load])

  const runSweep = useCallback(async () => {
    setSweeping(true); setSweep(null); setSyncResult(null)
    try {
      const data = await post('/api/properties/turnover-sweep')
      setSweep(data)
    } catch (e) {
      setSweep({ error: String(e?.message || e) })
    }
    setSweeping(false)
  }, [])

  /** Fix one flagged property right from the health report: force-rebuild
   *  its turnovers from the feed, then re-run the sweep so the row
   *  re-verifies. */
  const rebuildOne = useCallback(async (propertyId) => {
    setRebuildingId(propertyId)
    try {
      await post(`/api/properties/${propertyId}/rebuild-turnovers`)
      const data = await post('/api/properties/turnover-sweep')
      setSweep(data)
    } catch (e) {
      setSweep(s => ({ ...(s || {}), error: String(e?.message || e) }))
    }
    setRebuildingId(null)
  }, [])

  const bulkDelete = useCallback(async ({ ids, hardDelete }) => {
    if (ids.length === 0) return { ok: false, reason: 'empty' }
    const verb = hardDelete ? 'permanently delete' : 'archive'
    const confirmed = await confirmDialog(
      `${verb[0].toUpperCase() + verb.slice(1)} ${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}? ${hardDelete ? 'This removes them from the database entirely.' : 'They will be soft-archived (active=false).'} `,
      { confirmLabel: verb[0].toUpperCase() + verb.slice(1), danger: hardDelete }
    )
    if (!confirmed) {
      return { ok: false, reason: 'cancelled' }
    }
    setBulkDeleting(true)
    try {
      if (hardDelete) {
        await post('/api/admin/properties/hard-delete', { ids })
      } else {
        const results = await Promise.allSettled(ids.map(id => del(`/api/properties/${id}`)))
        const failed = results.filter(r => r.status === 'rejected').length
        if (failed > 0) toast.error(`Archived ${ids.length - failed} of ${ids.length}. ${failed} failed.`)
      }
      await load()
      return { ok: true }
    } catch (e) {
      toast.error('Bulk delete failed: ' + (e?.message || 'unknown'))
      return { ok: false, error: e }
    } finally {
      setBulkDeleting(false)
    }
  }, [load])

  return {
    saving,
    syncing,
    syncResult, setSyncResult,
    sweep, setSweep,
    sweeping,
    rebuildingId,
    bulkDeleting,
    save,
    addIcal,
    removeIcal,
    syncOne,
    syncAll,
    runSweep,
    rebuildOne,
    bulkDelete,
  }
}
