/**
 * Per-cleaner accent — the "make it yours" colour. Pins the ramp shape, that a
 * pick applies to <html> and persists, that Default clears both, and that a
 * saved pick is re-applied on load.
 */
import { it, expect, beforeEach, afterEach } from 'vitest'
import { ACCENTS, rampVars, applyAccent, currentAccentId, initAccent } from '../accent'

const reset = () => {
  try { localStorage.clear() } catch { /* ignore */ }
  document.documentElement.removeAttribute('style')
}
beforeEach(reset)
afterEach(reset)

it('builds a full 11-stop ramp plus the solid fill and ink', () => {
  const vars = rampVars(ACCENTS.find(a => a.id === 'teal'))
  for (const stop of ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']) {
    expect(vars[`--accent-${stop}`]).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
  }
  expect(vars['--accent']).toMatch(/^rgb\(/)
  expect(['#ffffff', '#0b0b0d']).toContain(vars['--accent-ink'])
})

it('applies a chosen accent to <html> and remembers it', () => {
  applyAccent('violet')
  expect(currentAccentId()).toBe('violet')
  expect(document.documentElement.style.getPropertyValue('--accent-600')).toBeTruthy()
})

it('Default clears the override and the saved choice', () => {
  applyAccent('rose')
  applyAccent('default')
  expect(currentAccentId()).toBe('default')
  expect(document.documentElement.style.getPropertyValue('--accent-600')).toBe('')
})

it('re-applies the saved accent on load, and no-ops when none is saved', () => {
  initAccent()
  expect(document.documentElement.style.getPropertyValue('--accent-500')).toBe('')
  localStorage.setItem('bb_crew_accent', 'amber')
  initAccent()
  expect(document.documentElement.style.getPropertyValue('--accent-500')).toBeTruthy()
})
