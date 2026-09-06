/**
 * What to do when a staff invite email didn't send.
 *
 * The set-password token exists ONLY inside that email. So a send that fails
 * silently leaves a real, approved account nobody can ever reach: status
 * "invited", no password, and no second copy of the link anywhere. Resend
 * fails the same way when the cause is configuration rather than a hiccup.
 *
 * The backend now says so — every invite-sending endpoint returns
 * `invite_sent`, plus `invite_link` and `invite_error` when it is false. This
 * turns that into the one thing that actually rescues the situation: the link,
 * on screen, copyable, so the office can text it instead.
 *
 * The link is a credential (seven days, single use, sets a password on that
 * account), which is why the server withholds it whenever the mail DID send —
 * there is nothing to rescue then — and why this shows it in a dialog the
 * office dismisses rather than a toast that scrolls away into a screenshot.
 *
 * Returns true when it handled a failure, so callers can skip their own
 * success toast: `if (await reportInvite(res, email)) return`.
 */
import { confirmDialog } from './confirmBus'
import { copyToClipboard } from './clipboard'
import { pushToast } from './toastBus'

export async function reportInvite(res, email) {
  // Only an explicit false is a failure. An older response with no
  // invite_sent field at all must not be reported as a problem.
  if (!res || res.invite_sent !== false) return false

  const link = res.invite_link || ''
  const why = res.invite_error ? `\n\nThe mail server said: ${res.invite_error}` : ''
  const body = link
    ? `The account for ${email} is created, but the invite email did not send — `
      + 'so they have no way to set a password yet.\n\n'
      + 'Send them this link instead. It works for 7 days and can only be used '
      + `once:\n\n${link}${why}`
    : `The account for ${email} is created, but the invite email did not send `
      + 'and no link could be generated. Check Settings → Email, then use '
      + `Resend.${why}`

  const copy = await confirmDialog(body, {
    title: 'Invite didn’t send',
    confirmLabel: link ? 'Copy link' : 'OK',
    cancelLabel: 'Close',
  })
  if (copy && link) {
    const ok = await copyToClipboard(link)
    pushToast(ok ? 'Invite link copied.' : 'Couldn’t copy — select the link and copy it by hand.',
              ok ? 'success' : 'error')
  }
  return true
}
