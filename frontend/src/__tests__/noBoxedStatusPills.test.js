/**
 * Status is a BARE dot + word. No border, no `bg-panel`, no horizontal pad.
 *
 * The owner has rejected this chrome three separate times, most recently the
 * *quiet* version — a neutral dot+word wrapped in `border border-hairline-2
 * bg-panel px-2` ("those little bubbles" / "eww", Oct 2026). Three de-bubbling
 * sweeps shipped before this one and **sixteen instances survived all three**,
 * across eleven files: the inbox list rows, Settings' integration cards, the
 * Google account card, property rows, quote rows, the client calendar and
 * mobile header, the users admin, Crew, the board and Sync Center.
 *
 * They survived because every one is a hand-written class string. Nothing
 * pointed at them, so each sweep found whatever its author happened to grep
 * for. This is the grep, written once.
 *
 * ## Why this walks the AST instead of matching text
 *
 * Not fastidiousness — three regex versions of this audit gave three different
 * answers (18, then 15, then 21) and every one of them was wrong:
 *
 *   - a 4-line lookahead missed PropertyRow's dot, which sits five lines below
 *     its span because a multi-line `title` separates them;
 *   - a 200-character lookbehind for the owning tag matched a `<span>` that
 *     *began after* the match, so every secondary BUTTON followed by a dot
 *     counted as a violation.
 *
 * The AST gives 16 and agrees with reading the files. A guard whose number you
 * cannot trust is worse than no guard: it invites exactly the "I fixed the ones
 * it listed" that left sixteen behind.
 *
 * ## Buttons are not violations
 *
 * `bg-panel border border-hairline-2 text-ink-2 hover:bg-bg-2 rounded-md` IS
 * the design language's secondary-button spec. A button wearing it is correct,
 * which is why this matches on the element being a `<span>`. An interactive
 * status (`InlineSelect`) is also allowed a border on HOVER — resting fill is
 * the problem, not every border in the app.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function jsxFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { jsxFiles(full, out); continue }
    if (/\.jsx$/.test(name)) out.push(full)
  }
  return out
}

/** The literal text of an element's className attribute, expression and all. */
function classOf(open) {
  for (const attr of open.attributes?.properties || []) {
    if (attr.kind !== ts.SyntaxKind.JsxAttribute) continue
    if (attr.name?.getText?.() !== 'className') continue
    return attr.initializer ? attr.initializer.getText() : ''
  }
  return ''
}

const isBoxed = (cls) =>
  /border-hairline-2 bg-panel/.test(cls) && /\bpx-|\bpx\[/.test(cls)

/** True when some element INSIDE this one carries a `rounded-full` class —
 *  i.e. the 6px status dot. An icon or a Hash tag in a neutral chip is a
 *  different question and deliberately out of scope here. */
function containsStatusDot(node) {
  let found = false
  const scan = (n) => {
    if (n !== node) {
      const open = n.kind === ts.SyntaxKind.JsxElement ? n.openingElement
        : n.kind === ts.SyntaxKind.JsxSelfClosingElement ? n : null
      if (open && /rounded-full/.test(classOf(open))) found = true
    }
    ts.forEachChild(n, scan)
  }
  scan(node)
  return found
}

function findBoxedStatusPills() {
  const hits = []
  const parseFailures = []
  for (const file of jsxFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    // A file this cannot parse must FAIL, never pass quietly. #1144 shipped an
    // orphan check that failed open for the same reason.
    if ((sf.parseDiagnostics || []).length) parseFailures.push(relative(SRC, file))
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.JsxElement) {
        const open = node.openingElement
        if ((open.tagName?.getText?.() || '') === 'span'
            && isBoxed(classOf(open))
            && containsStatusDot(node)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
          hits.push(`${relative(SRC, file)}:${line + 1}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { hits, parseFailures }
}

describe('status never wears a box', () => {
  const { hits, parseFailures } = findBoxedStatusPills()

  it('parses every jsx file it claims to check', () => {
    // Without this the guard returns zero for the wrong reason.
    expect(parseFailures).toEqual([])
  })

  it('finds no dot+word wrapped in a bordered panel box', () => {
    expect(hits, [
      'A boxed status "dot-pill" is back. The owner has rejected this chrome',
      'three times, most recently the quiet neutral version. Status is a bare',
      '6px dot + a sentence-case word in text-ink-2/ink-3, with nothing around',
      'it — see components/ui/StatusBadge.jsx, which is already the right shape.',
      'Drop `rounded-sm border border-hairline-2 bg-panel px-2` and any fixed',
      'h-5/h-6 (that height only existed to size the capsule).',
    ].join('\n')).toEqual([])
  })

  it('still checks a meaningful number of files', () => {
    // The sweep covered 11 files out of the whole tree; a walker that silently
    // stopped finding .jsx would make the assertion above vacuous.
    expect(jsxFiles(SRC).length).toBeGreaterThan(100)
  })
})

describe('what the guard deliberately allows', () => {
  // These are pinned so the guard is not "tightened" into flagging correct
  // code — which would be its own kind of false alarm, and the fastest way to
  // get a guard deleted.
  const parse = (jsx) => {
    const sf = ts.createSourceFile('t.jsx', jsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const found = []
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.JsxElement) {
        const open = node.openingElement
        if ((open.tagName?.getText?.() || '') === 'span'
            && isBoxed(classOf(open)) && containsStatusDot(node)) found.push(1)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return found.length
  }

  it('allows a secondary button in the documented panel style', () => {
    expect(parse(`<button className="rounded-md border border-hairline-2 bg-panel px-2 text-ink-2">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Needs you
    </button>`)).toBe(0)
  })

  it('allows a neutral chip holding an icon rather than a status dot', () => {
    // Tags and source labels (ContactPanel's Hash tags, SyncCenter's channel
    // chip) are identity, not status. Whether those should also lose the box
    // is a real question, and not one this guard answers.
    expect(parse(`<span className="rounded-sm border border-hairline-2 bg-panel px-2">
      <Hash className="w-2.5 h-2.5" /> turnovers
    </span>`)).toBe(0)
  })

  it('allows a bare dot + word', () => {
    expect(parse(`<span className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> Overdue
    </span>`)).toBe(0)
  })

  it('catches the shape it exists for', () => {
    // The guard has to be able to fail, so here is the exact pattern the sweep
    // removed, asserted positive.
    expect(parse(`<span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline-2 bg-panel px-2 text-[11px] font-medium text-ink-2">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> Overdue
    </span>`)).toBe(1)
  })
})
