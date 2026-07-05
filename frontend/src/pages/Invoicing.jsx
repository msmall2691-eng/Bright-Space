import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText } from 'lucide-react'
import { EmptyState } from '../components/ui'
import { del, get, post, patch } from "../api"
import { useInvoicing } from '../hooks/useInvoicing'
import { EMPTY_ITEM } from '../components/invoicing/constants'
import { Toast } from '../components/invoicing/Toast'
import { InvoiceRow } from '../components/invoicing/InvoiceRow'
import { SendPanel } from '../components/invoicing/SendPanel'
import { ChaserModal } from '../components/invoicing/ChaserModal'
import { EditPanel } from '../components/invoicing/EditPanel'
import { InvoicingHeader } from '../components/invoicing/InvoicingHeader'

// ── Main component ────────────────────────────────────────────────────────────
export default function Invoicing() {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch]       = useState('')
  const {
    invoices, clients,
    clientName, clientOf,
    filtered,
    totalRevenue, outstanding, overdueCount,
    load,
  } = useInvoicing({ statusFilter, search })
  const [panel, setPanel]         = useState(null)   // null | 'edit' | 'send'
  const [selected, setSelected]   = useState(null)
  const [form, setForm]           = useState({ client_id: '', items: [{ ...EMPTY_ITEM }], tax_rate: 0, due_date: '', notes: '', custom_fields: {} })
  // Notes + custom fields fold behind this — the everyday invoice is client +
  // line items + total.
  const [showInvAdvanced, setShowInvAdvanced] = useState(false)
  const [sendForm, setSendForm]   = useState({ channel: 'email', email: '', phone: '', custom_message: '' })
  const [saving, setSaving]       = useState(false)
  const [sending, setSending]     = useState(false)
  const [drafting, setDrafting]   = useState(false)
  const [deleting, setDeleting]   = useState(false)
  const [toasts, setToasts]       = useState([])
  // Batch "chase overdue" review modal: null when closed, else
  // { loading, truncated, items:[{...draft, sending, sent}] }
  const [chaser, setChaser]       = useState(null)

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
  }, [])

  const updateItem = (i, key, val) => setForm(f => {
    const items = [...f.items]; items[i] = { ...items[i], [key]: val }; return { ...f, items }
  })

  const save = async () => {
    setSaving(true)
    try {
      const url    = selected ? `/api/invoices/${selected.id}` : '/api/invoices'
      const body   = { ...form, client_id: parseInt(form.client_id), tax_rate: parseFloat(form.tax_rate) || 0 }
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
    if (!selected) return; setDeleting(true)
    try {
      await del(`/api/invoices/${selected.id}`)
      await load(); setPanel(null); toast('Invoice deleted')
    } catch { toast('Failed to delete invoice', 'error') }
    setDeleting(false)
  }

  const sendInvoice = async () => {
    if (!selected) return; setSending(true)
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

  const openEdit = (inv) => {
    setSelected(inv)
    setForm({ client_id: inv.client_id, items: inv.items, tax_rate: inv.tax_rate, due_date: inv.due_date || '', notes: inv.notes || '', custom_fields: inv.custom_fields || {} })
    setShowInvAdvanced(Boolean(inv.notes) || Object.keys(inv.custom_fields || {}).length > 0)
    setPanel('edit')
  }

  const openSend = (inv) => {
    setSelected(inv)
    const c = clientOf(inv.client_id)
    setSendForm({ channel: 'email', email: c?.email || '', phone: c?.phone || '', custom_message: '' })
    setPanel('send')
  }

  const openNew = () => {
    setSelected(null)
    setForm({ client_id: '', items: [{ ...EMPTY_ITEM }], tax_rate: 0, due_date: '', notes: '', custom_fields: {} })
    setShowInvAdvanced(false)
    setPanel('edit')
  }

  const closePanel = () => { setPanel(null); setSelected(null) }

  return (
    <div className="flex h-full bg-bg">

      {/* ── Main column ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        <InvoicingHeader
          invoiceCount={invoices.length}
          totalRevenue={totalRevenue}
          outstanding={outstanding}
          overdueCount={overdueCount}
          search={search} setSearch={setSearch}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          openChaser={openChaser}
          openNew={openNew}
        />

        {/* Table */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 sm:px-8 pb-6">
          {/* Column headers */}
          <div className="hidden sm:grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-4 px-3 mb-2">
            {['Client', 'Amount', 'Due', 'Status', ''].map(h => (
              <div key={h} className="text-[10px] font-semibold uppercase tracking-widest text-ink-3">{h}</div>
            ))}
          </div>

          <div className="rounded-xl border border-hairline overflow-hidden bg-panel">
            {filtered.length === 0 ? (
              <EmptyState
                icon={FileText}
                title={search ? 'No matching invoices' : 'No invoices yet'}
                action={!search && (
                  <button onClick={openNew}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-700">
                    Create one →
                  </button>
                )}
              />
            ) : filtered.map((inv, idx) => (
              <InvoiceRow
                key={inv.id}
                inv={inv}
                isSelected={selected?.id === inv.id}
                isLast={idx === filtered.length - 1}
                clientName={clientName}
                openEdit={openEdit}
                openSend={openSend}
                markPaid={markPaid}
                markOverdue={markOverdue}
                navigate={navigate}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Side panel — Edit ───────────────────────────────────── */}
      {panel === 'edit' && (
        <EditPanel
          selected={selected}
          form={form} setForm={setForm}
          updateItem={updateItem}
          showInvAdvanced={showInvAdvanced} setShowInvAdvanced={setShowInvAdvanced}
          saving={saving} save={save}
          deleting={deleting} deleteInvoice={deleteInvoice}
          closePanel={closePanel}
          openSend={openSend}
          clients={clients}
          clientName={clientName}
        />
      )}

      {/* ── Side panel — Send ───────────────────────────────────── */}
      {panel === 'send' && selected && (
        <SendPanel
          selected={selected}
          sendForm={sendForm} setSendForm={setSendForm}
          drafting={drafting} draftReminder={draftReminder}
          sending={sending} sendInvoice={sendInvoice}
          closePanel={closePanel}
          clientName={clientName}
        />
      )}

      {/* ── Batch chaser — review AI-drafted reminders for all overdue ─── */}
      {chaser && (
        <ChaserModal
          chaser={chaser}
          setChaser={setChaser}
          sendChaserItem={sendChaserItem}
          updateChaserMsg={updateChaserMsg}
        />
      )}

      <Toast toasts={toasts} />

    </div>
  )
}
