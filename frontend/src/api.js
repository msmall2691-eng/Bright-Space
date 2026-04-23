/**
 * Centralized API client for BrightBase.
 *
 * All fetch calls use JWT Bearer token from localStorage.
 * On 401, clears token and redirects to /login.
 */

let JWT_TOKEN = localStorage.getItem("brightbase_jwt") || "";

/** Store JWT token (called after login) */
export function setJWT(token) {
  JWT_TOKEN = token;
  localStorage.setItem("brightbase_jwt", token);
}

/** Clear JWT token and user (called on logout or auth failure) */
export function clearJWT() {
  JWT_TOKEN = "";
  localStorage.removeItem("brightbase_jwt");
  localStorage.removeItem("brightbase_user");
}

/** Logout: clear session and redirect to login */
export function logout() {
  clearJWT();
  window.location.href = "/login";
}

function headers(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (JWT_TOKEN) {
    h["Authorization"] = `Bearer ${JWT_TOKEN}`;
  }
  return h;
}

function handleAuthError() {
  clearJWT();
  window.location.href = "/login";
}

/**
 * Wrapper around fetch that:
 *  - Adds JWT Authorization header
 *  - On 401: clears JWT and redirects to /login
 *  - Throws on non-OK responses with useful error messages
 *  - Returns parsed JSON
 */
export async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: headers(options.headers),
  });

  if (res.status === 401) {
    handleAuthError();
    throw new Error("Unauthorized");
  }

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
  const h = {};
  if (JWT_TOKEN) h["Authorization"] = `Bearer ${JWT_TOKEN}`;

  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: formData,
  });

  if (res.status === 401) {
    handleAuthError();
    throw new Error("Unauthorized");
  }

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
