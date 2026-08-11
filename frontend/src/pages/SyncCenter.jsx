import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Radar, RefreshCw, Calendar, Users, Home, Repeat, ArrowRight, ArrowLeft,
  ArrowLeftRight, Crown, AlertTriangle, CheckCircle2, ChevronDown, Zap,
  Clock, ExternalLink, Loader2, WifiOff, PauseCircle,
} from 'lucide-react'
import { PageHeader, Button } from '../components/ui'
import { post } from '../api'
import { toast } from '../utils/toastBus'
import { useSyncOverview } from '../hooks/useSyncOverview'

/**
 * Sync Control Center (`/sync`) — one screen for the whole scheduling nervous
 * system. The engine was already sound (BrightBase is the master; it pushes
 * one-way to Google + Connecteam, pulls Airbnb/VRBO turnovers inbound, and
 * generates recurring visits itself) — but that truth was scattered across a
 * health pill, a toggles panel, per-feed status on property pages, and ~14
 * invisible background ticks. This page makes it legible: every connected
 * schedule as a card (which way it flows, who wins a conflict, when it last
 * synced, what's waiting), the background jobs finally visible, an attention
 * list of only what a human should act on, and one master auto-pilot switch.
 *
 * All reads come from GET /api/jobs/sync-overview. All actions reuse existing
 * endpoints (settings/automation, jobs/sync-reconcile, jobs/push-to-gcal,
 * properties/sync-all, recurring/generate-all) — this page adds a control
 * surface, it doesn't add new sync machinery.
 */

// Per-channel "Sync now" → the existing endpoint that flushes that channel.
// reconcile pushes unsynced jobs to Google AND dispatches Connecteam shifts,
// so it's the right catch-up for the outbound crew side.
const SYNC_ENDPOINT = {
  gcal: '/api/jobs/push-to-gcal',
  reconcile: '/api/jobs/sync-reconcile',
  ical: '/api/properties/sync-all',
  recurring: '/api/recurring/generate-all',
}

// The automation flags the master auto-pilot switch flips together — the ones
// that pull, push, generate, dispatch, and reconcile on their own. Reconcile is
// included so "auto-pilot off" actually stops the 30-min self-heal tick;
// otherwise it would keep pushing to Google/Connecteam and "Manual syncs only"
// would be a lie.
const AUTOPILOT_KEYS = [
  'gcal_auto_sync_enabled',
  'ical_auto_sync_enabled',
  'recurring_auto_generate_enabled',
  'connecteam_auto_dispatch_enabled',
  'sync_reconcile_enabled',
]

function currentRole() {
  try { return (JSON.parse(localStorage.getItem('brightbase_user') || '{}').role) || '' }
  catch { return '' }
}

function relTime(iso) {
  if (!iso) return 'never'
  // Backend timestamps are naive UTC (no offset) — parse as UTC, not local.
  const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`
  const then = new Date(norm).getTime()
  if (Number.isNaN(then)) return '—'
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(norm).toLocaleDateString()
}

function cadence(mins) {
  if (!mins) return ''
  if (mins % 1440 === 0) { const d = mins / 1440; return d === 1 ? 'daily' : `every ${d} days` }
  if (mins % 60 === 0) { const h = mins / 60; return h === 1 ? 'hourly' : `every ${h}h` }
  return `every ${mins} min`
}

const ICON = { calendar: Calendar, users: Users, home: Home, repeat: Repeat }

const STATUS = {
  ok:           { dot: 'bg-emerald-500', text: 'text-emerald-600', label: 'In sync' },
  syncing:      { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600', label: 'Syncing' },
  paused:       { dot: 'bg-slate-400', text: 'text-ink-3', label: 'Paused' },
  attention:    { dot: 'bg-amber-500', text: 'text-amber-600', label: 'Needs attention' },
  disconnected: { dot: 'bg-red-500', text: 'text-red-600', label: 'Not connected' },
}

function DirectionChip({ direction }) {
  const cfg = {
    out:      { Icon: ArrowRight,     label: 'Pushes out',  cls: 'bg-blue-500/10 text-blue-600' },
    in:       { Icon: ArrowLeft,      label: 'Pulls in',    cls: 'bg-amber-500/10 text-amber-600' },
    two_way:  { Icon: ArrowLeftRight, label: 'Two-way',     cls: 'bg-violet-500/10 text-violet-600' },
    internal: { Icon: Repeat,         label: 'Internal',    cls: 'bg-slate-500/10 text-ink-3' },
  }[direction] || {}
  if (!cfg.Icon) return null
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${cfg.cls}`}>
      <cfg.Icon className="w-3 h-3" /> {cfg.label}
    </span>
  )
}

