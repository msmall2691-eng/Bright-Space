/**
 * Standing rules — "what does my app do without me?"
 *
 * The panel is a generic renderer over the backend catalogue, so what's pinned
 * here is that the generic part can't quietly lose a rule:
 *
 *   - Every field type the catalogue can send renders a real control. A rule
 *     whose control didn't draw would look like a rule that doesn't exist.
 *   - The wording comes from the server, never from a second copy here — two
 *     copies of "we text them 24 hours ahead" is how one of them ends up wrong.
 *   - Saving sends ONLY the field that changed, and the response replaces
 *     local state, so what's on screen is what's in force.
 *   - A number saves on blur, not per keystroke, or typing "48" would first
 *     save "4".
 *   - A rule the deployment switched off says so, with her setting still shown
 *     and still hers.
 *   - A rejected save shows the server's own reason (which names the bounds),
 *     and leaves the previous value on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('../../../api', () => ({ get: vi.fn(), post: vi.fn() }))

import { get, post } from '../../../api'
import RulesPanel from '../RulesPanel'

const CATALOGUE = {
  rules: [
    {
      key: 'customer_reminder',
      title: 'Text the customer before their cleaning',
      summary: 'One text per cleaning, with the time and a link to confirm.',
      blocked: false, blocked_reason: null,
      fields: [
        { key: 'job_sms_reminders_enabled', type: 'bool', label: 'Send the reminder',
          default: false, value: true },
        { key: 'job_sms_reminder_lead_hours', type: 'number', label: 'How far ahead',
          unit: 'hours', min: 1, max: 168, default: 24, value: 24,
          help: '24 is the night before.' },
      ],
    },
    {
      key: 'crew_escalation',
      title: 'Offer a job to the crew when nobody’s on it',
      summary: 'A scheduled job still has no cleaner as the date closes in.',
      blocked: false, blocked_reason: null,
      fields: [
        { key: 'crew_escalation_mode', type: 'choice', label: 'When a job is close with no cleaner',
          default: 'propose', value: 'propose',
          choices: [
            { value: 'off', label: 'Off' },
            { value: 'propose', label: 'Ask me first' },
            { value: 'auto', label: 'Just do it' },
          ] },
      ],
    },
  ],
}

const blocked = () => ({
  rules: [{
    ...CATALOGUE.rules[0],
    blocked: true,
    blocked_reason: 'Switched off at the deploy layer (JOB_SMS_REMINDERS_ENABLED=0). '
      + 'Your setting is kept and takes effect as soon as that’s lifted.',
  }],
})

const mount = (payload = CATALOGUE, toast = vi.fn()) => {
  get.mockResolvedValue(payload)
  return { toast, ...render(<RulesPanel active toast={toast} />) }
}

beforeEach(() => {
  get.mockReset(); post.mockReset()
  post.mockResolvedValue(CATALOGUE)
})
afterEach(cleanup)

// ── the generic renderer ────────────────────────────────────────────────────

it('draws a control for every field type the catalogue can send', async () => {
  mount()
  const reminder = await screen.findByTestId('rule-customer_reminder')
  expect(within(reminder).getByRole('checkbox')).toBeTruthy()
  expect(within(reminder).getByLabelText('How far ahead').value).toBe('24')

  const escalation = screen.getByTestId('rule-crew_escalation')
  for (const label of ['Off', 'Ask me first', 'Just do it']) {
    expect(within(escalation).getByRole('button', { name: label })).toBeTruthy()
  }
  expect(within(escalation).getByRole('button', { name: 'Ask me first' })
    .getAttribute('aria-pressed')).toBe('true')
})

it('takes its wording from the server, not from a copy in here', async () => {
  mount()
  expect(await screen.findByText('Text the customer before their cleaning')).toBeTruthy()
  expect(screen.getByText(/One text per cleaning/)).toBeTruthy()
  expect(screen.getByText('24 is the night before.')).toBeTruthy()
})

it('renders a rule the frontend has never heard of', async () => {
  // The whole reason for a generic renderer: a rule added to the backend
  // catalogue must appear with no frontend change at all.
  mount({ rules: [{
    key: 'brand_new', title: 'Something invented later',
    summary: 'Does a thing.', blocked: false, blocked_reason: null,
    fields: [{ key: 'brand_new_enabled', type: 'bool', label: 'Do it',
               default: false, value: false }],
  }] })
  expect(await screen.findByText('Something invented later')).toBeTruthy()
  expect(screen.getByRole('checkbox')).toBeTruthy()
})

// ── saving ──────────────────────────────────────────────────────────────────

it('sends only the field that changed', async () => {
  mount()
  const reminder = await screen.findByTestId('rule-customer_reminder')
  fireEvent.click(within(reminder).getByRole('checkbox'))
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/settings/rules', { settings: { job_sms_reminders_enabled: false } }))
})

it('saves a mode the moment it is picked', async () => {
  mount()
  const escalation = await screen.findByTestId('rule-crew_escalation')
  fireEvent.click(within(escalation).getByRole('button', { name: 'Just do it' }))
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/settings/rules', { settings: { crew_escalation_mode: 'auto' } }))
})

it('saves a number on blur, not on every keystroke', async () => {
  // Per-keystroke would save "4" on the way to "48" — and 4 hours' notice is a
  // real, different, wrong rule.
  mount()
  const field = within(await screen.findByTestId('rule-customer_reminder'))
    .getByLabelText('How far ahead')
  fireEvent.change(field, { target: { value: '4' } })
  fireEvent.change(field, { target: { value: '48' } })
  expect(post).not.toHaveBeenCalled()

  fireEvent.blur(field)
  await waitFor(() => expect(post).toHaveBeenCalledWith(
    '/api/settings/rules', { settings: { job_sms_reminder_lead_hours: 48 } }))
  expect(post).toHaveBeenCalledTimes(1)
})

it('does not save a number that did not actually change', async () => {
  mount()
  const field = within(await screen.findByTestId('rule-customer_reminder'))
    .getByLabelText('How far ahead')
  fireEvent.focus(field)
  fireEvent.blur(field)
  expect(post).not.toHaveBeenCalled()
})

it('shows what came back, not what it sent', async () => {
  // The server is the authority on what is in force — it can refuse, clamp a
  // neighbouring value, or reflect a change made elsewhere.
  mount()
  const field = within(await screen.findByTestId('rule-customer_reminder'))
    .getByLabelText('How far ahead')
  post.mockResolvedValue({
    rules: [{
      ...CATALOGUE.rules[0],
      fields: [CATALOGUE.rules[0].fields[0],
               { ...CATALOGUE.rules[0].fields[1], value: 12 }],
    }],
  })
  fireEvent.change(field, { target: { value: '48' } })
  fireEvent.blur(field)
  await waitFor(() => expect(
    screen.getByLabelText('How far ahead').value).toBe('12'))
})

it('passes the server’s own reason through when a save is refused', async () => {
  const toast = vi.fn()
  mount(CATALOGUE, toast)
  const err = new Error('job_sms_reminder_lead_hours must be between 1 and 168')
  post.mockRejectedValue(err)

  const field = within(await screen.findByTestId('rule-customer_reminder'))
    .getByLabelText('How far ahead')
  fireEvent.change(field, { target: { value: '99999' } })
  fireEvent.blur(field)

  await waitFor(() => expect(toast).toHaveBeenCalledWith(
    'job_sms_reminder_lead_hours must be between 1 and 168', 'error'))
  // And the value on screen is still the one actually in force.
  expect(screen.getByLabelText('How far ahead').value).toBe('24')
})

// ── the deployment kill switch ──────────────────────────────────────────────

it('says when the deployment has switched a rule off', async () => {
  mount(blocked())
  expect(await screen.findByText(/Switched off at the deploy layer/)).toBeTruthy()
  // Her setting is still shown and still hers — it takes effect when lifted.
  expect(screen.getByRole('checkbox').checked).toBe(true)
})

// ── failure ─────────────────────────────────────────────────────────────────

it('says nothing changed when the rules cannot be loaded', async () => {
  get.mockRejectedValue(new Error('offline'))
  render(<RulesPanel active toast={vi.fn()} />)
  expect(await screen.findByText(/Nothing has changed/)).toBeTruthy()
})

it('does not fetch until the panel is actually shown', () => {
  render(<RulesPanel active={false} toast={vi.fn()} />)
  expect(get).not.toHaveBeenCalled()
})
