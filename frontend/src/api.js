/**
 * Centralized API client for BrightBase.
 *
 * Uses JWT authentication via Bearer token in Authorization header.
 * JWT is stored in localStorage and automatically included in all requests.
 *
 * JWT-only: the SPA never sends the shared X-API-Key. The backend still accepts
 * X-API-Key for server-to-server callers, but the browser must not carry the
 * master key (it was effectively a synthetic admin sitting in localStorage). No
 * JWT session → 401 → redirect to /login.
 */

export function setJWT(token) {
  if (token) {
    localStorage.setItem('brightbase_jwt', token)
  }
}

export function getJWT() {
  return localStorage.getItem('brightbase_jwt')
}

export function clearJWT() {
  localStorage.removeItem('brightbase_jwt')
}

export function logout() {
  clearJWT()
  window.location.href = '/login'
}

function headers(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra }
  const token = getJWT()
  if (token) {
    h["Authorization"] = `Bearer ${token}`
  }
  return h
}

/** Swap in a rotated JWT from the sliding-session middleware, if present. */
function maybeRotateToken(res) {
  try {
    const rotated = res?.headers?.get?.('X-Refresh-Token')
    if (rotated) setJWT(rotated)
  } catch { /* header not readable — ignore */ }
}

// Phase 0 reliability: every request gets a hard timeout so a hung/cold backend
// surfaces as a retryable error instead of an infinite spinner. Override per
// call with `options.timeout` (ms).
const DEFAULT_TIMEOUT_MS = 15000

async function fetchWithTimeout(url, options, timeoutMs) {
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

/**
 * Wrapper around fetch that:
 *  - Adds JWT Bearer token to Authorization header
 *  - Times out after DEFAULT_TIMEOUT_MS (no infinite spinners)
 *  - Retries idempotent GETs once on timeout/network failure (cold starts)
 *  - Throws on non-OK responses with useful error messages
 *  - Redirects to /login on 401 Unauthorized
 *  - Returns parsed JSON
 */
export async function api(url, options = {}) {
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS
  const method = (options.method || 'GET').toUpperCase()
  const fetchOpts = { ...options, headers: headers(options.headers) }

  let res
  try {
    res = await fetchWithTimeout(url, fetchOpts, timeoutMs)
  } catch (err) {
    // One automatic retry for GETs (idempotent) on timeout or network failure —
    // a single dropped request or a cold-start hiccup shouldn't bubble up as an
    // error the user has to manually retry. Non-GETs are not retried (a POST may
    // have been applied server-side even if the response was lost).
    const retryable = err?.isTimeout || err instanceof TypeError
    if (method === 'GET' && retryable) {
      res = await fetchWithTimeout(url, fetchOpts, timeoutMs)
    } else {
      throw err
    }
  }

  // Sliding session: if the server rotated our token (past half-life), swap it
  // in silently so an active user is never logged out mid-task.
  maybeRotateToken(res)

  // Handle 401 Unauthorized - redirect to login. But NOT for auth endpoints
  // (login/register/google) — a failed login should show "invalid login" in the
  // form, not hard-redirect to /login (which looks like an endless loop).
  if (res.status === 401 && !String(url).includes('/api/auth/')) {
    // Flag the timeout so /login can show a friendly note (and any in-progress
    // work — e.g. a booking draft — can be restored after re-auth).
    try { localStorage.setItem('brightbase_session_expired', '1') } catch { /* ignore */ }
    clearJWT()
    window.location.href = '/login'
    return
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    const raw = await res.text().catch(() => '')
    if (raw) {
      try {
        const body = JSON.parse(raw)
        const picked = body.detail ?? body.message ?? body.error ?? body
        // FastAPI 422 returns detail as an array of {loc, msg, type} objects;
        // coercing that to Error() yields "[object Object]" — JSON-stringify
        // anything that isn't already a string so the user sees the real cause.
        detail = typeof picked === 'string' ? picked : JSON.stringify(picked)
      } catch {
        // Not JSON — surface the raw text (trimmed) so we get a real reason
        const trimmed = raw.trim().slice(0, 300)
        if (trimmed) detail = `HTTP ${res.status}: ${trimmed}`
      }
    }
    throw new Error(detail)
  }

  // Handle 204 No Content
  if (res.status === 204) return null

  return res.json()
}

/** GET helper */
export const get = (url) => api(url);

/**
 * GET helper that de-duplicates concurrent and rapidly-repeated fetches of the
 * same URL. While a request is in flight, subsequent calls share its promise;
 * after it resolves, the result is cached for `ttlMs` so the next caller within
 * that window also reuses it. Use for read-only endpoints that several callers
 * load on the same navigation (e.g. /api/comms/conversations/summary fetched
 * by the dashboard, the unread-count poller, and the Comms page).
 */
const _getCachedInFlight = new Map() // url -> Promise
const _getCachedResults = new Map()  // url -> { value, expiresAt }
export function getCached(url, ttlMs = 5000) {
  const now = Date.now()
  const cached = _getCachedResults.get(url)
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.value)
  const inFlight = _getCachedInFlight.get(url)
  if (inFlight) return inFlight
  const p = api(url)
    .then((value) => {
      _getCachedResults.set(url, { value, expiresAt: Date.now() + ttlMs })
      return value
    })
    .finally(() => { _getCachedInFlight.delete(url) })
  _getCachedInFlight.set(url, p)
  return p
}

