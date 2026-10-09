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

// How far the LAST tile must stretch to close the row. A grid of N tiles in
// `cols` columns leaves `cols - (N % cols)` empty cells on the final row; the
// last tile spans them instead, so the panel never ends in a tile-sized hole.
// Literal class strings per span — Tailwind only emits what it can see whole.
// Every step names its span explicitly, `col-span-1` included: an unprefixed
// `col-span-3` (right for three tracks on a phone) otherwise carries up into
// the seven-track row and pushes the last tile onto a line of its own.
const SPAN = {
  base: { 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3' },
  sm: { 1: 'sm:col-span-1', 2: 'sm:col-span-2', 3: 'sm:col-span-3', 4: 'sm:col-span-4',
        5: 'sm:col-span-5', 6: 'sm:col-span-6', 7: 'sm:col-span-7' },
  shell: { 1: 'shell:col-span-1', 2: 'shell:col-span-2', 3: 'shell:col-span-3',
           4: 'shell:col-span-4' },
}
const fill = (n, cols) => cols - ((n % cols) || cols) + 1

/**
 * @param {boolean} wide — true when Home gave this panel the whole tail row
 *   rather than half of it (OpsBoard splits that row two-up only when there
 *   are systems/inbox notices to put beside it, and most mornings there are
 *   none). It decides the track count at shell:, which CSS cannot work out for
 *   itself: the same breakpoint means ~640px here and ~296px there.
 */
export default function QuickActions({ navigate, wide = false }) {
  const actions = createActionsFor(currentRole())
  if (actions.length === 0) return null
  const tiles = [...actions, ...HOME_ONLY]
  const n = tiles.length
  // Tracks by width; the last tile's span follows from each.
  const shellCols = wide ? 7 : 4
  const grid = `grid-cols-3 sm:grid-cols-7 ${wide ? '' : 'shell:grid-cols-4'}`
  const lastSpan = [
    SPAN.base[fill(n, 3)],
    SPAN.sm[fill(n, 7)],
    // Only when shell: actually changes the track count — otherwise the sm:
    // span is already the right one and still in force.
    wide ? '' : SPAN.shell[fill(n, shellCols)],
  ].filter(Boolean).join(' ')

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
        {/* Three across on a phone, seven — one clean row — from sm:, and four
            only when Home has put something beside this panel and halved it.

            This used to read `sm:grid-cols-4` with a note saying the ladder it
            wanted (`sm:grid-cols-7 shell:grid-cols-4`) was impossible, because
            Tailwind emitted the custom shell: block BEFORE stock sm: and the
            sm: rule won the cascade above 900px. That was BB-CSS-01, a
            mis-sorted breakpoint scale, and it is fixed at the root in
            index.css — shell: now beats sm: as every call site always assumed.
            The ladder works; this is it. If a shell: class here ever appears to
            do nothing again, check the breakpoint order first, don't work
            around it (src/__tests__/breakpointOrder.test.js guards it).

            Whatever the track count, the final tile stretches across whatever
            cells are left over, so the panel never ends on a hole — at the
            owner's ~940px full width that hole was a 148px gap after "Quick
            note". Checked at 380px (3 across), 940px full (7) and 940px
            two-up (4). */}
        <div className={`grid gap-2 ${grid}`}>
          {tiles.map((a, i) => (
            <button key={a.label} onClick={() => run(a)} data-testid={`qa-${a.label}`}
              className={`flex flex-col items-center gap-2 rounded-xl border border-hairline bg-bg-2/40 px-2 py-3 text-ink-2 transition-colors hover:border-indigo-500 hover:bg-indigo-500/5 hover:text-ink ${
                i === n - 1 ? lastSpan : ''}`}>
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
