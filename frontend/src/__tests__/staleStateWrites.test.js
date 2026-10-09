/**
 * A `setX` that writes back state it captured at render, after an `await`.
 *
 * This class has now shipped five times, and the symptom is always the same
 * shape: work the user can see being undone, with nothing on screen saying so.
 * The one that got caught by hand was bulk archive on Requests (#1111) —
 *
 *     const archived = new Set(...)            // after a confirm + N PATCHes
 *     setRequests(requests.filter(r => !archived.has(r.id)))
 *
 * `requests` was read when the component rendered. Between then and this line
 * sit a confirm dialog the operator answers at their own pace and a batch of
 * requests, so anything the per-row actions removed in the meantime is still
 * in that array — and writing it back puts those rows on screen again. A lead
 * already archived on the server reappears, looking real.
 *
 * Sweeping for the same shape found four more, all on the schedule surface and
 * two of them behind a confirm dialog, which is the longest gap of all. They
 * are fixed in the same commit as this file.
 *
 * ## What it flags
 *
 * A call `setFoo(expr)` where `expr` is not a function, mentions `foo` as a
 * VALUE (not as a property name or an object key), and sits in a function that
 * awaits somewhere. That is the whole rule, and each clause is carrying weight:
 *
 *  - **not a function** — `setFoo(prev => …)` is the fix, so it must pass.
 *  - **mentions `foo` as a value** — this one took two tries to get right.
 *    Counting the identifier anywhere flagged `setResults(data.results)` and
 *    `setAnswer({ answer: '…' })`, where the match is a property name and the
 *    state is being REPLACED wholesale by a server response, which is correct
 *    code. Eleven of seventeen hits were that. Property-access names, object
 *    keys, shorthand properties, binding names and JSX attribute names are all
 *    excluded now.
 *  - **the function awaits** — without a gap there is nothing to go stale. A
 *    synchronous `setShow(!show)` in a click handler is fine and must not flag.
 *
 * ## How it was calibrated, which matters more than the rule
 *
 * The first version of this returned ZERO on a tree with four known instances
 * in it, because `'setVisits'[2]` is `'t'` and not `'V'` — it had been
 * comparing against `tVisits`. A guard that silently finds nothing looks
 * exactly like a clean codebase. It was caught only because the expected
 * answer was known first: the four were found by reading the code, and
 * anything other than four meant the guard was wrong, not the tree clean.
 *
 * So the assertion below is not "no offenders". It is "no offenders AND this
 * actually inspected a realistic number of setter calls", because the failure
 * mode worth defending against here is the guard quietly inspecting nothing.
 */
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
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
 * Is this Identifier a real value reference, or just a name in a property
 * position? `d.url`, `{ answer: x }` and `<a href=…>` all contain identifiers
 * that are not reads of a variable.
 */
function isValueRef(id) {
  const p = id.parent
  if (!p) return true
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isQualifiedName(p) && p.right === id) return false
  if (ts.isPropertyAssignment(p) && p.name === id) return false
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return false
  if (ts.isBindingElement(p) && p.propertyName === id) return false
  if (ts.isJsxAttribute(p) && p.name === id) return false
  return true
}

const isFunctionish = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
  || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)

const isLoop = (n) =>
  ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)
  || ts.isWhileStatement(n) || ts.isDoStatement(n)

/**
 * The `await`s that belong to this function's OWN scope.
 *
 * It stops at every nested function form, not just arrows and function
 * expressions: an `async function` DECLARATION or an object method defined
 * inside the body is its own scope, and its suspension is not ours. Skipping
 * only two of the four forms flagged
 * `function f() { async function nested() { await save() } setItems([...items, x]) }`,
 * where the outer function never suspends at all.
 */
function ownAwaits(fn) {
  const out = []
  const look = (x) => {
    if (ts.isAwaitExpression(x)) out.push(x)
    if (x !== fn && isFunctionish(x)) return
    ts.forEachChild(x, look)
  }
  if (fn && fn.body) look(fn.body)
  return out
}

/**
 * EVERY loop around `node` that is still inside `fn`, innermost first.
 *
 * All of them, not just the nearest, because the suspension can belong to an
 * outer one:
 *
 *     for (const a of as) { for (const x of xs) { setItems(items.concat(x)) } await save() }
 *
 * The call is in the inner loop and the await is in the outer body, after it.
 * Checking only the innermost loop found no await inside it and reported this
 * clean, while it is stale from the second outer iteration on — found in
 * review.
 */
function enclosingLoops(node, fn) {
  const out = []
  let p = node.parent
  while (p && p !== fn) {
    if (isLoop(p)) out.push(p)
    p = p.parent
  }
  return out
}

