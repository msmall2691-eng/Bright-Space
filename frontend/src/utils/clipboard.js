/**
 * Copy `text` to the clipboard: navigator.clipboard where available (needs a
 * secure context), else the old textarea/execCommand fallback. Resolves true
 * on success. Credentials never leave the device — no logging, no URL.
 *
 * The fallback matters in the crew app: an installed PWA opened over plain
 * http (LAN testing) or an old WebView has no navigator.clipboard at all.
 */
export function copyToClipboard(text) {
  const legacy = () => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => legacy())
  }
  return Promise.resolve(legacy())
}
