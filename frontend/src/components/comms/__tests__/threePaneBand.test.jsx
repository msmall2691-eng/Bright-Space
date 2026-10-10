/**
 * Between 900px and 1280px, the pane that yields is the LIST — never the thread.
 *
 * Only xl: (1280) fits all three columns of the Messages page. ContactPanel
 * used to become an inline column at xl: only, and below that it rendered
 * `fixed inset-0` — a full-screen overlay. The arithmetic behind that was
 * right (three 340px panes don't fit at 940px) and the conclusion was wrong:
 * the owner's window is ~940px, so for her the customer panel was ALWAYS the
 * overlay. Every look at the next appointment, the balance owed or "Draft a
 * quote" covered the conversation she was reading, and she had to back out of
 * the panel to read it again.
 *
 * So the customer panel is a real column from shell: up, and the conversation
 * list steps out of the 900–1280 band while it's open. The thread — the thing
 * the operator is actually doing — is never the pane that goes.
 *
 * ## Why these are class-string assertions
 *
 * The behaviour under test IS the class string: jsdom has no layout engine and
 * no stylesheet here, so there is no width to query and no computed display to
 * read. Asserting the emitted variants is the honest version of this test, and
 * it catches the two regressions that matter — a breakpoint sliding back to
 * xl:, and a `shell:flex`/`shell:hidden` pair landing in one class list.
 *
 * That second one is the subtle one and the reason InboxLeftPanel composes its
 * display string in JS. Both halves of such a pair sit in the SAME media
 * query, so the winner is whichever Tailwind emitted later in the stylesheet,
 * not the order written in the JSX — the mixed-unit breakpoint bug BB-CSS-01
 * records, in miniature. Different breakpoints are safe because they sort by
 * width; the same breakpoint twice is a coin flip.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InboxLeftPanel } from '../InboxLeftPanel'
import { ThreadHeader } from '../ThreadHeader'

const DIR = dirname(fileURLToPath(import.meta.url))
const commsSrc = readFileSync(join(DIR, '..', '..', '..', 'pages', 'Comms.jsx'), 'utf8')
const panelSrc = readFileSync(join(DIR, '..', 'ContactPanel.jsx'), 'utf8')

afterEach(cleanup)

/** The left panel's own root element, whose class list is the thing at issue. */
const listClasses = (props) => {
  const { container } = render(
    <MemoryRouter>
      <InboxLeftPanel
        convs={[]} loadingList={false} selectedId={null}
        search="" setSearch={() => {}}
        channelFilter="" setChannelFilter={() => {}}
        channelCount={() => 0}
        folder="active" setFolder={() => {}}
        FOLDERS={[{ key: 'active', label: 'Active' }]}
        CHIPS={[]}
        chipFilters={new Set()} toggleChip={() => {}}
        onSelect={() => {}} onCompose={() => {}}
        {...props}
      />
    </MemoryRouter>,
  )
  return container.firstChild.className
}

describe('the conversation list yields the 900–1280 slot to the customer column', () => {
  it('is hidden in the band while the customer column is open', () => {
    const cls = listClasses({ mobileView: 'thread', hiddenForContact: true })
    // `hidden` with no shell: override => hidden from 0 up...
    expect(cls).toMatch(/(^|\s)hidden(\s|$)/)
    // ...until xl:, where all three columns fit and the list comes back.
    expect(cls).toMatch(/(^|\s)xl:flex(\s|$)/)
    expect(cls, 'a shell:flex here would re-show the list and squeeze the thread to nothing')
      .not.toMatch(/shell:flex/)
  })

  it('is visible in the band while the customer column is closed', () => {
    const cls = listClasses({ mobileView: 'thread', hiddenForContact: false })
    expect(cls).toMatch(/(^|\s)shell:flex(\s|$)/)
    expect(cls).not.toMatch(/shell:hidden/)
  })

  it('still owns the phone screen when it is the active pane', () => {
    // Below shell: exactly one pane shows, chosen by mobileView. The list
    // being the active pane must win regardless of the customer flag — on a
    // phone the customer panel is its own full-screen pane, not a column
    // competing for this slot.
    for (const hiddenForContact of [true, false]) {
      cleanup()
      const cls = listClasses({ mobileView: 'list', hiddenForContact })
      expect(cls, `mobileView=list, hiddenForContact=${hiddenForContact}`)
        .toMatch(/(^|\s)flex(\s|$)/)
    }
  })

  it('never puts flex and hidden in the same breakpoint', () => {
    // The regression this guards is a maintainer "simplifying" the composed
    // string back into appended conditional variants. Such a pair renders
    // correctly or inverted depending only on Tailwind's output order, so it
    // would pass review and fail on the owner's screen.
    for (const mobileView of ['list', 'thread', 'contact']) {
      for (const hiddenForContact of [true, false]) {
        cleanup()
        const cls = listClasses({ mobileView, hiddenForContact })
        for (const bp of ['shell:', 'xl:']) {
          const clash = cls.includes(`${bp}flex`) && cls.includes(`${bp}hidden`)
          expect(clash, `${bp} has both flex and hidden (mobileView=${mobileView}, hiddenForContact=${hiddenForContact}): "${cls}"`)
            .toBe(false)
        }
      }
    }
  })
})

