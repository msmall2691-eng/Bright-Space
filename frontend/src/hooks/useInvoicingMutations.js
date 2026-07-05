import { useState } from 'react'
import { del, get, patch, post } from '../api'

/** Owns every server-hitting mutation on the Invoicing list page:
 *  save / delete a single invoice, mark paid / overdue, send an
 *  invoice through email or SMS, ask AI to draft one reminder, and
 *  the "chase overdue" batch flow (openChaser fetches the AI drafts
 *  for every overdue invoice; sendChaserItem sends one; updateChaserMsg
 *  edits a draft locally).
 *
 *  Also owns the in-flight flags each mutation surfaces (`saving`,
 *  `sending`, `drafting`, `deleting`) plus the chaser modal state
 *  (`chaser` / `setChaser`). Page passes in the form + selection +
 *  toast + refetch callbacks it already owns so we don't fork the
 *  source of truth. */
export function useInvoicingMutations({
  load,
  selected, setPanel,
  form, sendForm, setSendForm,
  toast,
}) {
  const [saving, setSaving]     = useState(false)
  const [sending, setSending]   = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [chaser, setChaser]     = useState(null)

  const save = async () => {
    setSaving(true)
    try {
      const url  = selected ? `/api/invoices/${selected.id}` : '/api/invoices'
      const body = { ...form, client_id: parseInt(form.client_id), tax_rate: parseFloat(form.tax_rate) || 0 }
      selected ? await patch(url, body) : await post(url, body)
      await load(); toast(selected ? 'Invoice updated' : 'Invoice created'); setPanel(null)
    } catch (e) { toast(e.message || 'Failed to save invoice', 'error') }
    setSaving(false)
  }

  const markPaid = async (id) => {
    await patch(`/api/invoices/${id}`, { paid_at: new Date().toISOString() })
    await load(); toast('Marked as paid')
    if (selected?.id === id) setPanel(null)
  }

  const markOverdue = async (id) => {
    await patch(`/api/invoices/${id}`, { status: 'overdue' })
    await load(); toast('Marked as overdue')
  }

  const deleteInvoice = async () => {
    if (!selected) return
    setDeleting(true)
    try {
      await del(`/api/invoices/${selected.id}`)
      await load(); setPanel(null); toast('Invoice deleted')
    } catch { toast('Failed to delete invoice', 'error') }
    setDeleting(false)
  }

  const sendInvoice = async () => {
    if (!selected) return
    setSending(true)
    try {
      const data = await post(`/api/invoices/${selected.id}/send`, sendForm)
      await load()
      const parts = Object.entries(data.results || {}).map(([ch, res]) => `${ch}: ${res}`).join(', ')
      toast(`Invoice sent — ${parts}`); setPanel(null)
    } catch (e) { toast(e.message || 'Failed to send invoice', 'error') }
    setSending(false)
  }

  const draftReminder = async () => {
    if (!selected || drafting) return
    setDrafting(true)
    try {
      const res = await post(`/api/ai/draft-invoice-reminder/${selected.id}`, {})
      if (res?.message) {
        setSendForm(f => ({ ...f, custom_message: res.message }))
        toast('Draft ready — review before sending')
      } else {
        toast(res?.error || 'Could not draft a reminder', 'error')
      }
    } catch (e) { toast(e.message || 'Could not draft a reminder', 'error') }
    setDrafting(false)
  }

  // Batch chaser: load AI drafts for every overdue invoice, for review.
  const openChaser = async () => {
    setChaser({ loading: true, items: [], truncated: false })
    try {
      const res = await get('/api/ai/overdue-reminders')
      setChaser({
        loading: false,
        truncated: !!res?.truncated,
        items: (res?.reminders || []).map(r => ({ ...r, sending: false, sent: false })),
      })
    } catch (e) {
      setChaser(null)
      toast(e.message || 'Could not load overdue reminders', 'error')
    }
  }

  const updateChaserMsg = (id, message) => setChaser(c => c && ({
    ...c, items: c.items.map(it => it.invoice_id === id ? { ...it, message } : it),
  }))

  const sendChaserItem = async (item) => {
    if (item.sending || item.sent) return
    setChaser(c => c && ({ ...c, items: c.items.map(it => it.invoice_id === item.invoice_id ? { ...it, sending: true } : it) }))
    try {
      await post(`/api/invoices/${item.invoice_id}/send`, {
        channel: item.client_email ? 'email' : 'sms',
        email: item.client_email || '',
        phone: item.client_phone || '',
        custom_message: item.message,
      })
      setChaser(c => c && ({ ...c, items: c.items.map(it => it.invoice_id === item.invoice_id ? { ...it, sending: false, sent: true } : it) }))
      toast(`Reminder sent — ${item.invoice_number}`)
    } catch (e) {
      setChaser(c => c && ({ ...c, items: c.items.map(it => it.invoice_id === item.invoice_id ? { ...it, sending: false } : it) }))
      toast(e.message || `Failed to send ${item.invoice_number}`, 'error')
    }
  }

  return {
    saving, sending, drafting, deleting,
    chaser, setChaser,
    save, markPaid, markOverdue, deleteInvoice, sendInvoice, draftReminder,
    openChaser, updateChaserMsg, sendChaserItem,
  }
}
