import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText } from 'lucide-react'
import { EmptyState } from '../components/ui'
import { useInvoicing } from '../hooks/useInvoicing'
import { useInvoicingMutations } from '../hooks/useInvoicingMutations'
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
  const [toasts, setToasts]       = useState([])

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
  }, [])

  const {
    saving, sending, drafting, deleting,
    chaser, setChaser,
    save, markPaid, markOverdue, deleteInvoice, sendInvoice, draftReminder,
    openChaser, updateChaserMsg, sendChaserItem,
  } = useInvoicingMutations({
    load,
    selected, setPanel,
    form, sendForm, setSendForm,
    toast,
  })

  const updateItem = (i, key, val) => setForm(f => {
    const items = [...f.items]; items[i] = { ...items[i], [key]: val }; return { ...f, items }
  })

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
