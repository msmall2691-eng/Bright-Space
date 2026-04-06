import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// ── Global fetch interceptor: inject API key into every request ──
const _origFetch = window.fetch
const API_KEY = import.meta.env.VITE_API_KEY || localStorage.getItem("brightbase_api_key") || ""
window.fetch = function (url, opts = {}) {
  if (API_KEY) {
    opts.headers = opts.headers || {}
    if (opts.headers instanceof Headers) {
      if (!opts.headers.has("X-API-Key")) opts.headers.set("X-API-Key", API_KEY)
    } else {
      opts.headers["X-API-Key"] = opts.headers["X-API-Key"] || API_KEY
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
