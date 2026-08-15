import { useEffect, useState } from 'react'
import { Bell, BellOff, Smartphone } from 'lucide-react'
import { get } from '../../api'
import {
  pushSupported, getPushState, enablePush, disablePush, sendTestPush,
  isAppInstalled, mobilePlatform,
} from '../../utils/push'

/** Push-notification opt-in for this device. Renders a single toggle that
 *  subscribes/unsubscribes the browser and a "Send test" button once on.
 *
 *  Owner report: "I'm still not seeing settings for notifications either" —
 *  this card used to return null outright when the browser can't do push
 *  (e.g. iOS Safari not installed to the Home Screen, where the Push API
 *  simply isn't exposed to a regular tab). Silently vanishing reads as "this
 *  feature doesn't exist" rather than "install the app first" — now it stays
 *  visible and explains why, with the same platform-detected copy the crew
 *  setup card uses, instead of disappearing. */
export default function NotificationsCard({ toast }) {
  const [state, setState] = useState(null)   // null = loading
  const [busy, setBusy] = useState(false)

  // Server-side diagnostics (owner report: "I'm not getting notifications at
  // all" — the why should be readable right here, not a debugging session).
  const [diag, setDiag] = useState(null)
  useEffect(() => {
    if (!pushSupported()) { setState({ supported: false }); return }
    getPushState().then(setState).catch(() => setState({ supported: false }))
    get('/api/push/status').then(setDiag).catch(() => {})
  }, [])

  if (state && state.supported === false) {
    const installed = isAppInstalled()
    const os = mobilePlatform()
    // Installing would fix an iOS/Android browser tab; on desktop, or once
    // already installed, it's just an unsupported browser — don't suggest a
    // step that won't help.
    const canFixByInstalling = !installed && (os === 'ios' || os === 'android')
    return (
      <div>
        <h2 className="text-lg font-bold text-ink mb-4">Notifications</h2>
        <div className="bg-panel rounded-xl border border-hairline p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 w-9 h-9 rounded-lg bg-bg-2 flex items-center justify-center shrink-0">
              <Smartphone className="w-4 h-4 text-ink-3" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-ink">Push notifications</span>
              <span className="block text-xs text-ink-3 mt-0.5 leading-relaxed">
                {canFixByInstalling ? (
                  os === 'ios' ? (<>
                    This browser can't receive notifications until the app is saved to your
                    Home Screen. In Safari, tap <span className="font-semibold">Share</span>
                    {' '}(the square with the up arrow) → <span className="font-semibold">Add to Home Screen</span>,
                    then open it from there and turn notifications on.
                  </>) : (<>
                    This browser can't receive notifications until the app is installed. In
                    Chrome, tap the <span className="font-semibold">⋮ menu</span> →{' '}
                    <span className="font-semibold">Add to Home screen</span> (or{' '}
                    <span className="font-semibold">Install app</span>), then open it from
                    there and turn notifications on.
                  </>)
                ) : (
                  'This browser doesn\'t support notifications. Try a current version of Chrome, Safari, or Edge.'
                )}
              </span>
            </span>
          </div>
          {diag && (
            <ul className="mt-3 space-y-1 text-xs text-ink-2">
              <li className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${diag.server_configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                Server {diag.server_configured ? 'configured' : 'not configured — add VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Railway'}
              </li>
              <li className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${diag.org_devices > 0 ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                {diag.org_devices} device{diag.org_devices === 1 ? '' : 's'} enrolled across the team
              </li>
            </ul>
          )}
        </div>
      </div>
    )
  }

  const on = !!state?.subscribed
  const serverReady = !!state?.enabledOnServer
  const blocked = state?.permission === 'denied'

  const toggle = async () => {
    setBusy(true)
    try {
      const next = on ? await disablePush() : await enablePush()
      setState(next)
      toast?.(on ? 'Notifications turned off' : 'Notifications on for this device', true)
    } catch (e) {
      toast?.(String(e?.message || 'Could not change notifications'), false)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    try {
      const r = await sendTestPush()
      toast?.(r?.sent ? 'Test sent — check your notifications' : 'No devices to notify yet', !!r?.sent)
    } catch {
      toast?.('Could not send a test', false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h2 className="text-lg font-bold text-ink mb-4">Notifications</h2>
      <div className="bg-panel rounded-xl border border-hairline p-5">
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-start gap-3">
            <span className="mt-0.5 w-9 h-9 rounded-lg bg-bg-2 flex items-center justify-center shrink-0">
              {on ? <Bell className="w-4 h-4 text-indigo-600" /> : <BellOff className="w-4 h-4 text-ink-3" />}
            </span>
            <span>
              <span className="block text-sm font-semibold text-ink">Push notifications</span>
              <span className="block text-xs text-ink-3 mt-0.5 leading-relaxed">
                Get a buzz on this device for new requests, new messages, and when a
                customer opens a quote. Works best installed to your Home Screen.
              </span>
            </span>
          </span>

          {/* iOS-style switch */}
          <button type="button" onClick={toggle} disabled={busy || !serverReady || blocked}
            aria-pressed={on}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${
              on ? 'bg-indigo-600' : 'bg-hairline-2'
            }`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
              on ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Where-it-stands checklist: each hop of the pipeline as a quiet
            dot+word line, so "not getting notifications" self-diagnoses. */}
        <ul className="mt-3 space-y-1 text-xs text-ink-2">
          <li className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${serverReady ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            Server {serverReady ? 'configured' : 'not configured — add VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Railway'}
          </li>
          <li className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${blocked ? 'bg-red-500' : on ? 'bg-emerald-500' : 'bg-gray-400'}`} />
            This device: {blocked ? 'blocked in browser settings' : on ? 'receiving' : 'not enrolled yet'}
          </li>
          {diag && (
            <li className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${diag.org_devices > 0 ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {diag.org_devices} device{diag.org_devices === 1 ? '' : 's'} enrolled across the team
              {diag.my_devices > 0 ? ` · ${diag.my_devices} yours` : ''}
            </li>
          )}
        </ul>

        {/* Status / help line */}
        {!serverReady ? (
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-3 flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5 shrink-0" />
            Not set up on the server yet — add VAPID keys (see docs/PUSH_NOTIFICATIONS.md).
          </p>
        ) : blocked ? (
          <p className="text-xs text-ink-3 mt-3">
            Notifications are blocked for this site. Re-enable them in your browser or
            iOS/Android site settings, then reload.
          </p>
        ) : on ? (
          <div className="mt-3 flex items-center gap-3">
            <button type="button" onClick={test} disabled={busy}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-40">
              Send a test notification
            </button>
          </div>
        ) : (
          <p className="text-xs text-ink-3 mt-3">Off — flip the switch to turn them on for this device.</p>
        )}
      </div>
    </div>
  )
}
