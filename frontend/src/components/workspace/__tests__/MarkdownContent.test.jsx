import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MarkdownContent from '../MarkdownContent'

afterEach(cleanup)

describe('MarkdownContent', () => {
  it('renders bold text as an actual <strong>, not literal asterisks', () => {
    render(<MarkdownContent text="This is **important** business advice." />)
    const strong = screen.getByText('important')
    expect(strong.tagName).toBe('STRONG')
    expect(screen.queryByText(/\*\*/)).toBeNull()
  })

  it('renders a heading at a compact chat-bubble size, not the page h1 size', () => {
    render(<MarkdownContent text="## Remaining Action Items" />)
    const heading = screen.getByText('Remaining Action Items')
    // Should NOT be a raw <h2> inheriting index.css's page-level text-2xl rule —
    // MarkdownContent maps headings to sized divs instead.
    expect(heading.tagName).not.toBe('H2')
    expect(heading.className).toContain('text-[14px]')
  })

  it('renders a GFM table as real table markup, not a pipe-delimited string', () => {
    const text = '| Priority | Action |\n|---|---|\n| 1 | Push jobs to calendar |'
    render(<MarkdownContent text={text} />)
    expect(screen.getByRole('table')).toBeDefined()
    expect(screen.getByText('Push jobs to calendar').closest('td')).not.toBeNull()
  })

  it('renders a bullet list as real <li> items', () => {
    render(<MarkdownContent text={'- First item\n- Second item'} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})