describe('the customer panel is a column from shell:, not xl:', () => {
  it('leaves the fixed overlay behind at shell:', () => {
    // Read from source: rendering ContactPanel pulls in AiInsight (which
    // fetches) and the whole customer-360 shape for what is a one-line
    // assertion about two variants on one element.
    const root = panelSrc.slice(panelSrc.indexOf('<div className={`${mobileActive'))
      .slice(0, 400)
    expect(root, 'the overlay must stop being an overlay at shell:, not xl:')
      .toMatch(/shell:static/)
    expect(root, 'xl:static means the panel still covers the thread at 940px')
      .not.toMatch(/xl:static/)
    expect(root).toMatch(/desktopOpen \? 'shell:flex' : 'shell:hidden'/)
  })

  it('reserves the three-column width for xl: only', () => {
    // 300 in the band, 340 once the list is back alongside it at xl:. The
    // sidebar (shell:w-60 = 240px) takes its cut before the page sees any
    // width, so at the owner's ~940px window the page has 700px to divide —
    // 400 thread + 300 here. A flat 340 would cost the thread 40 of those.
    expect(panelSrc).toMatch(/shell:w-\[300px\] xl:w-\[340px\]/)
  })
})

describe('the open flag and the mobile pane move together', () => {
  it('defaults open only where all three columns fit', () => {
    // Defaulted to a bare `true`, the list would start collapsed at 940px:
    // first paint would be thread + customer, with the primary triage surface
    // missing and no indication why.
    const init = commsSrc.slice(commsSrc.indexOf('const [showContactPanel'))
      .slice(0, 400)
    expect(init, 'showContactPanel no longer defaults from an xl: query')
      .toMatch(/matchMedia\?\.\('\(min-width: 1280px\)'\)/)
  })

  it('closing the panel also leaves the contact pane', () => {
    const toggle = commsSrc.slice(commsSrc.indexOf('const toggleContactPanel'))
      .slice(0, 400)
    expect(toggle).toMatch(/const opening = !showContactPanel/)
    expect(toggle).toMatch(/setMobileView\(opening \? 'contact' : 'thread'\)/)
  })

  it('routes both of the panel exits through that one toggle', () => {
    // onBack (the phone back arrow) and onClose (the panel's own ✕) used to
    // set mobileView and the flag independently, so backing out of the panel
    // left the flag true — which in the band means a collapsed list with
    // nothing in its place.
    expect(commsSrc).toMatch(/onBack=\{toggleContactPanel\}/)
    expect(commsSrc).toMatch(/onClose=\{toggleContactPanel\}/)
    expect(commsSrc, 'ThreadHeader is setting panel state itself again')
      .not.toMatch(/setShowContactPanel=\{setShowContactPanel\}/)
  })

  it('tells assistive tech whether the column is already showing', () => {
    const onToggle = vi.fn()
    const detail = { id: 1, channel: 'sms', status: 'open', external_contact: '+12075551212' }
    render(
      <MemoryRouter>
        <ThreadHeader detail={detail} setMobileView={() => {}}
          onToggleContact={onToggle} contactOpen={false} onToggleStatus={() => {}} />
      </MemoryRouter>,
    )
    const btn = screen.getByRole('button', { name: /show customer details/i })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    btn.click()
    expect(onToggle).toHaveBeenCalledTimes(1)

    cleanup()
    render(
      <MemoryRouter>
        <ThreadHeader detail={detail} setMobileView={() => {}}
          onToggleContact={() => {}} contactOpen onToggleStatus={() => {}} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: /hide customer details/i })
      .getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the inbox vocabulary says Messages, not Comms', () => {
  /** Source with comments removed. The first version of this test asserted
   *  `/(in|into) Comms/` over the whole file and failed on RequestThreadPanel's
   *  own docstring — a sentence no operator will ever read. A guard that fires
   *  on a comment measures the wrong thing in both directions: it fails on
   *  harmless prose, and it would have passed had the LABEL been wrong and the
   *  comment right. */
  const prose = (file) => readFileSync(join(DIR, '..', '..', '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  // The nav and the page header already said Messages. The word survived in
  // exactly four rendered sentences — three about Gmail sync, one Requests
  // empty state. The file name, the /comms route and /api/comms/* are internal
  // and deliberately stay: renaming a route breaks every existing deep link.
  it.each([
    ['components/settings/EmailTab.jsx', /sync emails in Messages/],
    ['components/requests/RequestThreadPanel.jsx', /show up in Messages too/],
    ['components/GoogleAccountCard.jsx', /Gmail threads into Messages/],
    ['components/GoogleAccountCard.jsx', /Sync Gmail into Messages/],
  ])('%s reads "Messages"', (file, re) => {
    const src = prose(file)
    expect(src, `${file} should read ${re}`).toMatch(re)
    expect(src, `${file} still shows the operator the word "Comms"`)
      .not.toMatch(/\b(in|into) Comms\b/)
  })
})
