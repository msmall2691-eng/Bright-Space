import { useState } from 'react'
import { del, patch, post } from '../api'

/** Quoting mutation handlers grouped into one hook so the page component
 *  stays focused on state + render. Every action ends by refetching the
 *  relevant list(s) via the passed-in loaders — same shape as
 *  useScheduleTools.
 *
 *  Takes `{ toast, loadQuotes, loadIntakes, loadFollowUps, loadArchived,
 *  selectedIds, clearSelection, currentSelectedId, onSelectedCleared }`.
 *  Returns nine callbacks + `nudging` / `copiedQuoteId` UI state. */
export function useQuotingMutations({
  toast,
  loadQuotes, loadIntakes, loadFollowUps, loadArchived,
  selectedIds, clearSelection,
  currentSelectedId, onSelectedCleared,
}) {
  const [nudging, setNudging] = useState(null)
  const [copiedQuoteId, setCopiedQuoteId] = useState(null)

  const updateStatus = async (id, status) => {
    await patch(`/api/quotes/${id}`, { status })
    loadQuotes()
    loadFollowUps()
  }

  const markIntakeReviewed = async (id) => {
    await patch(`/api/intake/${id}`, { status: 'reviewed' })
    loadIntakes()
  }

  const updateLeadStatus = async (id, status) => {
    await patch(`/api/intake/${id}`, { status })
    loadIntakes()
  }

  const archiveQuote = async (quote) => {
    if (!window.confirm(`Archive quote ${quote.quote_number || quote.id}? It will be hidden from this list.`)) return
    try {
      await del(`/api/quotes/${quote.id}`)
      if (currentSelectedId === quote.id) onSelectedCleared?.()
      await loadQuotes()
      toast('Quote archived')
    } catch (e) { toast(e.message || 'Could not archive quote') }
  }

  const bulkArchive = async () => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!window.confirm(`Archive ${ids.length} quote${ids.length === 1 ? '' : 's'}? They'll be hidden from this list.`)) return
    let failed = 0
    for (const id of ids) { try { await del(`/api/quotes/${id}`) } catch { failed++ } }
    clearSelection(); await loadQuotes()
    toast(failed
      ? `Archived ${ids.length - failed} of ${ids.length} · ${failed} couldn't be archived (scheduled into a job?)`
      : `Archived ${ids.length} quote${ids.length === 1 ? '' : 's'}`)
  }

  const bulkDeletePermanent = async () => {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!window.confirm(`Permanently delete ${ids.length} quote${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return
    let failed = 0
    for (const id of ids) { try { await del(`/api/quotes/${id}/permanent`) } catch { failed++ } }
    clearSelection(); await loadArchived()
    toast(failed
      ? `Deleted ${ids.length - failed} of ${ids.length} · ${failed} failed`
      : `Deleted ${ids.length} quote${ids.length === 1 ? '' : 's'}`)
  }

  const deletePermanent = async (q) => {
    if (!window.confirm(`Permanently delete quote ${q.quote_number || q.id}? This cannot be undone.`)) return
    try { await del(`/api/quotes/${q.id}/permanent`); await loadArchived(); toast('Quote deleted permanently') }
    catch (e) { toast(e.message || 'Could not delete quote') }
  }

  // One-click follow-up nudge: re-send the quote by email to the address on
  // file. The backend records it as a follow-up (keeps the original sent/viewed
  // state intact) — nothing is auto-sent; this only fires when the owner clicks.
  const sendFollowUp = async (q) => {
    setNudging(q.id)
    try {
      await post(`/api/quotes/${q.id}/generate-token`, {})
      const data = await post(`/api/quotes/${q.id}/send`, { channel: 'email' })
      const channels = Object.entries(data.results || {}).filter(([, v]) => v === 'sent').map(([k]) => k)
      toast(`Follow-up sent via ${channels.join(' & ') || 'email'} ✓`)
      await Promise.all([loadQuotes(), loadFollowUps()])
    } catch (e) { toast(e.message || 'Could not send follow-up') }
    setNudging(null)
  }

  const copyPublicLink = async (quote) => {
    let q = quote
    if (!q.public_token) {
      try {
        const token = await post(`/api/quotes/${q.id}/generate-token`, {})
        q = { ...q, public_token: token.public_token }
      } catch {
        toast('Error generating link')
        return
      }
    }
    const appUrl = window.location.origin
    const link = `${appUrl}/quote/${q.public_token}`
    await navigator.clipboard.writeText(link)
    setCopiedQuoteId(q.id)
    toast('Link copied!')
    setTimeout(() => setCopiedQuoteId(null), 2000)
  }

  return {
    updateStatus,
    markIntakeReviewed,
    updateLeadStatus,
    archiveQuote,
    bulkArchive,
    bulkDeletePermanent,
    deletePermanent,
    sendFollowUp,
    copyPublicLink,
    nudging,
    copiedQuoteId,
  }
}
