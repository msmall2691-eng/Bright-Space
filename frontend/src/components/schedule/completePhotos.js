/**
 * Pure helpers for CompleteVisitModal's photo lane (audit §15). Keeping the
 * file-reading and merge logic out of the component makes it directly
 * unit-testable and keeps the modal readable.
 *
 * Shape on the wire:
 *   photos: Array<string | { kind: "upload", data_url, mime, name, size, added_at }>
 * The backend's `job.photos` JSON column already accepted whatever list came
 * in; the mixed shape lets uploads and pasted URLs coexist without a
 * migration. See backend/modules/scheduling/router.py JobCompleteRequest.
 */

/** Per-file byte cap. 5MB balances phone-photo reality (2-4MB after JPEG
 *  compression) against JSON-column bloat — anything bigger should be resized
 *  before upload rather than dumped into the row. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

/** Total photos per completion. 20 is generous for a residential clean and
 *  keeps the row's JSON blob under ~100MB in the worst case. */
export const MAX_TOTAL_PHOTOS = 20

/** Read one File as a base64 data URL and package it as the dict shape the
 *  backend stores. Rejects on FileReader error so the caller can surface a
 *  per-file message. `added_at` is captured client-side so we can order the
 *  gallery even before the job is persisted. */
export function readFileAsUpload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve({
        kind: 'upload',
        data_url: reader.result,
        mime: file.type || 'image/jpeg',
        name: file.name || 'photo',
        size: file.size,
        added_at: new Date().toISOString(),
      })
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

/** Combine the two lanes back into one array in the order the modal shows
 *  them: uploaded thumbnails first, then pasted URLs (one per non-empty line).
 *  Trims whitespace and drops blank lines so a stray newline doesn't leak an
 *  empty-string entry into the JSON blob. */
export function mergePhotosForSubmit(stagedUploads, urlLines) {
  const uploads = Array.isArray(stagedUploads) ? stagedUploads.filter(Boolean) : []
  const urls = String(urlLines || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  return [...uploads, ...urls]
}