function AuthorityLine({ authority }) {
  const txt = authority === 'brightbase' ? 'BrightBase wins conflicts'
    : authority === 'google' ? 'Google wins conflicts'
    : authority === 'external' ? 'The rental calendar sets the dates'
    : ''
  if (!txt) return null
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
      <Crown className="w-3 h-3 text-amber-500" /> {txt}
    </span>
  )
}

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      title={disabled ? 'Needs admin access' : on ? 'Turn off' : 'Turn on'}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-indigo-600' : 'bg-bg-3'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  )
}

function ChannelCard({ ch, canToggle, canSync, busy, onToggle, onSync }) {
  const [showFeeds, setShowFeeds] = useState(false)
  const Icon = ICON[ch.icon] || Calendar
  const st = STATUS[ch.status] || STATUS.paused
  const syncing = busy === `sync:${ch.key}`
  const toggling = busy === `toggle:${ch.key}`

  return (
    <div className="bg-panel border border-hairline rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-bg-2 grid place-items-center shrink-0">
          <Icon className="w-5 h-5 text-ink-2" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-ink truncate">{ch.name}</h3>
            <DirectionChip direction={ch.direction} />
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-2 h-2 rounded-full ${st.dot}`} />
            <span className={`text-xs font-medium ${st.text}`}>{st.label}</span>
            <span className="text-xs text-ink-3">· last sync {relTime(ch.last_sync_at)}</span>
          </div>
        </div>
        {ch.toggle_key && (
          <Toggle on={ch.enabled} disabled={!canToggle || toggling}
            onChange={() => onToggle(ch)} />
        )}
      </div>

      <p className="text-[13px] text-ink-2">{ch.summary}</p>

      <div className="flex items-center justify-between gap-2">
        <AuthorityLine authority={ch.authority} />
        {ch.sync_action && SYNC_ENDPOINT[ch.sync_action] && (
          <button
            onClick={() => onSync(ch)} disabled={!canSync || syncing}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed">
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Sync now
          </button>
        )}
      </div>

      {/* Airbnb feeds detail — the per-feed health that was buried on property pages. */}
      {ch.key === 'airbnb' && ch.feed_count > 0 && (
        <div className="border-t border-hairline pt-2">
          <button onClick={() => setShowFeeds(v => !v)}
            className="w-full flex items-center justify-between text-xs text-ink-3 hover:text-ink-2">
            <span>{ch.feed_count} feed{ch.feed_count === 1 ? '' : 's'} · {ch.turnovers_upcoming} upcoming turnover{ch.turnovers_upcoming === 1 ? '' : 's'}</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${showFeeds ? 'rotate-180' : ''}`} />
          </button>
          {showFeeds && (
            <ul className="mt-2 space-y-1.5">
              {ch.feeds.map(f => {
                const bad = f.status === 'failed' || f.status === 'retrying'
                return (
                  <li key={f.id} className="flex items-center justify-between gap-2 text-xs">
                    <Link to={`/properties/${f.property_id}`} className="truncate text-ink-2 hover:text-indigo-600">
                      <span className="capitalize">{f.source}</span> · {f.property}
                    </Link>
                    <span className={`inline-flex items-center gap-1 shrink-0 ${bad ? 'text-red-600' : 'text-ink-3'}`}
                      title={f.error || ''}>
                      <span className={`w-1.5 h-1.5 rounded-full ${bad ? 'bg-red-500' : 'bg-emerald-500'}`} />
                      {bad ? 'error' : relTime(f.last_synced_at)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function AttentionCard({ item, canSync, busy, onAction }) {
  const warn = item.level === 'warn'
  const acting = busy === `attn:${item.key}`
  return (
    <div className={`flex items-start gap-3 p-3.5 rounded-xl border ${warn ? 'border-amber-200 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30' : 'border-hairline bg-bg-2'}`}>
      <AlertTriangle className={`w-4.5 h-4.5 shrink-0 mt-0.5 ${warn ? 'text-amber-600' : 'text-ink-3'}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{item.title}</div>
        {item.detail && <div className="text-xs text-ink-3 mt-0.5">{item.detail}</div>}
      </div>
      {item.action && (
        item.action.kind === 'link' ? (
          <Link to={item.action.href}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 shrink-0 inline-flex items-center gap-1">
            {item.action.label} <ExternalLink className="w-3 h-3" />
          </Link>
        ) : (
          <button onClick={() => onAction(item)} disabled={!canSync || acting}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-40 shrink-0 inline-flex items-center gap-1">
            {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {item.action.label}
          </button>
        )
      )}
    </div>
  )
}

function BackgroundJobsPanel({ jobs }) {
  const [open, setOpen] = useState(false)
  const groups = { scheduling: 'Scheduling', health: 'Health checks', messaging: 'Customer messaging', other: 'Housekeeping' }
  return (
    <div className="bg-panel border border-hairline rounded-2xl overflow-hidden">
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-bg-2/50">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-ink-3" />
          <span className="font-semibold text-ink text-sm">Under the hood</span>
          <span className="text-xs text-ink-3">· {jobs.length} background jobs run on their own</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-hairline divide-y divide-hairline">
          {Object.keys(groups).map(g => {
            const rows = jobs.filter(j => j.group === g)
            if (!rows.length) return null
            return (
              <div key={g} className="px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">{groups[g]}</div>
                <ul className="space-y-1.5">
                  {rows.map(j => (
                    <li key={j.key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${j.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                        <span className="text-ink-2 truncate">{j.name}</span>
                      </span>
                      <span className="text-xs text-ink-3 shrink-0">{cadence(j.cadence_minutes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
          <div className="px-4 py-2.5 text-[11px] text-ink-3">
            These run automatically. Turn the ones that push, pull, generate, and dispatch on or off with the auto-pilot switch above.
          </div>
        </div>
      )}
    </div>
  )
}

export default function SyncCenter() {
  const { data, loading, error, refresh } = useSyncOverview()
  const [busy, setBusy] = useState(null)
  // Two capability levels, matching the backend exactly: "Sync now" endpoints
  // (sync-reconcile / push-to-gcal / sync-all / generate-all) allow managers,
  // but the settings/automation POST behind the pause + auto-pilot toggles is
  // admin-only — so managers must not be shown togglers that only 403.
  const role = currentRole()
  const canSync = ['admin', 'manager'].includes(role)
  const canToggle = role === 'admin'

  const runAction = useCallback(async (key, endpoint, body) => {
    setBusy(key)
    try {
      await post(endpoint, body || {})
      await refresh()
    } catch (e) {
      toast.error(e?.message || 'That didn’t go through — try again')
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const toggleChannel = useCallback((ch) => {
    runAction(`toggle:${ch.key}`, '/api/settings/automation', { [ch.toggle_key]: !ch.enabled })
  }, [runAction])

  const syncChannel = useCallback((ch) => {
    const ep = SYNC_ENDPOINT[ch.sync_action]
    if (ep) runAction(`sync:${ch.key}`, ep)
  }, [runAction])

  const doAttention = useCallback((item) => {
    const a = item.action
    if (a?.kind === 'sync' && SYNC_ENDPOINT[a.target]) {
      runAction(`attn:${item.key}`, SYNC_ENDPOINT[a.target])
    }
  }, [runAction])

  const toggleAutopilot = useCallback((on) => {
    const patch = Object.fromEntries(AUTOPILOT_KEYS.map(k => [k, on]))
    runAction('autopilot', '/api/settings/automation', patch)
  }, [runAction])

  const syncEverything = useCallback(async () => {
    setBusy('all')
    const steps = [
      ['Crews & Google', '/api/jobs/sync-reconcile'],
      ['Rental feeds', '/api/properties/sync-all'],
      ['Recurring visits', '/api/recurring/generate-all'],
    ]
    const failed = []
    for (const [label, ep] of steps) {
      try { await post(ep, {}) } catch { failed.push(label) }
    }
    await refresh()
    setBusy(null)
    if (failed.length) toast.error(`Synced, but these had trouble: ${failed.join(', ')}`)
    else toast.success('Everything synced')
  }, [refresh])

  if (loading && !data) {
    return (
      <div className="max-w-5xl mx-auto">
        <PageHeader title="Sync Control Center" icon={Radar} iconColor="violet" />
        <div className="px-4 sm:px-8 py-16 text-center text-sm text-ink-3">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-3" /> Reading your schedule…
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="max-w-5xl mx-auto">
        <PageHeader title="Sync Control Center" icon={Radar} iconColor="violet" />
        <div className="px-4 sm:px-8 py-16 text-center">
          <WifiOff className="w-6 h-6 text-ink-3 mx-auto mb-3" />
          <p className="text-sm text-ink-2">{error}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={refresh}>Try again</Button>
        </div>
      </div>
    )
  }

  const overallCfg = STATUS[data.overall] || STATUS.ok
  const ap = data.auto_pilot || { on: false }
  // When Google is the configured source of truth the conflict direction flips,
  // so the banner must not claim "Google edits don't overwrite yours".
  const googleAuthority = ap.toggles?.calendar_source_of_truth === 'google'

  return (
    <div className="max-w-5xl mx-auto pb-16">
      <PageHeader
        title="Sync Control Center" icon={Radar} iconColor="violet"
        subtitle="Every schedule BrightBase talks to — in one place"
        actions={
          canSync && (
            <Button onClick={syncEverything} disabled={busy === 'all'}>
              {busy === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Sync everything now
            </Button>
          )
        }
      />

      <div className="px-4 sm:px-8 space-y-4">
        {/* Master banner — the mental model + the one big switch. */}
        <div className="bg-panel border border-hairline rounded-2xl p-4 sm:p-5 flex items-start gap-4 flex-wrap">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${overallCfg.dot}`} />
            <div className="min-w-0">
              <div className="text-base font-bold text-ink">{data.headline}</div>
              <p className="text-[13px] text-ink-3 mt-0.5">
                <span className="font-semibold text-ink-2">BrightBase is the master.</span> Your schedule here is the
                source of truth — it pushes out to Google &amp; Connecteam, pulls Airbnb turnovers in, and keeps recurring
                visits filled.{' '}
                {googleAuthority
                  ? 'Google is set as the calendar’s source of truth, so time changes you make in Google sync back here.'
                  : 'Edits made directly in Google don’t overwrite yours.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <div className="text-xs font-semibold text-ink flex items-center gap-1.5 justify-end">
                {ap.on ? <Zap className="w-3.5 h-3.5 text-indigo-500" /> : <PauseCircle className="w-3.5 h-3.5 text-ink-3" />}
                Auto-pilot {ap.on ? 'on' : 'off'}
              </div>
              <div className="text-[11px] text-ink-3">{ap.on ? 'Runs itself' : 'Manual syncs only'}</div>
            </div>
            <Toggle on={ap.on} disabled={!canToggle || busy === 'autopilot'} onChange={toggleAutopilot} />
          </div>
        </div>

        {/* Attention — only what a human should act on. */}
        {data.attention?.length > 0 && (
          <div className="space-y-2">
            {data.attention.map(item => (
              <AttentionCard key={item.key} item={item} canSync={canSync} busy={busy} onAction={doAttention} />
            ))}
          </div>
        )}

        {/* Channels. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {data.channels.map(ch => (
            <ChannelCard key={ch.key} ch={ch} canToggle={canToggle} canSync={canSync} busy={busy}
              onToggle={toggleChannel} onSync={syncChannel} />
          ))}
        </div>

        {/* The 14 hidden hands, finally visible. */}
        <BackgroundJobsPanel jobs={data.background_jobs || []} />

        {!canSync && (
          <p className="text-[11px] text-ink-3 text-center">
            You’re viewing in read-only mode. Ask an admin to change sync settings.
          </p>
        )}
        {canSync && !canToggle && (
          <p className="text-[11px] text-ink-3 text-center">
            You can run syncs, but pausing channels and auto-pilot is admin-only.
          </p>
        )}
      </div>
    </div>
  )
}
