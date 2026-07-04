import { useEffect, useState } from 'react'
import { EMPTY } from '../components/clients/constants'

/** Owns the slide-over form's local state on the Clients page:
 *    - `showForm`    — slide-over visibility
 *    - `form`        — controlled input snapshot (mirrors the row on
 *                      edit; starts from EMPTY on create)
 *    - `showBilling` — reveal the separate billing-address block
 *    - `dupes`       — possible-duplicate matches surfaced on save
 *
 *  Also handles duplicate-warning invalidation: whenever a
 *  match-relevant field (name/phone/email) changes, dupes is cleared
 *  so the next save re-runs the check with the new values instead of
 *  "Create anyway" slipping through stale.
 *
 *  `selected` is owned by the page (also read by useClientPhones and
 *  useClientMutations) and passed in via `setSelected` so openNew /
 *  openEdit stay in this hook. `loadPhones` / `resetPhones` let the
 *  form hook coordinate the per-client phones panel without knowing
 *  anything about phones internally. */
export function useClientForm({ setSelected, loadPhones, resetPhones }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [showBilling, setShowBilling] = useState(false)
  const [dupes, setDupes] = useState([])

  useEffect(() => { setDupes([]) }, [form.first_name, form.last_name, form.phone, form.email])

  const openNew = () => {
    setForm(EMPTY); setSelected(null); resetPhones(); setDupes([])
    setShowBilling(false); setShowForm(true)
  }

  const openEdit = (c) => {
    setForm({ ...c })
    setSelected(c)
    setDupes([])
    setShowBilling(Boolean(c.billing_address || c.billing_city || c.billing_state || c.billing_zip))
    loadPhones(c.id)
    setShowForm(true)
  }

  return {
    showForm, setShowForm,
    form, setForm,
    showBilling, setShowBilling,
    dupes, setDupes,
    openNew, openEdit,
  }
}
