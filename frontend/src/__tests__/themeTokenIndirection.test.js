/**
 * BB-A11Y-05 — a `@theme` entry that points at a themed token must be `inline`.
 *
 * Tailwind v4 emits a plain `@theme` block as `:root, :host { … }`. Per the CSS
 * custom-property spec a `var()` inside such a declaration is substituted at
 * computed-value time ON THE ELEMENT THE DECLARATION APPLIES TO — `:root` — and
 * children inherit the already-resolved result. Every theme in this app is
 * declared one level below that, on `body` (`body.mode-clean`,
 * `body.mode-clean.theme-console`, `body.theme-neon`, `body.accent-*`; theme.js
 * toggles the classes on document.body and says so in a comment).
 *
 * So `--color-panel: var(--panel)` in a plain `@theme` resolved exactly once,
 * against the Paper defaults on `:root`, and every `bg-panel` / `bg-bg` /
 * `text-ink` / `text-ink-3` / `border-hairline` / `text-link` / `bg-indigo-*`
 * utility in the app was pinned there — in ALL FOUR themes, including the
 * default, whose `--panel` is `#ffffff` while cards actually painted `#fbf9f3`.
 * Measured in the running app: with `body.mode-clean.theme-console` set,
 * `getComputedStyle(body).--panel` read `#1a1a1e` while a real `.bg-panel` card
 * computed to `rgb(251, 249, 243)`. Picking Console in Settings repainted the
 * shell (the raw-`var()` rules and the `dark:` variant key off the class, not a
 * token) and left every panel, card and line of body text cream.
 *
 * `@theme inline` substitutes the value into the utility instead, so it resolves
 * at the element and follows the body class.
 *
 * This asserts the CONTRACT, not any one token: ANY `@theme` entry whose value
 * references a custom property that a `body.*` block redefines must live in an
 * `inline` block. Otherwise the next token added to the ramp silently pins
 * itself to the default theme, and the symptom — a theme picker that does
 * nothing — looks like a React bug rather than a CSS one.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'index.css'), 'utf8')

/** Strip comments first — a `--token:` inside prose would otherwise read as a
 *  declaration, and this file carries long explanatory comment blocks. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Brace-matched block extraction, same approach as publicSurface.test.js: these
 *  rules nest inside `@layer base { … }`, so a `[^}]*` body stops at the first
 *  closing brace of the nested block and finds nothing. */
function blocksMatching(re) {
  const found = []
  for (const m of bare.matchAll(re)) {
    const open = bare.indexOf('{', m.index)
    if (open === -1) continue
    let depth = 0
    let end = open
    for (; end < bare.length; end++) {
      if (bare[end] === '{') depth++
      else if (bare[end] === '}' && --depth === 0) break
    }
    found.push({ head: m[0], body: bare.slice(open + 1, end) })
  }
  return found
}

/** Declarations in a block body, as [name, value] pairs. Only top-level ones:
 *  a nested at-rule's declarations are not `@theme` entries. */
function declarations(body) {
  const flat = body.replace(/\{[^{}]*\}/g, '')
  return [...flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)].map(m => [m[1], m[2].trim()])
}

/** Every custom property a `var()` in this value reaches for, including the
 *  nested fallback in `var(--frame, var(--bg-2))`. */
function varsReferenced(value) {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1])
}

// `@theme`, `@theme inline`, `@theme static`, `@theme inline reference`, …
const themeBlocks = blocksMatching(/@theme\b[^{]*/g).map(b => ({
  inline: /\binline\b/.test(b.head),
  head: b.head.trim(),
  entries: declarations(b.body),
}))

/** Tokens redefined by a body-scoped block — i.e. tokens whose value depends on
 *  which theme/accent class is on <body>, and which therefore CANNOT be resolved
 *  at :root. Covers body.theme-*, body.mode-clean*, body.accent-*. */
const themedTokens = new Set()
for (const b of blocksMatching(/(?:^|[},;]|\*\/)\s*body\.[\w.-]+\s*(?:,\s*\n?\s*body\.[\w.-]+\s*)*(?=\{)/gm)) {
  for (const [name] of declarations(b.body)) themedTokens.add(name)
}

describe('BB-A11Y-05 — themed @theme entries must be inline', () => {
  it('parsed the file at all', () => {
    // Guard against a vacuous pass if the syntax or the regexes drift.
    expect(themeBlocks.length, 'no @theme block found').toBeGreaterThan(0)
    expect(
      themeBlocks.reduce((n, b) => n + b.entries.length, 0),
      'no @theme entries parsed',
    ).toBeGreaterThan(20)
    expect(themedTokens.size, 'no body.* theme block parsed').toBeGreaterThan(10)
    // The tokens this bug was actually about, so a rename can't quietly empty
    // the set and leave the guard green.
    for (const t of ['--panel', '--ink', '--bg', '--hairline', '--accent-600']) {
      expect(themedTokens, `body.* blocks no longer redefine ${t}`).toContain(t)
    }
  })

  it('every @theme entry pointing at a themed token lives in an inline block', () => {
    const pinned = []
    for (const block of themeBlocks) {
      if (block.inline) continue
      for (const [name, value] of block.entries) {
        const themed = varsReferenced(value).filter(v => themedTokens.has(v))
        if (themed.length) pinned.push(`${name}: ${value}   (themed: ${themed.join(', ')})`)
      }
    }
    expect(
      pinned,
      'These resolve once at :root and never follow the body theme class.\n' +
        'Move them into the `@theme inline { … }` block:\n  ' +
        pinned.join('\n  '),
    ).toEqual([])
  })

  it('keeps the themed entries together in one inline block', () => {
    // Not style policing: the inline block carries the explanation of WHY, and a
    // second home for these makes the next person re-derive it from scratch.
    const inlineWithThemed = themeBlocks.filter(
      b => b.inline && b.entries.some(([, v]) => varsReferenced(v).some(x => themedTokens.has(x))),
    )
    expect(inlineWithThemed.length, 'themed @theme entries should live in exactly one inline block').toBe(1)
    expect(
      inlineWithThemed[0].entries.length,
      'the inline block lost most of its entries — did something move back out?',
    ).toBeGreaterThan(20)
  })
})
