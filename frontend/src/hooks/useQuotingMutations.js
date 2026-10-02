import { useState } from 'react'
import { del, patch, post } from '../api'
import { confirmDialog } from '../utils/confirmBus'

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
  setQuotes, setIntakes,
  selectedIds, clearSelection,
  currentSelectedId, onSelectedCleared,
}) {
  const [nudging, setNudging] = useState(null)
  const [copiedQuoteId, setCopiedQuoteId] = useState(null)

  // Status changes are OPTIMISTIC: the chip flips across the list at once, the
  // write goes out, and a background reload reconciles; a failed write restores
  // the pre-action snapshot (taken inside the updater so it can't race a stale
  // closure). Same request count — the reload just no longer blocks the chip.
  const updateStatus = async (id, status) => {
    // accepted/declined carry real business side effects (job conversion,
    // opportunity won/lost, owner + customer notifications). A raw PATCH sets the
    // status with NONE of them, so route those two through the real endpoints and
    // confirm FIRST — nothing flips until the owner confirms. Everything else
    // (draft/sent/viewed) is a plain status edit.
    const heavy = status === 'accepted' || status === 'declined'
    if (heavy) {
      const ok = await confirmDialog(status === 'accepted'
        ? 'Mark this quote accepted? This converts it to a job (when a property is linked), marks the deal won, and emails the owner and customer.'
        : 'Mark this quote declined? This closes the deal as lost and notifies the owner.',
        { confirmLabel: status === 'accepted' ? 'Accept' : 'Decline' })
      if (!ok) return
    }
    let snapshot
    setQuotes(prev => { snapshot = prev; return prev.map(q => q.id === id ? { ...q, status } : q) })
    try {
      if (heavy) {
        await post(`/api/quotes/${id}/${status === 'accepted' ? 'accept' : 'decline'}`, {})
      } else {
        await patch(`/api/quotes/${id}`, { status })
      }
      loadQuotes(); loadFollowUps()
    } catch (e) {
      if (snapshot) setQuotes(snapshot)
      toast(e.message || `Could not mark quote ${status}`)
    }
  }

  const markIntakeReviewed = async (id) => {
    let snapshot
    setIntakes(prev => { snapshot = prev; return prev.map(i => i.id === id ? { ...i, status: 'reviewed' } : i) })
    try { await patch(`/api/intake/${id}`, { status: 'reviewed' }); loadIntakes() }
    catch (e) { if (snapshot) setIntakes(snapshot); toast(e.message || 'Could not update the lead') }
  }

  const updateLeadStatus = async (id, status) => {
    let snapshot
    setIntakes(prev => { snapshot = prev; return prev.map(i => i.id === id ? { ...i, status } : i) })
    try { await patch(`/api/intake/${id}`, { status }); loadIntakes() }
    catch (e) { if (snapshot) setIntakes(snapshot); toast(e.message || 'Could not update the lead') }
  }

  const archiveQuote = async (quote) => {
    if (!(await confirmDialog(`Archive quote ${quote.quote_number || quote.id}? It will be hidden from this list.`, { confirmLabel: 'Archive' }))) return
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
    if (!(await confirmDialog(`Archive ${ids.length} quote${ids.length === 1 ? '' : 's'}? They'll be hidden from this list.`, { confirmLabel: 'Archive' }))) return
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
    if (!(await confirmDialog(`Permanently delete ${ids.length} quote${ids.length === 1 ? '' : 's'}? This cannot be undone.`, { confirmLabel: 'Delete', danger: true }))) return
    let failed = 0
    for (const id of ids) { try { await del(`/api/quotes/${id}/permanent`) } catch { failed++ } }
    clearSelection(); await loadArchived()
    toast(failed
      ? `Deleted ${ids.length - failed} of ${ids.length} · ${failed} failed`
      : `Deleted ${ids.length} quote${ids.length === 1 ? '' : 's'}`)
  }

  const deletePermanent = async (q) => {
    if (!(await confirmDialog(`Permanently delete quote ${q.quote_number || q.id}? This cannot be undone.`, { confirmLabel: 'Delete', danger: true }))) return
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
