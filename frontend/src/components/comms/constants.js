/**
 * Design tokens for the Comms unified inbox and its extracted sub-components.
 * Pure constants — no React imports, no closures. Lucide icons for
 * CHANNEL_CONFIG are imported at the top so consumers just read the config
 * map.
 */
import { Phone, Mail, MessageSquare, Voicemail } from 'lucide-react'
import { SEV_DOT } from '../board/tokens'

// Channel + priority indicators are dot+word, not filled/tinted chips (owner's
// veto of pill bubbles) — each config entry carries a solid dot color class
// plus a plain-text label; consumers render a small colored dot next to
// `text-ink-2`/`text-ink-3` text instead of a tinted background.
//
// `voice` was MISSING, and its absence was silent: `ConvItem` falls back to
// `CHANNEL_CONFIG.sms` for an unknown channel, so every voicemail rendered
// with the SMS phone icon and the SMS dot — identical to a text — even though
// the inbox offers a "Voicemail" tab that filters for it. The Twilio voice
// webhook has been writing `channel="voice"` since BB-VOICE-01.
//
// Amber for voice is semantic, not the leftover hue: the design language
// assigns amber to "needs attention", and an unheard voicemail is the one
// channel that always does.
//
// BB-A11Y-02. The dots were all on the 500 ramp, under the 3:1 non-text floor
// against this page's grounds (emerald-500 2.09, blue-500 2.98, amber-500
// 1.77, red-500 2.55). The hues are kept — channel identity is established and
// re-assigning it would relearn the inbox — but each moves to a step that
// clears. `SEV_DOT` is the measured map the board already holds.
export const CHANNEL_CONFIG = {
  sms:      { icon: Phone,          label: 'SMS',       dot: SEV_DOT.good },
  email:    { icon: Mail,           label: 'Email',     dot: SEV_DOT.info },
  voice:    { icon: Voicemail,      label: 'Voicemail', dot: SEV_DOT.watch },
  chat:     { icon: MessageSquare,  label: 'Chat',      dot: SEV_DOT.recurring },
  whatsapp: { icon: MessageSquare,  label: 'WhatsApp',  dot: 'bg-green-700 dark:bg-green-400' },
}

// Priority IS a severity, so these are the severity steps outright.
export const PRIORITY_COLORS = {
  low:    { dot: 'bg-ink-3' },
  normal: { dot: SEV_DOT.info },
  high:   { dot: SEV_DOT.watch },
  urgent: { dot: SEV_DOT.urgent },
}

export const TEAM_ASSIGNEES = ['Megan', 'Unassigned']
