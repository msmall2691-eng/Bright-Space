import { StickyNote } from 'lucide-react'
import { createActionsFor, currentRole } from '../../nav/routes'

/**
 * Quick actions on Home — one-tap tiles for the things the owner starts most.
 *
 * The tiles are DERIVED from the route manifest: `createActionsFor()` returns
 * the same CREATE_ACTIONS list the topbar "+ New" menu (Header.jsx) and the
 * ⌘/ switcher (GlobalSearch.jsx) render, in the same order, with the same
 * labels and icons. Adding a create flow in nav/routes.js lights it up in all
 * three places — they can't drift, because there is only one list. (This
 * comment used to claim that while keeping a second hardcoded copy right here,
 * which had already drifted four ways; QuickActions.test.jsx now fails if the
 * tiles and the manifest ever disagree again.)
 *
 * "Quick note" is the one exception, and it is deliberately NOT in the
 * manifest: it has no URL. It fires a window event the StickyNotes widget
 * listens for (StickyNotes.jsx), and StickyNotes mounts only on Home — in the
 * "+ New" menu or the switcher, offered from every page, it would be a dead row
 * everywhere but here. Dashboard-only extras live below, as an explicit append.
 *
 * Office-only, and the gate is the manifest's own: createActionsFor returns []
 * for anyone but admin/manager (every create flow is a backend write), and an
 * empty list renders nothing. A viewer/cleaner doesn't get a Quick-note-only
 * widget — the whole panel is a create surface, and the notes widget below it
 * has its own "+" either way.
 */

// Dashboard-only extras — appended AFTER the manifest's actions, never mixed
// into it. `event` instead of `to`: see the docstring above.
const HOME_ONLY = [
  { label: 'Quick note', icon: StickyNote, event: 'bb:add-note' },
]

export default function QuickActions({ navigate }) {
  const actions = createActionsFor(currentRole())
  if (actions.length === 0) return null
  const tiles = [...actions, ...HOME_ONLY]

  const run = (a) => {
    if (a.event) { try { window.dispatchEvent(new CustomEvent(a.event)) } catch { /* no-op */ } return }
    navigate(a.to)
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-panel" data-testid="home-quick-actions">
      <header className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
        <span className="text-[13px] leading-none" aria-hidden="true">⚡</span>
        <h2 className="text-[11px] font-medium text-ink-3">Quick actions</h2>
      </header>
      <div className="p-2.5">
        {/* 7 tiles, 4 across from sm: — not the old 6. Home's tail row splits
            two-up at shell: (OpsBoard.jsx), so at the owner's ~940px window
            this widget is ~296px wide, not ~650px: six tracks gave 43px tiles
            that wrapped "Text a client" onto three lines and left the row a
            hair wider than its own panel. Four give ~68px and at most two
            lines. Deliberately NOT `sm:grid-cols-7 shell:grid-cols-4` for a
            denser mid-range: Tailwind emits the custom shell: block BEFORE
            stock sm:, so above 900px the sm: rule wins the cascade and the
            shell: override silently does nothing (measured: 7 tracks of 35px).
            Any shell: grid class here must not collide with an sm: one.
            Checked at 380px (3 across, ~103px) and 940px two-up (4, ~68px). */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {tiles.map(a => (
            <button key={a.label} onClick={() => run(a)} data-testid={`qa-${a.label}`}
              className="flex flex-col items-center gap-2 rounded-xl border border-hairline bg-bg-2/40 px-2 py-3 text-ink-2 transition-colors hover:border-indigo-500 hover:bg-indigo-500/5 hover:text-ink">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-hairline bg-panel">
                <a.icon className="h-4 w-4 text-link" />
              </span>
              <span className="text-center text-[11px] font-semibold leading-tight">{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
