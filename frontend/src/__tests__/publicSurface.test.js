/**
 * A public page must not inherit the viewer's app theme.
 *
 * `body` paints a hardcoded white ground for everyone, and each `body.theme-*`
 * block redefines the ink tokens. The authenticated app never notices, because
 * its shell paints `bg-bg` over that white — but a public route has no shell,
 * so it took its TEXT colour from the viewer's theme and its GROUND from the
 * literal. On the dark theme `--ink` is #ededf0: white text on a white page.
 * Every sentence selling the arrangement on /apply was invisible.
 *
 * The asymmetry is what let it survive: a stranger with no localStorage gets
 * the default paper theme and reads it fine, while the owner, the office, the
 * crew and the office preview all have a theme set. It looked broken to
 * exactly the people who check it, and fine to the people it is for.
 *
 * This asserts the CONTRACT rather than any one colour: every token that any
 * theme block overrides must also be re-declared by `.public-surface`.
 * Otherwise adding a new themed token silently reopens the hole for that
 * token, and the next person to notice is an applicant who can't read the page.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'index.css'), 'utf8')
const app = readFileSync(join(here, '..', 'App.jsx'), 'utf8')

/** The custom properties declared inside blocks whose selector starts with
 *  `selectorStartsWith`. Brace-matched rather than regex-sliced: these rules
 *  live inside `@layer base { … }`, and a `[^}]*` body stops at the first
 *  closing brace of the nested block — which found nothing at all and would
 *  have made this whole test pass vacuously. */
function tokensIn(selectorStartsWith) {
  const found = new Set()
  let i = 0
  while ((i = css.indexOf(selectorStartsWith, i)) !== -1) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    // Must be a selector, not a mention inside a comment or another selector's
    // body: nothing but selector characters between the name and the brace.
    if (!/^[\w\s.,:#[\]()="'-]*$/.test(css.slice(i + selectorStartsWith.length, open))) {
      i += selectorStartsWith.length; continue
    }
    let depth = 0, end = open
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++
      else if (css[end] === '}' && --depth === 0) break
    }
    for (const [, name] of css.slice(open, end).matchAll(/(--[\w-]+)\s*:/g)) found.add(name)
    i = end
  }
  return found
}

describe('public surfaces are theme-proof', () => {
  it('re-declares every token any theme block overrides', () => {
    const themed = new Set()
    for (const sel of ['body.theme-', 'body.mode-clean']) {
      for (const t of tokensIn(sel)) themed.add(t)
    }
    expect(themed.size).toBeGreaterThan(3)   // the theme blocks were found at all

    const publicTokens = tokensIn('.public-surface')
    const missing = [...themed].filter(t => !publicTokens.has(t))
    expect(missing, `.public-surface must also reset: ${missing.join(', ')}`).toEqual([])
  })

  it('paints its own ground so ink and background come from one set', () => {
    const block = css.match(/\.public-surface\s*\{([^}]*)\}/)
    expect(block).toBeTruthy()
    expect(block[1]).toMatch(/background:\s*var\(--bg\)/)
    expect(block[1]).toMatch(/color:\s*var\(--ink\)/)
  })

  it('wraps the whole public route table, not individual routes', () => {
    // One wrapper around the entire public <Routes>, so a route added later is
    // covered without anybody remembering to opt it in.
    const idx = app.indexOf('public-surface')
    expect(idx).toBeGreaterThan(-1)
    const routesIdx = app.indexOf('<Routes>', idx)
    expect(routesIdx).toBeGreaterThan(idx)
    expect(app.slice(idx, routesIdx)).not.toMatch(/<Route\b/)
  })
})
