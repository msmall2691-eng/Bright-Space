import { useCallback, useEffect, useState } from 'react'
import { get, post } from '../api'

const currentUsername = () =>
  JSON.parse(localStorage.getItem('brightbase_user') || '{}')?.email?.split('@')[0] || 'Unknown'

/** Contact-scoped conversation for the Requests drawer's inline thread
 *  panel — a lighter-weight sibling to useCommsData/useCommsMutations
 *  (no folders, chip filters, or assignment; this is a single-contact
 *  view, not an inbox).
 *
 *  A LeadIntake usually predates any Client record, so there's no
 *  client_id to key off. We reuse the same substring match the Comms
 *  list endpoint already does for its search box: normalize the phone
 *  to its bare 10-digit tail (the DB stores E.164, e.g. "+12075551234",
 *  so "2075551234" still matches as a substring) and try email first,
 *  then phone, since email is the more stable identifier when both
 *  exist. First hit wins — last_message_at desc means it's already the
 *  most recently active thread for that contact.
 *
 *  If no conversation exists yet, `detail` stays null and `channel`
 *  defaults to whichever contact field is available (phone > email,
 *  matching the Call/Text-first framing of the request drawer). Sending
 *  the first message goes through POST /api/comms/sms or /email, which
 *  auto-creates the conversation server-side (find_or_create_conversation);
 *  the response's conversation_id is then used to load the full thread. */
export function useIntakeThread(intake) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [channel, setChannel] = useState(intake?.phone ? 'sms' : 'email')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return }
    setLoading(true)
    try {
      setDetail(await get(`/api/comms/conversations/${id}`))
    } catch (e) {
      console.error('[useIntakeThread] loadDetail:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const find = async () => {
      setLoading(true)
      setDetail(null)
      setError(null)
      const candidates = []
      if (intake?.email) candidates.push(intake.email.trim().toLowerCase())
      if (intake?.phone) {
        const digits = intake.phone.replace(/\D/g, '')
        candidates.push(digits.length > 10 ? digits.slice(-10) : digits)
      }
      try {
        for (const q of candidates) {
          if (!q) continue
          const rows = await get(`/api/comms/conversations?q=${encodeURIComponent(q)}&limit=5`)
          if (rows?.length) {
            if (cancelled) return
            setChannel(rows[0].channel)
            await loadDetail(rows[0].id)
            return
          }
        }
        // No existing thread — leave detail null; default channel already
        // set from the intake's available contact fields.
      } catch (e) {
        console.error('[useIntakeThread] find:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (intake) find()
    return () => { cancelled = true }
  }, [intake?.id, intake?.email, intake?.phone, loadDetail])

  const send = useCallback(async ({ body, subject, isNote }) => {
    if (!body?.trim() || !intake) return
    setSending(true)
    setError(null)
    try {
      const author = currentUsername()
      if (detail?.id) {
        // Existing thread: reuse the same endpoints Comms uses so this
        // panel and the full inbox never drift on send semantics.
        if (isNote) {
          await post(`/api/comms/conversations/${detail.id}/notes`, { body, author })
        } else {
          await post(`/api/comms/conversations/${detail.id}/messages`, {
            body,
            subject: detail.channel === 'email' ? (subject || detail.subject) : undefined,
            author,
          })
        }
        await loadDetail(detail.id)
      } else if (channel === 'sms') {
        if (!intake.phone) throw new Error('This lead has no phone number on file.')
        const res = await post('/api/comms/sms', { to: intake.phone, body, client_id: intake.client_id })
        if (res?.success === false) {
          // Twilio accepted the send but we failed to persist it locally —
          // still a real send, just tell the operator it didn't land in
          // the thread (mirrors ComposeModal's handling of this envelope).
          throw new Error(`Sent, but not recorded in the thread (Twilio sid: ${res.twilio_sid || 'n/a'}).`)
        }
        if (res?.conversation_id) await loadDetail(res.conversation_id)
      } else {
        if (!intake.email) throw new Error('This lead has no email on file.')
        const res = await post('/api/comms/email', {
          to: intake.email,
          subject: subject || `Re: your cleaning request`,
          body,
          client_id: intake.client_id,
        })
        if (res?.conversation_id) await loadDetail(res.conversation_id)
      }
      return true
    } catch (e) {
      setError(e.message || String(e))
      return false
    } finally {
      setSending(false)
    }
  }, [detail, intake, channel, loadDetail])

  return { detail, loading, channel, setChannel, send, sending, error }
}
