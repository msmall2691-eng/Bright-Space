import { useCallback, useState } from 'react'
import { post } from '../api'
import { EMPTY } from '../components/properties/constants'

/** Form-state cluster for the Add / Edit Property modal in Properties.jsx.
 *
 *  Owns:
 *   • Modal visibility: showForm, showTypeModal, plus the initial-type
 *     picker's newPropertyType.
 *   • Selected property + the working form state.
 *   • Inline "+ New client" quick-add state (addingClient, newClient,
 *     creatingClient, clientErr).
 *
 *  Handlers:
 *   • selectClient(idStr) — pre-fill the property's address from the
 *     client's own address when those fields are still empty (smart
 *     default; never clobbers anything already typed).
 *   • createInlineClient() — POST /api/clients, prepend to the parent's
 *     `clients` via setClients, auto-select the new client.
 *   • openEdit(p) — populate form from an existing property.
 *   • openNew() — open the type-picker modal for a fresh property.
 *   • confirmNewProperty() — user picked a type; open the form empty.
 *   • resetAfterSave() — called by the parent's save wrapper when the
 *     mutation succeeds. */
export function usePropertyForm({ clients, setClients }) {
  const [showForm, setShowForm] = useState(false)
  const [showTypeModal, setShowTypeModal] = useState(false)
  const [newPropertyType, setNewPropertyType] = useState('residential')
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [addingClient, setAddingClient] = useState(false)
  const [newClient, setNewClient] = useState({ name: '', phone: '', email: '' })
  const [creatingClient, setCreatingClient] = useState(false)
  const [clientErr, setClientErr] = useState('')

  const selectClient = useCallback((idStr) => {
    const c = clients.find(c => String(c.id) === String(idStr))
    setForm(f => {
      const next = { ...f, client_id: idStr }
      if (c) {
        if (!f.address && c.address) next.address = c.address
        if (!f.city && c.city) next.city = c.city
        if (!f.state && c.state) next.state = c.state
        if (!f.zip_code && c.zip_code) next.zip_code = c.zip_code
      }
      return next
    })
  }, [clients])

  const createInlineClient = useCallback(async () => {
    if (!newClient.name.trim()) { setClientErr('Name is required'); return }
    setCreatingClient(true); setClientErr('')
    try {
      const created = await post('/api/clients', {
        name: newClient.name.trim(),
        phone: newClient.phone.trim() || null,
        email: newClient.email.trim() || null,
        status: 'active',
      })
      setClients(cs => [created, ...cs])
      selectClient(String(created.id))
      setAddingClient(false)
      setNewClient({ name: '', phone: '', email: '' })
    } catch (e) {
      setClientErr(e.message || 'Failed to create client')
    }
    setCreatingClient(false)
  }, [newClient, setClients, selectClient])

  const openEdit = useCallback((p) => {
    setSelected(p)
    setForm({
      ...p,
      client_id: p.client_id,
      property_type: p.property_type || 'residential',
      check_in_time: p.check_in_time || '14:00',
      check_out_time: p.check_out_time || '10:00',
      house_code: p.house_code || '',
    })
    setAddingClient(false); setNewClient({ name: '', phone: '', email: '' }); setClientErr('')
    setShowForm(true)
  }, [])

  const openNew = useCallback(() => setShowTypeModal(true), [])

  const confirmNewProperty = useCallback(() => {
    setSelected(null)
    setForm({ ...EMPTY, property_type: newPropertyType })
    setAddingClient(false); setNewClient({ name: '', phone: '', email: '' }); setClientErr('')
    setShowTypeModal(false)
    setShowForm(true)
  }, [newPropertyType])

  const resetAfterSave = useCallback(() => {
    setShowForm(false)
    setShowTypeModal(false)
    setSelected(null)
    setForm(EMPTY)
  }, [])

  return {
    showForm, setShowForm,
    showTypeModal, setShowTypeModal,
    newPropertyType, setNewPropertyType,
    selected,
    form, setForm,
    addingClient, setAddingClient,
    newClient, setNewClient,
    creatingClient,
    clientErr, setClientErr,
    selectClient,
    createInlineClient,
    openEdit,
    openNew,
    confirmNewProperty,
    resetAfterSave,
  }
}
