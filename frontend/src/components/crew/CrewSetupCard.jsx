/**
 * "Get set up on your phone" — a small crew card with two jobs:
 *   1. How to save the app to the home screen (platform-detected wording),
 *      shown only while the app is NOT already installed.
 *   2. Enable push notifications on this device (job assignments, office
 *      messages, morning digest). Hidden when the browser can't do push or
 *      the server has no VAPID keys — it degrades to just the install tip.
 *
 * On Today it's dismissible (localStorage flag); the Me tab renders it with
 * `persistent` so setup stays reachable after dismissal. Renders nothing at
 * all when there's nothing left to set up.
 */
import { useEffect, useState } from 'react'
import { Bell, CheckCircle2, Smartphone, X } from 'lucide-react'
import { pushSupported, getPushState, enablePush, isAppInstalled, mobilePlatform } from '../../utils/push'
import { useNotificationPrefs } from '../../hooks/useNotificationPrefs'

const DISMISS_KEY = 'bb_crew_setup_dismissed'

const CREW_CATEGORY_LABELS = {
  job_assignments: 'New jobs assigned to me',
  office_messages: 'Messages from the office',
  time_off: 'Time-off decisions',
  digest: 'Morning digest',
}

/** Account-wide category toggles — independent of THIS device's subscription
 *  state, so it's reachable even before push is turned on here. Only shown
 *  on the Me tab (`persistent`): a settings list, not onboarding chrome. */
function CrewNotificationCategoryList() {
  const { prefs, toggle } = useNotificationPrefs()
  if (!prefs) return null
  return (
    <div className="mt-2.5 border-t border-hairline pt-2.5 space-y-2">
      <p className="text-[11px] font-semibold text-ink-2">What you get notified about</p>
      {Object.entries(CREW_CATEGORY_LABELS).map(([key, label]) => {
        const on = prefs[key] !== false
        return (
          <div key={key} className="flex items-center justify-between gap-3 min-h-8">
            <span className="flex items-center gap-2 text-[12px] text-ink-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${on ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {label}
            </span>
            <button type="button" onClick={() => toggle(key)} aria-pressed={on}
              className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
                on ? 'bg-indigo-600' : 'bg-hairline-2'
              }`}>
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                on ? 'translate-x-4' : 'translate-x-0'
              }`} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export default function CrewSetupCard({ persistent = false }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  const [push, setPush] = useState(null)   // null = still checking
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!pushSupported()) { setPush({ supported: false }); return }
    getPushState().then(setPush).catch(() => setPush({ supported: false }))
  }, [])

  if (!persistent && dismissed) return null

  const installed = isAppInstalled()
  const os = mobilePlatform()
  // Push is offerable only when the browser can do it AND the server has keys
  // AND the user hasn't hard-blocked the permission.
  const canOfferPush = !!(push?.supported && push?.enabledOnServer && push?.permission !== 'denied')
  const pushOn = !!push?.subscribed

  const showInstall = !installed
  const showPush = canOfferPush || (pushOn && push?.supported)
  // On the Me tab (persistent) the card also carries account-wide category
  // preferences, which don't depend on THIS device's push support — so it
  // stays mounted there even when install/push have nothing left to say.
  if (!persistent && !showInstall && !showPush) return null
  if (push === null && !showInstall && !persistent) return null   // still checking, nothing else to say yet

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
    setDismissed(true)
  }

  const turnOn = async () => {
    setBusy(true); setError(null)
    try { setPush(await enablePush()) }
    catch (e) { setError(e?.message || 'Could not turn on notifications') }
    finally { setBusy(false) }
  }

  return (
    <div className="bg-panel rounded-xl border border-hairline shadow-glass-sm p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-bold text-ink flex items-center gap-1.5">
          <Smartphone className="w-4 h-4 text-ink-3" /> Get set up on your phone
        </div>
        {!persistent && (
          <button onClick={dismiss} aria-label="Dismiss"
            className="shrink-0 grid place-items-center w-8 h-8 -mt-1.5 -mr-1.5 rounded-lg text-ink-3 hover:text-ink hover:bg-bg-2">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {showInstall && (
        <p className="text-[12px] text-ink-2 mt-1.5 leading-relaxed">
          {os === 'ios' && (<>
            Save this app to your home screen: in Safari, tap <span className="font-semibold">Share</span>
            {' '}(the square with the up arrow) → <span className="font-semibold">Add to Home Screen</span>.
          </>)}
          {os === 'android' && (<>
            Save this app to your home screen: in Chrome, tap the <span className="font-semibold">⋮ menu</span>
            {' '}→ <span className="font-semibold">Add to Home screen</span> (or <span className="font-semibold">Install app</span>).
          </>)}
          {os === 'other' && (<>
            On your phone, open this page and use your browser's{' '}
            <span className="font-semibold">Add to Home Screen</span> / <span className="font-semibold">Install app</span> option
            — it opens like a regular app after that.
          </>)}
          {os === 'ios' && !push?.supported && ' Installing it also unlocks notifications.'}
        </p>
      )}

      {showPush && (
        <div className={showInstall ? 'mt-2.5 border-t border-hairline pt-2.5' : 'mt-1.5'}>
          {pushOn ? (
            <div className="text-[12px] text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 shrink-0" /> Notifications are on for this device.
            </div>
          ) : (
            <>
              <button onClick={turnOn} disabled={busy}
                className="w-full min-h-11 text-[13px] font-semibold bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 disabled:opacity-60 py-2.5 rounded-lg transition-colors inline-flex items-center justify-center gap-1.5">
                <Bell className="w-4 h-4" /> {busy ? 'Turning on…' : 'Turn on notifications'}
              </button>
              <p className="text-[11px] text-ink-3 mt-1.5">
                A buzz when a job is assigned to you or the office messages you.
              </p>
            </>
          )}
          {error && (
            <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>
      )}

      {persistent && <CrewNotificationCategoryList />}
    </div>
  )
}
