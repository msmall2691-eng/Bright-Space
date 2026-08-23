/**
 * House photos & notes sheet (rental pack) — per-property reference gallery
 * ("how the beds should be made") + house notes, with add-a-note and
 * add-a-photo for the crew on site.
 *
 * Perf rule: NOTHING here loads until the sheet opens — my-day stays light.
 * Notes a cleaner adds arrive "pending" (office + author only) until the
 * office shares them with everyone.
 */
import { useCallback, useEffect, useState } from 'react'
import { Camera, Plus, Share2 } from 'lucide-react'
import { get, post, del, upload } from '../../api'
import { AuthImage, Skeleton } from '../ui'
import { prepareForUpload } from '../../utils/imageDownscale'
import { onCellular, enqueuePhoto } from './photoQueue'
import { ErrorNote, FullScreenSheet, SectionLabel } from './primitives'

export default function PropertySheet({ propertyId, propertyName, onClose }) {
  const [notes, setNotes] = useState(null)
  const [photos, setPhotos] = useState(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)   // e.g. "2 photos will send on WiFi"
  const [viewer, setViewer] = useState(null)   // full-screen photo

  const load = useCallback(() => {
    get(`/api/crew/properties/${propertyId}/notes`).then(setNotes).catch(() => setNotes([]))
    get(`/api/crew/properties/${propertyId}/photos`).then(setPhotos).catch(() => setPhotos([]))
  }, [propertyId])
  useEffect(() => { load() }, [load])

  const submitNote = async () => {
    const text = noteDraft.trim()
    if (!text) return
    setBusy(true); setError(null)
    try {
      await post(`/api/crew/properties/${propertyId}/notes`, { body: text })
      setNoteDraft(''); setAddingNote(false); load()
    } catch (e) {
      setError(e.detail || e.message || 'Could not save the note')
    } finally {
      setBusy(false)
    }
  }

  const uploadPhotos = async (files) => {
    if (!files?.length) return
    setBusy(true); setError(null); setNotice(null)
    // Reference photos are the definition of non-urgent: on cellular they go
    // to the on-device queue and send on WiFi (see photoQueue.js); anywhere
    // else — or if the queue is unavailable — they upload right away.
    const defer = onCellular()
    let queuedNow = 0
    try {
      for (let i = 0; i < files.length; i++) {
        const { blob, filename } = await prepareForUpload(files[i])
        const wasQueued = defer && await enqueuePhoto({
          url: `/api/crew/properties/${propertyId}/photos`, blob, filename,
        })
        if (wasQueued) { queuedNow++; continue }
        const form = new FormData()
        form.append('file', blob, filename)
        await upload(`/api/crew/properties/${propertyId}/photos`, form)
      }
      if (queuedNow > 0) {
        setNotice(`${queuedNow} photo${queuedNow > 1 ? 's' : ''} saved — they'll send on WiFi and show up here after.`)
      }
      load()
    } catch (e) {
      setError(e.detail || e.message || 'Could not upload')
    } finally {
      setBusy(false)
    }
  }

  const removePhoto = async (p) => {
    setBusy(true)
    try { await del(`/api/crew/properties/${propertyId}/photos/${p.id}`); setViewer(null); load() }
    catch (e) { setError(e.detail || e.message || 'Could not delete') }
    finally { setBusy(false) }
  }

  return (
    <FullScreenSheet title={propertyName || 'This house'}
      subtitle="Photos & notes for everyone who cleans here" onClose={onClose}>
      <div className="max-w-lg mx-auto px-4 py-4 pb-16 space-y-5">
        <ErrorNote>{error}</ErrorNote>
        {notice && (
          <p className="text-[12px] text-ink-2 flex items-start gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 mt-[5px]" /> {notice}
          </p>
        )}

        {/* Photos */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <SectionLabel>How it should look</SectionLabel>
            <label className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 inline-flex items-center gap-1 cursor-pointer">
              <Camera className="w-3.5 h-3.5" /> Add photo
              <input type="file" accept="image/*" multiple className="hidden" disabled={busy}
                onChange={e => { uploadPhotos([...e.target.files]); e.target.value = '' }} />
            </label>
          </div>
          {!photos && <Skeleton className="h-24 w-full rounded-xl" />}
          {photos?.length === 0 && (
            <p className="text-[12px] text-ink-3">
              No reference photos yet — snap the staged rooms after a clean
              (beds, towels, supplies shelf) so the next person sees the target.
            </p>
          )}
          <div className="grid grid-cols-3 gap-1.5">
            {(photos || []).map(p => (
              <button key={p.id} onClick={() => setViewer(p)} className="relative aspect-square">
                <AuthImage src={p.url} alt={p.caption || 'reference photo'}
                  className="w-full h-full object-cover rounded-lg" />
              </button>
            ))}
          </div>
        </section>

        {/* Notes */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <SectionLabel>House notes</SectionLabel>
            {!addingNote && (
              <button onClick={() => setAddingNote(true)}
                className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 inline-flex items-center gap-0.5">
                <Plus className="w-3.5 h-3.5" /> Add note
              </button>
            )}
          </div>
          {addingNote && (
            <div className="space-y-2 mb-3">
              <textarea value={noteDraft} rows={3} maxLength={2000} autoFocus
                onChange={e => setNoteDraft(e.target.value)}
                placeholder="e.g. Upstairs shower drain clogs — check before leaving."
                className="w-full rounded-lg border border-hairline bg-panel px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-blue-400 resize-none" />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] text-ink-3">
                  Goes to the office first — they share it with the whole crew.
                </span>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => setAddingNote(false)} disabled={busy}
                    className="text-[12px] font-semibold text-ink-2 px-3 py-1.5">Cancel</button>
                  <button onClick={submitNote} disabled={busy || !noteDraft.trim()}
                    className="text-[12px] font-semibold bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg disabled:opacity-60">
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!notes && <Skeleton className="h-16 w-full rounded-xl" />}
          {notes?.length === 0 && !addingNote && (
            <p className="text-[12px] text-ink-3">Nothing yet — know a quirk of this house? Add it.</p>
          )}
          <div className="space-y-1.5">
            {(notes || []).map(n => (
              <div key={n.id} className="rounded-lg border border-hairline bg-panel px-3 py-2 text-[12.5px] text-ink-2">
                {n.body}
                <div className="text-[10.5px] text-ink-3 mt-0.5 flex items-center gap-1">
                  {n.author_name}{!n.shared && (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                      <Share2 className="w-3 h-3" /> waiting for the office to share
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {viewer && (
        <div className="fixed inset-0 z-40 bg-black/90 flex flex-col" onClick={() => setViewer(null)}>
          <div className="flex-1 flex items-center justify-center p-3">
            <AuthImage src={viewer.url} alt={viewer.caption || 'reference photo'}
              className="max-w-full max-h-full object-contain rounded-lg" />
          </div>
          <div className="px-4 pb-6 text-center space-y-2" onClick={e => e.stopPropagation()}>
            {viewer.caption && <div className="text-white text-[13px]">{viewer.caption}</div>}
            {viewer.mine && (
              <button onClick={() => removePhoto(viewer)} disabled={busy}
                className="text-[12px] font-semibold text-red-300 underline underline-offset-2">
                Delete my photo
              </button>
            )}
          </div>
        </div>
      )}
    </FullScreenSheet>
  )
}
