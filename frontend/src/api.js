/**
 * Centralized API client for BrightBase.
 *
 * All fetch calls should use these helpers instead of raw fetch().
 * The API key is injected automatically from environment, localStorage,
 * or fetched from the /api/config endpoint at startup.
 */

let API_KEY = import.meta.env.VITE_API_KEY || localStorage.getItem("brightbase_api_key") || "";

// In production, fetch the API key from the backend config endpoint
const _configReady = (API_KEY
  ? Promise.resolve()
  : fetch("/api/config")
      .then(r => r.json())
      .then(data => {
        if (data.api_key) {
          API_KEY = data.api_key;
          localStorage.setItem("brightbase_api_key", data.api_key);
        }
      })
      .catch(() => { /* config endpoint not available — dev mode */ })
);

/** Wait for API key to be ready before making requests */
async function ensureReady() {
  await _configReady;
}

function headers(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

/**
 * Wrapper around fetch that:
 *  - Waits for API key to be available
 *  - Adds API key header automatically
 *  - Throws on non-OK responses with useful error messages
 *  - Returns parsed JSON
 */
export async function api(url, options = {}) {
  await ensureReady();
  const res = await fetch(url, {
    ...options,
    headers: headers(options.headers),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      // Response wasn't JSON
    }
    throw new Error(detail);
  }

  // Handle 204 No Content
  if (res.status === 204) return null;

  return res.json();
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
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {}
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
