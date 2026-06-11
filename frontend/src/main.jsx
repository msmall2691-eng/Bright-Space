import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import GlobalToasts from './components/ui/GlobalToasts'
import './index.css'
import { applyTheme } from './theme'

// Apply the saved theme (default: clean light) before first paint.
applyTheme()


// ── Global fetch interceptor ──
// Attach the user's Bearer JWT to every same-origin request that doesn't already
// carry a credential, so call sites using fetch() directly (not the api()
// wrapper) still authenticate. JWT-only: the SPA never sends the shared
// X-API-Key — the master key must not live in the browser (it was effectively a
// synthetic admin). No JWT → the request 401s → the api() wrapper redirects to
// /login. The backend still accepts X-API-Key for server-to-server callers.
const _origFetch = window.fetch
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
    }
  }
  return _origFetch.call(this, url, opts)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      {/* Mounted at the root — outside App's route branching — so the global
          error-toast safety net works on every route (login, public /quote
          and /pay, the loading splash), not just the authenticated shell. */}
      <GlobalToasts />
    </BrowserRouter>
  </React.StrictMode>
)
