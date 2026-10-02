/**
 * Guardrail #4 — when a client already has a live recurring series on the same
 * property + cadence + time, the create flow should steer the office to EDIT
 * that series, not quietly stack a second one. This pins the prompt's shape:
 * "Edit this series" is the prominent action (a link to the existing series),
 * and creating a duplicate is the demoted, deliberate escape hatch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// JobCreateModal pulls these in at import time; stub them so importing the
// named export doesn't drag the whole app in.
vi.mock('../../api', () => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../utils/toastBus', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('../../hooks/useEmployees', () => ({ useEmployees: () => ({ employees: [] }) }))

import { DuplicateSeriesPrompt } from '../JobCreateModal'

const MATCH = {
  id: 42, cadence: 'Biweekly Tue 9:00', property_name: '4 Red Barn Circle',
  upcoming_job_count: 6,
}

afterEach(cleanup)

describe('DuplicateSeriesPrompt', () => {
  it('leads with "Edit this series" linking to the existing series', () => {
    render(<DuplicateSeriesPrompt matches={[MATCH]} saving={false} onCancel={() => {}} onOverride={() => {}} />)
    const edit = screen.getByTestId('job-create-duplicate-edit')
    expect(edit.getAttribute('href')).toBe('/recurring?series=42')
    expect(edit.textContent).toContain('Edit this series')
    // The match is described so the office knows which series they'd edit.
    const prompt = screen.getByTestId('job-create-duplicate-series-prompt')
    expect(prompt.textContent).toContain('Biweekly Tue 9:00')
    expect(prompt.textContent).toContain('4 Red Barn Circle')
  })

  it('demotes creating a duplicate to the quiet escape hatch, and wires both actions', () => {
    const onOverride = vi.fn()
    const onCancel = vi.fn()
    render(<DuplicateSeriesPrompt matches={[MATCH]} saving={false} onCancel={onCancel} onOverride={onOverride} />)
    fireEvent.click(screen.getByText(/create a separate series anyway/i))
    expect(onOverride).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText(/never mind/i))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('lists an edit link per match when several exist', () => {
    render(<DuplicateSeriesPrompt
      matches={[MATCH, { id: 7, cadence: 'Weekly Mon 10:00', upcoming_job_count: 0 }]}
      saving={false} onCancel={() => {}} onOverride={() => {}} />)
    const edits = screen.getAllByTestId('job-create-duplicate-edit')
    expect(edits.map(a => a.getAttribute('href'))).toEqual(['/recurring?series=42', '/recurring?series=7'])
  })

  it('renders nothing when there are no matches', () => {
    const { container } = render(<DuplicateSeriesPrompt matches={[]} saving={false} onCancel={() => {}} onOverride={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})
