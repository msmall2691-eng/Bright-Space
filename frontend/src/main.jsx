import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { applyTheme } from './theme'

// Apply the saved theme (default: clean light) before first paint.
applyTheme()


// ── Global fetch interceptor ──
// Authenticate every same-origin request that doesn't already carry a
// credential: prefer the user's Bearer JWT, and only fall back to the shared
// API key when there's no JWT session (login/public flows). This keeps the
// admin key off a logged-in user's traffic (shrinks XSS blast radius) WITHOUT
// breaking the call sites that use fetch() directly instead of the api()
// wrapper — they now get the JWT automatically. The key should ultimately live
// server-side only.
const _origFetch = window.fetch
const STATIC_API_KEY = import.meta.env.VITE_API_KEY || localStorage.getItem("brightbase_api_key") || ""
window.fetch = function (url, opts = {}) {
  const reqUrl = typeof url === 'string' ? url : url?.url || ''
  const isSameOrigin = reqUrl.startsWith('/') || reqUrl.startsWith(window.location.origin)
  if (isSameOrigin) {
    opts.headers = opts.headers || {}
    const isHeaders = opts.headers instanceof Headers
    const getH = (k) => (isHeaders ? opts.headers.get(k) : opts.headers[k])
    const setH = (k, v) => (isHeaders ? opts.headers.set(k, v) : (opts.headers[k] = v))
    const hasCred = !!getH("Authorization") || !!getH("X-API-Key")
    if (!hasCred) {
      const jwt = localStorage.getItem("brightbase_jwt")
      if (jwt) setH("Authorization", `Bearer ${jwt}`)
      else if (STATIC_API_KEY) setH("X-API-Key", STATIC_API_KEY)
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
