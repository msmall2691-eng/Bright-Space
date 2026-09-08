/**
 * Price before post. The bulk "Open to crew" action used to fire immediately
 * with no rate, so jobs landed on the bench's phones reading "No price set".
 * It now opens this modal, which ASKS for the rate first. These pin that the
 * ask happens and that what the office types reaches the caller.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { OpenToCrewModal } from '../PowerToolModals'

afterEach(cleanup)

const two = [{ job_id: 1 }, { job_id: 2 }]

it('asks for a rate and passes the number entered', () => {
  const onConfirm = vi.fn()
  render(<OpenToCrewModal state={{ targets: two }} onCancel={() => {}} onConfirm={onConfirm} />)
  // The rate box is the whole point — the bulk path used to skip it entirely.
  fireEvent.change(screen.getByPlaceholderText('e.g. 120'), { target: { value: '120' } })
  fireEvent.click(screen.getByRole('button', { name: /on the board/i }))
  expect(onConfirm).toHaveBeenCalledWith(120)
})

it('a blank rate posts unpriced (null), for a sub to name their own', () => {
  const onConfirm = vi.fn()
  render(<OpenToCrewModal state={{ targets: [{ job_id: 9 }] }} onCancel={() => {}} onConfirm={onConfirm} />)
  fireEvent.click(screen.getByRole('button', { name: /on the board/i }))
  expect(onConfirm).toHaveBeenCalledWith(null)
})

it('renders nothing when there is no batch to post', () => {
  const { container } = render(
    <OpenToCrewModal state={null} onCancel={() => {}} onConfirm={() => {}} />)
  expect(container.firstChild).toBeNull()
})
