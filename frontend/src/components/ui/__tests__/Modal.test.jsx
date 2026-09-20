/**
 * The shared Modal shell. What's pinned is the behaviour ~40 hand-rolled modals
 * were each missing: an ARIA dialog role, Esc-to-close, backdrop-to-close (both
 * gated by `dismissable`), body-scroll lock while open, and focus moving into
 * the panel. These are the correctness wins the shell exists to provide.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import Modal from '../Modal'

afterEach(cleanup)

const body = () => document.querySelector('[role="dialog"]')
const backdrop = (c) => c.querySelector('div[aria-hidden="true"]')

describe('Modal', () => {
  it('renders its content only when open, as an aria dialog', () => {
    const { rerender } = render(<Modal open={false} onClose={() => {}}>hi</Modal>)
    expect(body()).toBeNull()
    rerender(<Modal open onClose={() => {}} title="A title">hi</Modal>)
    const d = body()
    expect(d).not.toBeNull()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('aria-label')).toBe('A title')  // string title → label
    expect(screen.getByText('hi')).toBeTruthy()
  })

  it('closes on Esc and on backdrop click when dismissable', () => {
    const onClose = vi.fn()
    const { container } = render(<Modal open onClose={onClose}>x</Modal>)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(backdrop(container))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does NOT close on Esc or backdrop when dismissable is false', () => {
    const onClose = vi.fn()
    const { container } = render(<Modal open onClose={onClose} dismissable={false}>x</Modal>)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(backdrop(container))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking the panel content does not close', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose}><button>inside</button></Modal>)
    fireEvent.click(screen.getByText('inside'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the header close button closes', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="T">x</Modal>)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('locks body scroll while open and restores it on close', () => {
    const { unmount } = render(<Modal open onClose={() => {}}>x</Modal>)
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('moves focus into the panel on open', async () => {
    render(<Modal open onClose={() => {}}><button>focus me</button></Modal>)
    const btn = screen.getByText('focus me')
    await waitFor(() => expect(document.activeElement).toBe(btn))
  })
})
