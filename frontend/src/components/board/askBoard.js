/**
 * The board's single path to the assistant.
 *
 * BoardAssistant (the "Ask" panel) and AgentHelp (the always-visible Home
 * widget) both ask the same backend the same way: POST /api/ai/quick with
 * page_context 'dashboard', which answers from live business data via the
 * read-only tools in agents/tools.py. It lives here so there is exactly ONE
 * call site shape for it — a second, drifting copy of the request body (a
 * different page_context, say) would quietly give the two surfaces different
 * answers to the same question.
 *
 * NOTE this endpoint is READ-ONLY by design: it answers questions, it does
 * not send, draft, or schedule anything. Phrase prompts as questions.
 */
import { post } from '../../api'

export const BOARD_PAGE_CONTEXT = 'dashboard'

/**
 * Ask the board assistant a question.
 * Resolves to { answer, error } — never throws, because every caller's
 * failure behaviour is the same calm one-liner, not an error card.
 */
export async function askBoard(question) {
  const q = String(question || '').trim()
  if (!q) return { answer: '', error: true }
  try {
    const res = await post('/api/ai/quick', { question: q, page_context: BOARD_PAGE_CONTEXT })
    // The backend returns { answer, error } — error:true when the model isn't
    // configured or the call failed, with human-readable prose in `answer`.
    return { answer: res?.answer || '', error: !!res?.error || !res?.answer }
  } catch {
    return { answer: '', error: true }
  }
}
