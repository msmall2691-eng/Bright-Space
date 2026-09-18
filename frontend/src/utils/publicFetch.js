/**
 * publicFetch — fetch for the UNAUTHENTICATED customer pages (PublicQuote,
 * PublicJobConfirm). Same hard-timeout + single-GET-retry reliability as the
 * app's api.js client, but WITHOUT the JWT header and WITHOUT the 401 → /login
 * redirect: a logged-out customer must never be bounced to the login page.
 *
 * Why it exists: the public pages called window.fetch with no timeout, so a
 * cold/hung Railway backend left the customer's most important screen — their
 * quote — spinning forever with no error and no way to retry. This turns that
 * into a normal caught error the page already renders.
 *
 * Returns the raw Response, so callers keep their own res.ok / res.json()
 * handling unchanged.
 */
const DEFAULT_TIMEOUT_MS = 15000

export async function publicFetch(url, options = {}) {
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS
  const method = (options.method || 'GET').toUpperCase()

  const once = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (err) {
      if (err?.name === 'AbortError') {
        const e = new Error('Request timed out — the server took too long to respond.')
        e.isTimeout = true
        throw e
      }
      throw err  // network/DNS failure (TypeError: Failed to fetch)
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    return await once()
  } catch (err) {
    // One automatic retry for idempotent GETs on timeout/network failure (cold
    // starts). A POST is never retried — it may have applied server-side even if
    // the response was lost.
    const retryable = err?.isTimeout || err instanceof TypeError
    if (method === 'GET' && retryable) return await once()
    throw err
  }
}
