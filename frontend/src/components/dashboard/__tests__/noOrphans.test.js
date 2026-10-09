/**
 * Every tile in `components/dashboard/` is reachable from a page.
 *
 * `pages/Dashboard.jsx` was deleted in #726 — a PR whose own title said "dead
 * code" — and its six collaborators were left behind: `useDashboardData` (a
 * ten-request `Promise.allSettled` fan-out), `useDashboardDerived`, and the
 * `ArAgingTile` / `NeedsYouNow` / `CustomerActivity` / `Funnel` tiles. Nothing
 * imported any of them for months. Two carried passing tests, which is most of
 * why it stayed invisible: the suite asserted the behaviour of components
 * nothing rendered, so the files looked maintained.
 *
 * The cost was not bundle size — an unimported module is never bundled. It was
 * that the dead `useDashboardData` reads as live when you audit request
 * economy, and `useEmployees`' own docstring cited it as a roster caller it had
 * de-duplicated. A reader had no way to tell the difference without tracing the
 * import graph by hand.
 *
 * ## What this checks, and how
 *
 * It resolves import specifiers rather than grepping for names: every non-test
 * source file under `src/` is read, its `import`/`export … from` specifiers are
 * resolved against its own directory, and a dashboard file counts as reachable
 * if any of them lands on it. So `from '../components/dashboard/utils'` and
 * `from './utils'` both count, and a mention inside a comment does not — which
 * matters, because three of the six orphans were mentioned in comments and
 * nowhere else.
 *
 * Tests do not count as importers, deliberately. A tested orphan is the exact
 * case that got through.
 *
 * ## The false positive it can produce
 *
 * Adding a tile and committing it before wiring it into a page fails this. That
 * is the intended catch rather than a flaw — it is the same state the six were
 * left in — and the fix is to land the tile and its page together, or to delete
 * it. Scope is one small closed directory, so this cannot block work elsewhere
 * in the tree.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DASH = join(HERE, '..')                     // …/components/dashboard
const SRC = join(DASH, '..', '..')                // …/src
const rel = (f) => relative(SRC, f).split('\\').join('/')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(full)
  }
  return out
}

/** Specifiers in `import … from 'x'`, `export … from 'x'` and `import('x')`. */
function specifiers(src) {
  const out = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1])
  return out
}

/** The file a relative specifier points at, ignoring the extension. */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  return resolve(dirname(fromFile), spec).replace(/\.(jsx?|tsx?)$/, '')
}

describe('components/dashboard has no orphans', () => {
  const tiles = readdirSync(DASH)
    .filter(f => /\.jsx?$/.test(f))
    .map(f => join(DASH, f))

  const importers = new Map(tiles.map(t => [t.replace(/\.jsx?$/, ''), []]))
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const spec of specifiers(src)) {
      const target = resolveLocal(file, spec)
      if (target && importers.has(target) && target !== file.replace(/\.jsx?$/, '')) {
        importers.get(target).push(rel(file))
      }
    }
  }

  it('every file is imported by production code', () => {
    const orphans = [...importers.entries()]
      .filter(([, from]) => from.length === 0)
      .map(([t]) => rel(t))
    expect(orphans,
      'nothing outside __tests__ imports these, so no page can render them. '
      + 'Wire each into a page in the same change, or delete it:\n  '
      + orphans.join('\n  ')).toEqual([])
  })

  it('is resolving real imports, not scanning nothing', () => {
    // The failure mode that let the orphans sit for months: a check that
    // inspects nothing and reports clean.
    //
    // `primitives` is the one to pin it on, because it is imported from both
    // sides — as '../components/dashboard/primitives' by two pages and as
    // './primitives' by three tiles in this directory — so this also proves
    // relative resolution works in both directions.
    //
    // Counting importers by grep instead gave 29 for it and 10 for `utils`.
    // Both were wrong: `from './utils'` matches every directory's own local
    // `utils`, and the pattern had no way to tell those apart. Resolving the
    // specifier against the importing file's directory is the whole reason
    // this test does it that way, and the inflated numbers are why the figures
    // below are deliberately loose.
    expect(tiles.length).toBeGreaterThanOrEqual(4)
    const prim = [...importers.entries()].find(([t]) => t.endsWith('/primitives'))
    expect(prim, 'components/dashboard/primitives.jsx is gone — update this test').toBeTruthy()
    expect(prim[1].length).toBeGreaterThan(2)
    expect(prim[1].some(f => f.startsWith('pages/'))).toBe(true)
    expect(prim[1].some(f => f.startsWith('components/dashboard/'))).toBe(true)
  })
})
