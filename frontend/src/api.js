/**
 * Centralized API client for BrightBase.
 *
 * Uses JWT authentication via Bearer token in Authorization header.
 * JWT is stored in localStorage and automatically included in all requests.
 *
 * Note on API_KEY: main.jsx installs a global fetch interceptor that
 * injects X-API-Key on every fetch, so most call paths don't need to
 * touch this directly. We still need it for `wsUrl()` (WebSocket URLs
 * can't go through fetch) and as a fallback inside `upload()`.
 */

const API_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_KEY)
  || (typeof localStorage !== 'undefined' ? localStorage.getItem('brightbase_api_key') : '')
  || ''

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
  if (API_KEY) h["X-API-Key"] = API_KEY;
  const token = getJWT();
  if (token) h["Authorization"] = `Bearer ${token}`;

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
 * Build a WebSocket URL that includes the API key as a query param.
 */
export function wsUrl(path) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${window.location.host}`;
  const sep = path.includes("?") ? "&" : "?";
  // Browsers can't set headers on WebSocket connects, so JWT and API key
  // both flow through query params. Backend (/ws/agent/*) checks JWT first,
  // falls back to API key (matches the HTTP middleware).
  const token = getJWT();
  if (token) return `${base}${path}${sep}token=${encodeURIComponent(token)}`;
  if (API_KEY) return `${base}${path}${sep}api_key=${encodeURIComponent(API_KEY)}`;
  return `${base}${path}`;
}