/** POST helper */
export const post = (url, body) =>
  api(url, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });

/** PUT helper */
export const put = (url, body) =>
  api(url, { method: "PUT", body: JSON.stringify(body) });

/** PATCH helper */
export const patch = (url, body) =>
  api(url, { method: "PATCH", body: JSON.stringify(body) });

/** DELETE helper */
export const del = (url) => api(url, { method: "DELETE" });

/**
 * POST with FormData (file uploads).
 * Does NOT set Content-Type — browser sets multipart boundary automatically.
 */
export async function upload(url, formData) {
  const h = {};
  const token = getJWT();
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: formData,
  });

  maybeRotateToken(res)

  if (res.status === 401) {
    try { localStorage.setItem('brightbase_session_expired', '1') } catch { /* ignore */ }
    clearJWT()
    window.location.href = '/login'
    return
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    const raw = await res.text().catch(() => '');
    if (raw) {
      try {
        const body = JSON.parse(raw);
        const picked = body.detail ?? body.message ?? body.error ?? body;
        detail = typeof picked === 'string' ? picked : JSON.stringify(picked);
      } catch {
        const trimmed = raw.trim().slice(0, 300);
        if (trimmed) detail = `HTTP ${res.status}: ${trimmed}`;
      }
    }
    throw new Error(detail);
  }

  return res.json();
}

/**
 * Download a file from an authenticated endpoint. Fetches with the JWT, reads
 * the response as a Blob, and triggers a browser save with the given filename.
 * Used for endpoints that return binary/attachments (e.g. a job's .ics invite),
 * where a plain <a href> would omit the Authorization header and 401.
 */
export async function download(url, filename) {
  const res = await fetch(url, { headers: headers() })
  maybeRotateToken(res)
  if (res.status === 401) {
    try { localStorage.setItem('brightbase_session_expired', '1') } catch { /* ignore */ }
    clearJWT()
    window.location.href = '/login'
    return
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    throw new Error(raw ? `HTTP ${res.status}: ${raw.slice(0, 200)}` : `HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = filename || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objUrl)
}

/**
 * Build a WebSocket URL that includes the API key as a query param.
 */
export function wsUrl(path) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}`;
  const sep = path.includes("?") ? "&" : "?";
  // Browsers can't set headers on WebSocket connects, so the JWT flows through a
  // query param. JWT-only — the SPA no longer passes the shared api_key.
  const token = getJWT();
  if (token) return `${base}${path}${sep}token=${encodeURIComponent(token)}`;
  return `${base}${path}`;
}
