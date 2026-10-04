import { useState } from 'react'
import { Link2, Copy, Check, Send, Share2, UserPlus } from 'lucide-react'
import { post } from '../api'
import { toast } from '../utils/toastBus'
import { reportInvite } from '../utils/inviteFallback'

/**
 * Add cleaners to the bench — the always-visible "how do I get someone on
 * board" card. It sits above the applications list on the Crew page so the
 * owner can grab the join link or invite a person WITHOUT waiting for somebody
 * to apply first (SubApplications renders nothing until an application exists,
 * so before this there was no persistent place to find the link).
 *
 * Two doors, both ending at the same onboarding:
 *  - Join link — the public /apply page. Copy or native-share it to anyone.
 *    Shown to every office role; sharing a public URL needs no privilege.
 *  - Invite directly — name + email → POST /api/auth/users/invite (role
 *    cleaner), which mints a crew login and emails the set-password link. This
 *    is the existing admin-only path (`invite_user`); gated to admin here too.
 *
 * Neither is clearance (brightbase-marketplace): an invited cleaner still has
 * to put insurance, a W-9 and the signed agreement on file before they can take
 * work. The copy says so, so "invited" is never mistaken for "vetted".
 */
function isAdmin() {
  try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
  catch { return false }
}

export default function InviteCleaners() {
  const admin = isAdmin()
  const joinUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/apply`
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const [copied, setCopied] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Couldn’t copy automatically — press and hold the link to copy it.')
    }
  }

  const share = async () => {
    try {
      await navigator.share({
        title: 'Clean with The Maine Cleaning Co.',
        text: 'Join our cleaning bench — pick up jobs on your own terms, paid per job:',
        url: joinUrl,
      })
    } catch { /* the viewer dismissed the share sheet, or it isn't available */ }
  }

  const sendInvite = async (e) => {
    e.preventDefault()
    const em = email.trim().toLowerCase()
    if (!/.+@.+\..+/.test(em)) { toast.error('Enter a valid email to send the invite.'); return }
    setSending(true)
    try {
      const row = await post('/api/auth/users/invite', { email: em, full_name: name.trim(), role: 'cleaner' })
      // reportInvite surfaces the copy-this-link fallback when the email itself
      // couldn't send — an account they can never reach is worse than silence.
      if (!(await reportInvite(row, em))) toast.success(`Invite sent to ${name.trim() || em}`)
      setName(''); setEmail('')
    } catch (err) {
      toast.error(err?.detail || err?.message || 'Could not send that invite.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-xl border border-hairline bg-panel p-5 sm:p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
        <UserPlus className="h-5 w-5 text-indigo-500" /> Add cleaners
      </h2>
      <p className="mt-1 text-[13px] text-ink-3">
        Two ways to bring someone on. You approve who joins, and they get set up on
        their own screen — it takes them about a minute to start.
      </p>

      {/* Join link — shareable by anyone in the office */}
      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Your join link</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline bg-bg-2/50 px-3 py-2">
            <Link2 className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
            <span className="truncate text-[13px] text-ink-2">{joinUrl}</span>
          </div>
          <button type="button" onClick={copy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700">
            {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
          </button>
          {canShare && (
            <button type="button" onClick={share}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-bg-2">
              <Share2 className="h-4 w-4" /> Share
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[12px] text-ink-3">Text or email it to anyone who might want to clean with you.</p>
      </div>

      {/* Invite someone directly — admin only (mints a crew login) */}
      {admin && (
        <form onSubmit={sendInvite} className="mt-5 border-t border-hairline pt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Or invite someone directly</div>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Name"
              autoComplete="name"
              className="w-full rounded-lg border border-hairline bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-ink-3 focus:border-indigo-500 focus:outline-none sm:w-44" />
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="Email"
              autoComplete="email"
              className="w-full flex-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-[14px] text-ink placeholder:text-ink-3 focus:border-indigo-500 focus:outline-none" />
            <button type="submit" disabled={sending}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50">
              <Send className="h-4 w-4" /> {sending ? 'Sending…' : 'Send invite'}
            </button>
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">
            They’ll get an email to set a password, then finish their file (insurance,
            W-9, the agreement) to get cleared for work.
          </p>
        </form>
      )}
    </div>
  )
}
