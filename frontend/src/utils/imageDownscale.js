/**
 * Client-side photo downscaling for job-photo uploads.
 *
 * Phone cameras produce 3-8MB originals (often HEIC on iPhones). Uploading
 * those from a driveway on one bar of LTE is the difference between "photos
 * work" and "photos spin forever", so we decode in the browser (the browser
 * can decode HEIC even when the server can't), resize to a sane inspection
 * size, and re-encode as JPEG — typically 200-400KB. The canvas re-encode
 * also strips EXIF (GPS etc.) as a side effect.
 *
 * The backend independently enforces a 5MB cap and byte-sniffs the type, so
 * this is a courtesy to the cleaner's data plan, not a security boundary.
 */

/** Longest edge of the stored image. 1600px prints fine and zooms enough to
 *  read "is the stovetop clean" — the actual consumer is a phone/laptop
 *  screen, not a billboard. */
export const MAX_DIMENSION = 1600
export const JPEG_QUALITY = 0.82

/** Fit w×h inside a maxDim square, preserving aspect. Never upscales.
 *  Pure — unit-tested directly. */
export function fitWithin(width, height, maxDim = MAX_DIMENSION) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const longest = Math.max(w, h)
  if (longest <= maxDim) return { width: w, height: h }
  const scale = maxDim / longest
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

/** Decode a File into something drawable. Prefers createImageBitmap (fast,
 *  applies EXIF orientation); falls back to an <img> element for older
 *  WebKit. Rejects if the browser can't decode the format at all. */
function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => decodeViaImgTag(file))
  }
  return decodeViaImgTag(file)
}

function decodeViaImgTag(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('undecodable image')) }
    img.src = url
  })
}

/**
 * File → downscaled JPEG Blob. Resolves null when the browser can't decode
 * or re-encode (rare); the caller decides whether to send the original
 * instead. Never throws.
 */
export async function downscaleToJpeg(file, { maxDim = MAX_DIMENSION, quality = JPEG_QUALITY } = {}) {
  try {
    const source = await decodeImage(file)
    const srcW = source.width || source.naturalWidth
    const srcH = source.height || source.naturalHeight
    if (!srcW || !srcH) return null
    const { width, height } = fitWithin(srcW, srcH, maxDim)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    // Photos re-encoded to JPEG lose alpha; paint white underneath so a
    // transparent PNG doesn't come out on a black background.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(source, 0, 0, width, height)
    if (typeof source.close === 'function') source.close()
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    return blob || null
  } catch {
    return null
  }
}

/** The upload-ready payload for one picked file: the downscaled JPEG when the
 *  browser managed it, else the original as-is (the server's 5MB cap has the
 *  final word). Returns { blob, filename }. */
export async function prepareForUpload(file) {
  const scaled = await downscaleToJpeg(file)
  if (scaled) {
    const base = (file.name || 'photo').replace(/\.[a-z0-9]+$/i, '')
    return { blob: scaled, filename: `${base}.jpg` }
  }
  return { blob: file, filename: file.name || 'photo' }
}
