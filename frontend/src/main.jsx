import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { applyTheme } from './theme'

// Apply the saved theme (default: clean light) before first paint.
applyTheme()


// ── Global fetch interceptor ──
// Authenticated users send their Bearer JWT (set elsewhere). The shared API key
// is only used as a fallback when there is NO JWT session, so the master key no
// longer rides along on every request of a logged-in user (shrinks the blast
// radius of any XSS). The key should ultimately live server-side only.
const _origFetch = window.fetch
const STATIC_API_KEY = import.meta.env.VITE_API_KEY || localStorage.getItem("brightbase_api_key") || ""
window.fetch = function (url, opts = {}) {
  const reqUrl = typeof url === 'string' ? url : url?.url || ''
  const isSameOrigin = reqUrl.startsWith('/') || reqUrl.startsWith(window.location.origin)
  const hasJWT = !!localStorage.getItem("brightbase_jwt")
  if (STATIC_API_KEY && isSameOrigin && !hasJWT) {
    opts.headers = opts.headers || {}
    if (opts.headers instanceof Headers) {
      if (!opts.headers.has("X-API-Key")) opts.headers.set("X-API-Key", STATIC_API_KEY)
    } else {
      opts.headers["X-API-Key"] = opts.headers["X-API-Key"] || STATIC_API_KEY
    }
  }
  return _origFetch.call(this, url, opts)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