/** Offenders in one parsed file, plus how many setter calls were inspected. */
function staleWrites(source, label) {
  const offenders = []
  let settersSeen = 0
  const fnStack = []

  const visit = (node) => {
    if (isFunctionish(node)) fnStack.push(node)

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^set[A-Z]/.test(node.expression.text) && node.arguments.length === 1) {
      settersSeen++
      const arg = node.arguments[0]
      const functional = ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
      const setter = node.expression.text
      const state = setter[3].toLowerCase() + setter.slice(4)   // setVisits -> visits

      let reads = false
      const scan = (x) => {
        if (ts.isIdentifier(x) && x.text === state && isValueRef(x)) reads = true
        ts.forEachChild(x, scan)
      }
      scan(arg)

      // Can the enclosing function have SUSPENDED BEFORE REACHING this call?
      // "Awaits anywhere in the body" is not the same question, and getting
      // them confused rejects correct code: an optimistic update followed by a
      // save —
      //
      //     setItems([...items, made]); await persist()
      //
      // reads `items` with nothing having suspended yet, so the value is
      // current and the write is right. So position matters.
      //
      // Position alone is not enough either, because of loops. In
      //
      //     for (const x of xs) { setItems(items.concat(x)); await save(x) }
      //
      // the await sits AFTER the call in the source and still precedes it on
      // every iteration but the first, which is the stale case. Hence the two
      // clauses: an await before the call, or an await sharing a loop with it.
      const fn = fnStack[fnStack.length - 1]
      let suspendsFirst = false
      if (fn) {
        const awaits = ownAwaits(fn)
        const start = node.getStart(source)
        if (awaits.some(a => a.end <= start)) {
          suspendsFirst = true
        } else {
          suspendsFirst = enclosingLoops(node, fn).some(loop => awaits.some(a =>
            a.getStart(source) >= loop.getStart(source) && a.end <= loop.end))
        }
      }

      if (!functional && reads && suspendsFirst) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        offenders.push(
          `${label}:${line + 1}  ${node.getText(source).replace(/\s+/g, ' ').slice(0, 90)}`)
      }
    }

    ts.forEachChild(node, visit)
    if (isFunctionish(node)) fnStack.pop()
  }
  visit(source)
  return { offenders, settersSeen }
}

const parse = (path, text) => ts.createSourceFile(
  path, text, ts.ScriptTarget.Latest, true,
  path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX)

describe('no setState writes back state captured before an await', () => {
  it('finds none across src/', () => {
    const offenders = []
    const unparsed = []
    let settersSeen = 0
    for (const path of walk(SRC)) {
      const source = parse(path, readFileSync(path, 'utf8'))
      if ((source.parseDiagnostics || []).length) {
        unparsed.push(`${rel(path)}  ${source.parseDiagnostics.length} parse error(s)`)
      }
      const found = staleWrites(source, rel(path))
      settersSeen += found.settersSeen
      offenders.push(...found.offenders)
    }

    expect(unparsed, 'these files did not parse, so nothing in them was checked:\n  '
      + unparsed.join('\n  ')).toEqual([])
    // The guard's own failure mode: inspecting nothing and reporting clean.
    expect(settersSeen, 'inspected almost no setter calls — the walk or the match broke')
      .toBeGreaterThan(300)

    expect(offenders,
      'These write back a render-time snapshot after an await, so anything that '
      + 'changed in the gap comes back on screen. Use the functional form, '
      + '`setX(prev => …)`:\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('tells a stale write from the correct code that resembles one', () => {
    // Every `good` line is real code from this tree (or its exact shape).
    const good = [
      // The fix itself.
      'const f = async () => { await g(); setVisits(prev => prev.filter(x => x.id !== id)) }',
      // Replacing state wholesale from a response: the match would be the
      // PROPERTY name, not a read of the state. Eleven of the first
      // seventeen hits were this, across seven files.
      'const f = async () => { const d = await g(); setResults(d.results || []) }',
      'const f = async () => { const r = await g(); setAnswer({ answer: r.a }) }',
      'const f = async () => { setWindows((await get("/x")).windows) }',
      // No await: nothing can go stale, so a captured read is fine.
      'const f = () => setShow(!show)',
      'const f = () => setOpenId(openId === a.id ? null : a.id)',
      // The await is inside a NESTED function, so it is not this call's gap.
      // All four nested forms, because skipping only arrows and function
      // expressions flagged the other two — found in review.
      'const f = () => { g().then(async () => { await h() }); setItems(items.concat(x)) }',
      'function f() { async function nested() { await save() } setItems([...items, made]) }',
      'function f() { const o = { async m() { await save() } }; setItems([...items, made]) }',
      // An optimistic update followed by a save. Nothing has suspended when
      // `items` is read, so the value is current — also found in review, and
      // the reason this asks "suspended BEFORE this call" rather than
      // "awaits anywhere".
      'async function f() { setItems([...items, made]); await persist() }',
      // Nested loops with no await anywhere: walking every enclosing loop must
      // not start flagging on the nesting alone.
      'function f() { for (const a of as) { for (const x of xs) { setItems(items.concat(x)) } } }',
    ]
    const bad = [
      // #1111, the one found by hand.
      'const f = async () => { await confirmDialog(); setRequests(requests.filter(r => !ids.has(r.id))) }',
      // The four this commit fixes.
      'const f = async () => { await patch(u); setVisits(visits.filter(x => x.id !== id)) }',
      'const f = async () => { await post(u); setVisits(visits.map(x => x)) }',
      'const f = async () => { await del(u); setEntries(entries.filter(e => e.id !== id)) }',
      'const f = async () => { const up = await patch(u); setEntries(entries.map(e => e.id === id ? up : e)) }',
      // Spread rather than a method call — same mistake, different spelling.
      'const f = async () => { await post(u); setItems([...items, made]) }',
      // The await is AFTER the call in the source and still precedes it on
      // every iteration but the first. Positional order alone would miss
      // this, which is why the loop clause exists.
      'async function f() { for (const x of xs) { setItems(items.concat(x)); await save(x) } }',
      'async function f() { while (n--) { setItems(items.concat(n)); await save() } }',
      // The suspension belongs to an OUTER loop: stale from the second outer
      // iteration, and missed while only the innermost loop was inspected.
      'async function f() { for (const a of as) { for (const x of xs) { setItems(items.concat(x)) } await save() } }',
    ]
    const flags = (src) => staleWrites(parse('probe.tsx', src), 'probe').offenders.length > 0
    for (const src of good) expect(flags(src), `false positive on: ${src}`).toBe(false)
    for (const src of bad) expect(flags(src), `missed a stale write in: ${src}`).toBe(true)
  })
})
