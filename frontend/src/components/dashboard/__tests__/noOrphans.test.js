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
 * source file under `src/` is parsed, its `import`/`export … from` specifiers
 * are resolved against its own directory, and a dashboard file counts as
 * reachable if any of them lands on it. So `from '../components/dashboard/
 * utils'` and `from './utils'` both count, while a path named in a comment or
 * a commented-out import does not. That last part matters twice over: three of
 * the six orphans were named in comments and nowhere else, and the first
 * version of this test read the raw text, where a commented-out import of an
 * unwired file was enough to make it pass. See `specifiers` below.
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
import ts from 'typescript'
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

/**
 * Specifiers in `import … from 'x'`, `export … from 'x'` and `import('x')`,
 * read off the syntax tree.
 *
 * This was two regexes over the raw text, and that was a fail-open — found in
 * review, and reproduced before fixing. A COMMENTED-OUT import still matched:
 *
 *     // import { Dead } from '../components/dashboard/ZDead'
 *
 * so an unwired file plus a line of history about it counted as reachable and
 * the guard passed. Prose naming a path in backticks did the same. That is the
 * worst direction for a check like this: it reports clean on exactly the thing
 * it exists to catch, and nobody re-reads a green test.
 *
 * Parsing makes comments and string literals structurally invisible instead of
 * something a pattern has to anticipate.
 */
function specifiers(source) {
  const out = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteral(node.moduleReference.expression)) {
      out.push(node.moduleReference.expression.text)
    }
    // `import('x')` parses as a CallExpression whose callee is the keyword.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

const parse = (path, text) => ts.createSourceFile(
  path, text, ts.ScriptTarget.Latest, true,
  /\.tsx?$/.test(path) && !path.endsWith('.tsx') ? ts.ScriptKind.TS : ts.ScriptKind.TSX)

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
  const unparsed = []
  for (const file of walk(SRC)) {
    const source = parse(file, readFileSync(file, 'utf8'))
    // A file that fails to parse yields no specifiers, which would silently
    // un-import whatever it imports — the same fail-open the regex had, one
    // level up. So it is an error, not a skip.
    if ((source.parseDiagnostics || []).length) {
      unparsed.push(`${rel(file)}  ${source.parseDiagnostics.length} parse error(s)`)
    }
    for (const spec of specifiers(source)) {
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
    expect(unparsed, 'these files did not parse, so their imports were not seen:\n  '
      + unparsed.join('\n  ')).toEqual([])
    expect(tiles.length).toBeGreaterThanOrEqual(4)
    const prim = [...importers.entries()].find(([t]) => t.endsWith('/primitives'))
    expect(prim, 'components/dashboard/primitives.jsx is gone — update this test').toBeTruthy()
    expect(prim[1].length).toBeGreaterThan(2)
    expect(prim[1].some(f => f.startsWith('pages/'))).toBe(true)
    expect(prim[1].some(f => f.startsWith('components/dashboard/'))).toBe(true)
  })

  it('counts real imports and not text that looks like one', () => {
    // The scan above runs over the real tree, so a regression in `specifiers`
    // only shows up there if an orphan happens to exist at the same time.
    // These feed it directly, so the fail-open it had is pinned on its own.
    const specs = (src) => specifiers(parse('probe.jsx', src))

    expect(specs("import { Tile } from './Tile'")).toEqual(['./Tile'])
    expect(specs("export { Tile } from './Tile'")).toEqual(['./Tile'])
    expect(specs("const T = lazy(() => import('./Tile'))")).toEqual(['./Tile'])

    // The reviewed fail-open: both of these used to count as imports.
    expect(specs("// import { Tile } from './Tile'")).toEqual([])
    expect(specs("/** Was rendered via `import … from './Tile'` once. */")).toEqual([])
    // A path in ordinary prose or in a runtime string is not an import either.
    expect(specs("const doc = 'see from \"./Tile\" for the old layout'")).toEqual([])
  })
})
