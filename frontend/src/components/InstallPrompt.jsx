import { useEffect, useRef, useState } from 'react'
import { Download, Share, X } from 'lucide-react'
import { useLocation } from 'react-router-dom'

/**
 * "Add to Home Screen" nudge — a quiet, dismissible card that invites the
 * person to install the PWA. The app has been installable for a while (see
 * public/manifest.webmanifest + sw.js); nothing ever asked. Installed, it
 * opens full-screen and the service worker's cache-first assets make a revisit
 * near-instant — most of all for a cleaner on rural cell data, which is why
 * this shows on the phone surface, not the desktop office window.
 *
 * Design-law: a hairline card, not a tinted banner, one primary action
 * (brightbase-design-language). It never nags: suppressed once installed,
 * for 60 days after a dismissal, above 900px, before sign-in, and on every
 * public/applicant route.
 *
 * Chrome/Android fire `beforeinstallprompt`, which main.jsx captures as early
 * as possible (it can fire before React mounts) and stashes on
 * window.__bbInstallEvent, re-announcing it as `bb:installable`. iOS Safari
 * never fires it, so there we show the manual Share → Add to Home Screen steps
 * instead of an Install button.
 */

const DISMISS_KEY = 'bb_a2hs_dismissed_at'
const SUPPRESS_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

function isStandalone() {
  try {
    // iOS exposes navigator.standalone; check it first so a browser without
    // matchMedia (or one that throws) still reports an installed iOS app.
    if (window.navigator.standalone === true) return true
    return window.matchMedia('(display-mode: standalone)').matches
  } catch { return false }
}

function isiOS() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  // iPadOS 13+ reports as a Mac; a touch-capable "Mac" is really an iPad.
  return /iphone|ipad|ipod/i.test(ua)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1)
}

function recentlyDismissed() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0)
    return at > 0 && Date.now() - at < SUPPRESS_MS
  } catch { return false }
}

function isNarrow() {
  // The phone surface where installing actually helps. try/catch so a jsdom
  // (no matchMedia) treats it as mobile rather than throwing.
  try { return window.matchMedia('(max-width: 899px)').matches } catch { return true }
}

// Routes where we never nag: the login screen and every public/applicant page.
function suppressedPath(p) {
  return p === '/login' || p === '/apply'
    || p.startsWith('/quote/') || p.startsWith('/job/')
    || p.startsWith('/pay/') || p.startsWith('/portal')
    || p.startsWith('/accept-invite')
}

function markDismissed() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignore */ }
}

export default function InstallPrompt() {
  const location = useLocation()
  const [show, setShow] = useState(false)
  const [ios, setIos] = useState(false)
  const deferred = useRef(null)

  useEffect(() => {
    if (isStandalone() || recentlyDismissed() || !isNarrow()) return
    // Only inside the app — never before sign-in or on a public link.
    let authed = false
    try { authed = !!localStorage.getItem('brightbase_jwt') } catch { /* ignore */ }
    if (!authed) return

    const consider = () => {
      if (window.__bbInstallEvent) {
        deferred.current = window.__bbInstallEvent
        setShow(true)
      }
    }
    consider()                                   // it may have fired pre-mount
    window.addEventListener('bb:installable', consider)

    const onInstalled = () => {
      markDismissed()
      deferred.current = null
      setShow(false)
    }
    window.addEventListener('appinstalled', onInstalled)

    // iOS Safari gives no event — offer the manual steps once the page settles.
    let t
    if (!window.__bbInstallEvent && isiOS()) {
      setIos(true)
      t = setTimeout(() => setShow(true), 1200)
    }
    return () => {
      window.removeEventListener('bb:installable', consider)
      window.removeEventListener('appinstalled', onInstalled)
      if (t) clearTimeout(t)
    }
  }, [])

  if (!show || suppressedPath(location.pathname)) return null

  const dismiss = () => { markDismissed(); setShow(false) }

  const install = async () => {
    const e = deferred.current
    if (!e) return
    try {
      e.prompt()
      await e.userChoice
    } catch { /* ignore — closing the sheet counts as handled */ }
    deferred.current = null
    try { window.__bbInstallEvent = null } catch { /* ignore */ }
    markDismissed()
    setShow(false)
  }

  return (
    <div
      className="no-print fixed inset-x-0 z-40 px-3 pointer-events-none"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 68px)' }}
    >
      <div className="pointer-events-auto mx-auto max-w-md rounded-xl border border-hairline bg-panel p-3 shadow-glass-sm">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-2 text-ink-2">
            {ios ? <Share className="h-4 w-4" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink">Add BrightBase to your home screen</p>
            {ios ? (
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                Tap the Share button, then{' '}
                <span className="font-medium text-ink-2">Add to Home Screen</span>
                {' '}— it opens full-screen and loads faster.
              </p>
            ) : (
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                Opens full-screen and loads faster, like a real app.
              </p>
            )}
            {!ios && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={install}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  Install
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="-m-1 rounded-md p-1 text-ink-3 hover:bg-bg-2 hover:text-ink-2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
