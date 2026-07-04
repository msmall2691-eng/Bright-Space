import { useState } from 'react'
import { del, get, patch, post } from '../api'

/** Per-client phone numbers CRUD for the edit-client form.
 *
 *  Owns the phone list state, the "add phone" inputs (number + type),
 *  and the loading flag. Every mutation refetches the list on success
 *  so the UI stays in sync; setting a phone primary also asks the
 *  parent to refresh the clients list (via the injected `refreshList`)
 *  because the primary phone shows on the row.
 *
 *  Consumers pass in the currently-`selected` client (the phone
 *  endpoints are scoped under `/api/clients/:id/phones`) and a
 *  `refreshList` callback for the primary-changed side-effect.
 *  `resetPhones` clears local state when switching records. */
export function useClientPhones({ selected, refreshList }) {
  const [phoneNumbers, setPhoneNumbers] = useState([])
  const [newPhoneNumber, setNewPhoneNumber] = useState('')
  const [newPhoneType, setNewPhoneType] = useState('mobile')
  const [loadingPhones, setLoadingPhones] = useState(false)

  const loadPhones = async (clientId) => {
    setLoadingPhones(true)
    try {
      const phones = await get(`/api/clients/${clientId}/phones`)
      setPhoneNumbers(Array.isArray(phones) ? phones : [])
    } catch (e) {
      console.error('Error loading phones:', e)
      setPhoneNumbers([])
    }
    setLoadingPhones(false)
  }

  const addPhoneNumber = async () => {
    if (!newPhoneNumber.trim() || !selected) return
    try {
      await post(`/api/clients/${selected.id}/phones`, {
        phone: newPhoneNumber,
        phone_type: newPhoneType,
        is_primary: phoneNumbers.length === 0,
      })
      setNewPhoneNumber('')
      setNewPhoneType('mobile')
      await loadPhones(selected.id)
    } catch (e) {
      console.error('Error adding phone:', e)
    }
  }

  const deletePhoneNumber = async (phoneId) => {
    if (!selected) return
    try {
      await del(`/api/clients/${selected.id}/phones/${phoneId}`)
      await loadPhones(selected.id)
    } catch (e) {
      console.error('Error deleting phone:', e)
    }
  }

  const setPhonePrimary = async (phoneId) => {
    if (!selected) return
    try {
      await patch(`/api/clients/${selected.id}/phones/${phoneId}`, { is_primary: true })
      await loadPhones(selected.id)
      await refreshList?.()
    } catch (e) {
      console.error('Error setting primary phone:', e)
    }
  }

  const resetPhones = () => setPhoneNumbers([])

  return {
    phoneNumbers,
    newPhoneNumber, setNewPhoneNumber,
    newPhoneType, setNewPhoneType,
    loadingPhones,
    loadPhones,
    addPhoneNumber,
    deletePhoneNumber,
    setPhonePrimary,
    resetPhones,
  }
}
