/**
 * What the customer's "who's coming" block may and may not offer.
 *
 * The rendering assertions are secondary. The one that matters is the last
 * group: this block must give the customer NO WAY TO ACT on a person. A
 * customer who can pick their cleaner is a customer doing the assigning, and
 * a subcontractor requests or accepts — the office never assigns. Every
 * affordance this component could grow (a link, a button, a rating, a "book
 * them again") is that violation, so the test asserts the absence of all of
 * them rather than the presence of any one design.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import WhosComing from '../WhosComing'

const AMY = { name: 'Amy S.', has_photo: true, is_helper: false }
const SAM = { name: 'Sam R.', has_photo: false, is_helper: true }

describe('WhosComing', () => {
  it('renders nothing at all before anybody has won the job', () => {
    const { container } = render(<WhosComing crew={[]} photoBase="/p" />)
    expect(container.innerHTML).toBe('')
  })

  it('survives a payload that never arrived', () => {
    const { container } = render(<WhosComing crew={undefined} photoBase={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('names the crew and marks who is a helper', () => {
    render(<WhosComing crew={[AMY, SAM]} photoBase="/api/jobs/public/tok/crew" />)
    expect(screen.getByText('Amy S.')).toBeTruthy()
    expect(screen.getByText('Sam R.')).toBeTruthy()
    expect(screen.getByText('Helping out')).toBeTruthy()
  })

  it('addresses each face by its position in the list it was handed', () => {
    const { container } = render(
      <WhosComing crew={[AMY, SAM]} photoBase="/api/jobs/public/tok/crew" />)
    // Scoped to this render's container: these tests share a document.
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBe(1)                       // the helper has no photo
    expect(imgs[0].getAttribute('src')).toBe('/api/jobs/public/tok/crew/0/photo')
    expect(imgs[0].getAttribute('loading')).toBe('lazy')
  })

  it('falls back to an initial rather than a broken image', () => {
    const { container } = render(
      <WhosComing crew={[{ ...AMY, has_photo: true }]} photoBase={null} />)
    expect(container.querySelectorAll('img').length).toBe(0)
    expect(container.textContent).toContain('A')
  })

  it('labels the block by tense — "Who\'s coming" by default, overridable', () => {
    const up = render(<WhosComing crew={[AMY]} photoBase="/p" />)
    expect(up.container.textContent).toContain("Who's coming")
    const past = render(<WhosComing crew={[AMY]} photoBase="/p" label="Who cleaned" />)
    expect(past.container.textContent).toContain('Who cleaned')
    expect(past.container.textContent).not.toContain("Who's coming")
  })

  it('offers the customer no way to act on a person', () => {
    const { container } = render(
      <WhosComing crew={[AMY, SAM]} photoBase="/api/jobs/public/tok/crew" />)
    expect(container.querySelectorAll('a, button, input, select, [role="button"]').length)
      .toBe(0)
    // No rating, no repeat-booking, no "request" of any kind.
    expect(container.textContent).not.toMatch(/rate|review|star|request|prefer|again/i)
  })
})
