import { Mail, MessageSquare, Phone } from 'lucide-react'
import { displayContactName, formatPhone } from '../../utils/display'
import { toLocalYMD, todayYMD } from '../../utils/format'

/** ISO date (YYYY-MM-DD) for today. */
export const today = () => todayYMD()

/** ISO date (YYYY-MM-DD) for the first day of the current month. */
export const monthStart = () => {
  const d = new Date()
  return toLocalYMD(new Date(d.getFullYear(), d.getMonth(), 1))
}

/** Whole-dollar money formatter used by every KPI on the money tile:
 *  `$12,345`. Rounds to the nearest dollar (cents don't belong on a
 *  glanceable dashboard). */
export const fmtMoney = (n) => `$${Math.round(n || 0).toLocaleString()}`

/** Same fallback chain as `displayContactName` but prefers a friendlier
 *  "(617) 849-2813" over "Lead +16178492813" when the contact is just a
 *  phone number. */
export function contactLabel(conv) {
  const named = displayContactName(conv?.client || {})
  if (named && !named.toLowerCase().startsWith('lead ')) return named
  if (conv?.external_contact && /\+?\d/.test(conv.external_contact)) return formatPhone(conv.external_contact)
  return named || 'Unknown'
}

/** Lucide icon for a communication channel — Phone for sms, Mail for
 *  email, MessageSquare for chat and unknown channels. */
export const channelIcon = (ch) => ({ sms: Phone, email: Mail, chat: MessageSquare }[ch] || MessageSquare)
