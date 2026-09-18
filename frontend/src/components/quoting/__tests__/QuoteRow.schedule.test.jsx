/**
 * "Set up schedule" vs "Scheduled" on a quote row.
 *
 * Accepting a quote auto-converts it to a job with NO date — the owner picks
 * the day afterwards. The row keyed the two states off status alone, so every
 * auto-converted quote read as a green "Scheduled" while its job sat dateless
 * and invisible. The decision now uses `job_scheduled_date`, which the list
 * payload batch-loads: no date → still needs scheduling; a date → Scheduled.
 */
import { it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import QuoteRow from '../QuoteRow'

afterEach(cleanup)

const base = {
  id: 7, client_id: 1, quote_number: 'QT-7', total: 150, items: [],
  created_at: '2026-09-01T10:00:00Z',
}

const show = (q, onSchedule = vi.fn()) => {
  render(
    <QuoteRow q={{ ...base, ...q }} canEdit clientName={() => 'Megan'}
      selectedIds={new Set()} onToggleSelect={() => {}} onOpenQuote={() => {}}
      onNavigate={() => {}} onSend={() => {}} onCopyLink={() => {}}
      onSchedule={onSchedule} onArchive={() => {}} onUpdateStatus={() => {}} />
  )
  return onSchedule
}

it('an accepted quote offers Set up schedule', () => {
  show({ status: 'accepted' })
  expect(screen.getByText('Set up schedule')).toBeTruthy()
  expect(screen.queryByText('Scheduled')).toBeNull()
})

it('a converted quote whose job has NO date still offers Set up schedule', () => {
  const onSchedule = show({ status: 'converted', job_id: 42, job_scheduled_date: null })
  expect(screen.queryByText('Scheduled')).toBeNull()
  fireEvent.click(screen.getByText('Set up schedule'))
  expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 7, job_id: 42 }))
})

it('a converted quote whose job HAS a date reads Scheduled', () => {
  show({ status: 'converted', job_id: 42, job_scheduled_date: '2026-10-02' })
  expect(screen.getByText('Scheduled')).toBeTruthy()
  expect(screen.queryByText('Set up schedule')).toBeNull()
})

it('a sent quote offers neither', () => {
  show({ status: 'sent' })
  expect(screen.queryByText('Scheduled')).toBeNull()
  expect(screen.queryByText('Set up schedule')).toBeNull()
})
