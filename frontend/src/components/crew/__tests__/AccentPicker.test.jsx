/**
 * The crew accent picker: a swatch per preset, and clicking one selects it
 * (applies + persists via utils/accent).
 */
import { it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import AccentPicker from '../AccentPicker'
import { ACCENTS, currentAccentId } from '../../../utils/accent'

afterEach(() => {
  cleanup()
  try { localStorage.clear() } catch { /* ignore */ }
  document.documentElement.removeAttribute('style')
})

it('offers a swatch per preset and selects on click', () => {
  render(<AccentPicker />)
  for (const a of ACCENTS) {
    expect(screen.getByRole('button', { name: a.label })).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Teal' }))
  expect(currentAccentId()).toBe('teal')
  expect(screen.getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true')
})
