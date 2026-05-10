/**
 * Centralized API client for BrightBase.
 *
 * Uses JWT authentication via Bearer token in Authorization header.
 * JWT is stored in localStorage and automatically included in all requests.
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

/**
 * Wrapper around fetch that:
 *  - Adds JWT Bearer token to Authorization header
 *  - Throws on non-OK responses with useful error messages
 *  - Redirects to /login on 401 Unauthorized
 *  - Returns parsed JSON
 */
export async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: headers(options.headers),
  })

  // Handle 401 Unauthorized - redirect to login
  if (res.status === 401) {
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
        detail = body.detail || body.message || body.error || JSON.stringify(body)
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
  await ensureReady();
  const h = {};
  if (API_KEY) h["X-API-Key"] = API_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: formData,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    const raw = await res.text().catch(() => '');
    if (raw) {
      try {
        const body = JSON.parse(raw);
        detail = body.detail || body.message || body.error || JSON.stringify(body);
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
 * Build a WebSocket URL that includes the API key as a query param.
 */
export function wsUrl(path) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}`;
  const sep = path.includes("?") ? "&" : "?";
  return API_KEY ? `${base}${path}${sep}api_key=${API_KEY}` : `${base}${path}`;
}
