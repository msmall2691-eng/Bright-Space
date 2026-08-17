import { Component, useState, useCallback, useEffect, Suspense, lazy } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import BottomNav from './components/BottomNav'
import PageAssistant from './components/PageAssistant'
import GlobalSearch from './components/GlobalSearch'
import Login from './pages/Login'
import PendingApproval from './pages/PendingApproval'
import OpsBoard from './pages/OpsBoard'
import MyDay from './pages/MyDay'
import Requests from './pages/Requests'
import Pipeline from './pages/Pipeline'
import Deals from './pages/Deals'
import PublicQuote from './pages/PublicQuote'
import PublicPayment from './pages/PublicPayment'
import PublicJobConfirm from './pages/PublicJobConfirm'
import CustomerPortal from './pages/CustomerPortal'
import PortalVerify from './pages/PortalVerify'
import AcceptInvite from './pages/AcceptInvite'
import { useUnreadCount } from './hooks/useUnreadCount'
import { recordVisit } from './nav/recents'
import { playChime } from './utils/chime'
import { notify } from './utils/notifications'
import { pushToast } from './utils/toastBus'

const PageLoader = () => <div className="flex items-center justify-center min-h-screen">Loading...</div>

// Warms the browser's module cache for the primary nav pages during idle
// time right after login, so the FIRST click on Schedule/Messages/Clients/
// etc. doesn't pay a network round-trip on top of the render — the chunk is
// already fetched by the time React.lazy asks for it. Module-scope flag (not
// component state) because the warm-up should happen once per tab, not once
// per mount. Economy-conscious: office roles only (a cleaner's whole app is
// My Day, already eagerly bundled — don't ship them megabytes of office
// code), and it's idle-time so it never competes with an actual navigation.
let _navChunksWarmed = false
function warmNavChunks() {
  if (_navChunksWarmed) return
  _navChunksWarmed = true
  const warm = () => {
    import('./pages/Schedule')
    import('./pages/Comms')
    import('./pages/Clients')
    import('./pages/Properties')
    import('./pages/Recurring')
    import('./pages/Billing')
    import('./pages/OwnerDashboard')
  }
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 4000 })
  else setTimeout(warm, 1500)
}

// A deploy renames every page's chunk file (content-hashed). A tab left open
// across a deploy still holds the OLD chunk map in memory, so the next
// lazy-loaded page (React.lazy/dynamic import()) 404s — "Failed to fetch
// dynamically imported module" — and used to dead-end on the error screen
// with the new page never once rendering. One hard reload fixes it (the tab
// picks up the new chunk map); a sessionStorage timestamp caps it to once per
// 10s so a genuinely-broken chunk doesn't reload-loop forever.
const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i
function tryRecoverFromChunkError(err) {
  const msg = (err && (err.message || String(err))) || ''
  if (!CHUNK_ERROR_RE.test(msg)) return false
  const key = 'bb_chunk_reload_at'
  const last = Number(sessionStorage.getItem(key) || 0)
  if (Date.now() - last < 10000) return false
  sessionStorage.setItem(key, String(Date.now()))
  window.location.reload()
  return true
}

// Safety net for errors a page didn't catch itself: a thrown mutation (e.g. an
// `onClick={async …}` with no try/catch) rejects, and without this the user
// sees nothing. We surface the real reason as a toast. Pages that DO catch and
// toast their own errors won't reach here, so this doesn't double up.
function useUnhandledErrorToasts() {
  useEffect(() => {
    // Debounce identical messages — a burst (e.g. a list of N failing rows)
    // shouldn't stack N identical red toasts.
    let lastMsg = ''
    let lastAt = 0
    const surface = (raw) => {
      if (tryRecoverFromChunkError(raw)) return
      const msg = (raw && (raw.message || String(raw))) || ''
      if (!msg || msg === 'undefined' || msg === '[object Object]') return
      // api() resolves (not rejects) on 401 — it redirects to /login — so auth
      // bounces never reach here. Guard anyway against a stray "Failed to fetch"
      // storm from a dropped connection during navigation.
      const now = Date.now()
      if (msg === lastMsg && now - lastAt < 4000) return
      lastMsg = msg; lastAt = now
      pushToast(msg, 'error')
    }
    const onRejection = (e) => surface(e?.reason)
    const onError = (e) => { if (e?.error) surface(e.error) }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [])
}

class ErrorBoundary extends Component {
  state = { hasError: false, error: null, recovering: false }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  componentDidCatch(error) {
    // tryRecoverFromChunkError reloads (and returns true) unless it already
    // tried within the last 10s — in which case this is either a second tab
    // hitting the same stale chunk (the reload elsewhere will fix this one
    // too on its next mount) or a genuinely broken chunk, so fall through to
    // the normal error screen rather than spin forever.
    if (tryRecoverFromChunkError(error)) this.setState({ recovering: true })
  }
  render() {
    if (this.state.hasError) {
      if (this.state.recovering) return <PageLoader />
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
          <p className="text-sm text-ink-3 max-w-md">{this.state.error?.message || 'An unexpected error occurred.'}</p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
          >Reload page</button>
        </div>
      )
    }
    return this.props.children
  }
}

// Wraps Sidebar with the global unread poller. Lives inline in App so the
// poll only runs when the user is actually inside the authenticated shell
// (skipped on /login and public /quote/:token, /pay/:token, /job/:token routes).
function SidebarWithUnread(props) {
  const navigate = useNavigate()
  const { unreadConversations, crewUnreadThreads } = useUnreadCount({
    onIncrease: (newTotal, prevTotal) => {
      playChime()
      const delta = newTotal - prevTotal
      // notify() is a no-op when the tab is already visible, so we avoid
      // showing a desktop popup on top of the in-app chime + badge.
      notify(delta === 1 ? 'New message' : `${delta} new messages`, {
        body: 'Open BrightBase to view',
        tag: 'brightbase-comms',
        onClick: () => navigate('/comms'),
      })
    },
  })
  // The Messages badge covers BOTH inboxes — client conversations and crew
  // chat threads (the Clients | Crew views of /comms) — as one quiet number.
  const messagesBadge = unreadConversations + crewUnreadThreads
  useEffect(() => {
    document.title = messagesBadge > 0
      ? `(${messagesBadge}) BrightBase`
      : 'BrightBase'
  }, [messagesBadge])
  return <Sidebar {...props} badges={{ '/comms': messagesBadge }} />
}

// Lazy-loaded pages for code splitting
const Workspace = lazy(() => import('./pages/Workspace'))
const Clients = lazy(() => import('./pages/Clients'))
const ClientProfile = lazy(() => import('./pages/ClientProfile'))
const RequestDetail = lazy(() => import('./pages/RequestDetail'))
const OpportunityDetail = lazy(() => import('./pages/OpportunityDetail'))
const JobDetail = lazy(() => import('./pages/JobDetail'))
const QuoteDetail = lazy(() => import('./pages/QuoteDetail'))
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'))
const Schedule = lazy(() => import('./pages/Schedule'))
const Billing = lazy(() => import('./pages/Billing'))
const Payroll = lazy(() => import('./pages/Payroll'))
const Comms = lazy(() => import('./pages/Comms'))
const Properties = lazy(() => import('./pages/Properties'))
const PropertyDetail = lazy(() => import('./pages/PropertyDetail'))
const PropertyIcalsBulk = lazy(() => import('./pages/PropertyIcalsBulk'))
const Recurring = lazy(() => import('./pages/Recurring'))
const SyncCenter = lazy(() => import('./pages/SyncCenter'))
const OwnerDashboard = lazy(() => import('./pages/OwnerDashboard'))
const Cleanup = lazy(() => import('./pages/Cleanup'))
const QuoteFunnel = lazy(() => import('./pages/QuoteFunnel'))
const Crew = lazy(() => import('./pages/Crew'))
const Settings = lazy(() => import('./pages/Settings'))
const DesignSystem = lazy(() => import('./pages/DesignSystem'))

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Desktop sidebar: visible by default, collapsible to fully hidden (the
  // topbar grows a reopen button). Persisted so the choice sticks.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('bb_sidebar_collapsed') === '1' } catch { return false }
  })
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const location = useLocation()
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const setCollapsed = useCallback((v) => {
    setSidebarCollapsed(v)
    try { localStorage.setItem('bb_sidebar_collapsed', v ? '1' : '0') } catch { /* ignore */ }
  }, [])
  useUnhandledErrorToasts()

  // The mobile bottom nav's "More" button opens the full menu drawer.
  useEffect(() => {
    const open = () => setSidebarOpen(true)
    window.addEventListener('bb:open-menu', open)
    return () => window.removeEventListener('bb:open-menu', open)
  }, [])

  // Feed the quick switcher's Recents. Only meaningful inside the CRM shell —
  // recordVisit itself skips login/public paths, and crew accounts never
  // render a route the switcher could jump to.
  useEffect(() => {
    if (!user || user.status === 'pending' || user.role === 'cleaner') return
    return recordVisit(location.pathname)
  }, [location.pathname, user])

  useEffect(() => {
    const jwt = localStorage.getItem('brightbase_jwt')
    const storedUser = localStorage.getItem('brightbase_user')
    if (jwt && storedUser) {
      try {
        setUser(JSON.parse(storedUser))
      } catch {
        localStorage.removeItem('brightbase_user')
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (loading || !user || user.status === 'pending' || user.role === 'cleaner') return
    warmNavChunks()
  }, [loading, user])

  const handleLoginSuccess = (loginResponse) => {
    setUser(loginResponse)
    localStorage.setItem('brightbase_user', JSON.stringify(loginResponse))
  }

  if (loading) {
    return <div className="flex items-center justify-center h-screen bg-white">Loading...</div>
  }

  const isPublicRoute = location.pathname.startsWith('/quote/') || location.pathname.startsWith('/pay/')
    || location.pathname.startsWith('/job/') || location.pathname.startsWith('/portal')
    || location.pathname.startsWith('/accept-invite')
  const isLoginRoute = location.pathname === '/login'
  const isAuthenticated = !!user && !!localStorage.getItem('brightbase_jwt')

  if (isPublicRoute) {
    return (
      <Routes>
        <Route path="/quote/:token" element={<PublicQuote />} />
        <Route path="/pay/:token" element={<PublicPayment />} />
        <Route path="/job/:token" element={<PublicJobConfirm />} />
        <Route path="/portal/verify" element={<PortalVerify />} />
        <Route path="/portal" element={<CustomerPortal />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    )
  }

  if (!isAuthenticated && !isLoginRoute) {
    return <Navigate to="/login" replace />
  }

  if (isLoginRoute && isAuthenticated) {
    return <Navigate to="/dashboard" replace />
  }

  if (isLoginRoute) {
    return <Login onLoginSuccess={handleLoginSuccess} />
  }

  // Signed up but not approved yet: identity is valid, data access is not —
  // every API call would 403 pending_approval, so show the waiting room only.
  if (user?.status === 'pending') {
    return (
      <PendingApproval
        user={user}
        onApproved={(updated) => {
          setUser(updated)
          localStorage.setItem('brightbase_user', JSON.stringify(updated))
        }}
      />
    )
  }

  // Crew accounts get a standalone, chrome-free view — never the full CRM
  // shell (Sidebar/Header/nav), regardless of which URL they land on. This
  // is the enforcement point, not just a route: a cleaner typing /clients
  // still gets My Day, not a 403'd blank CRM page.
  if (user?.role === 'cleaner') {
    return <MyDay />
  }

  return (
    // The app frame (Twenty-style): a quiet gray ground holding the sidebar
    // and one rounded white-ish "sheet" per page. The sheet — not the frame —
    // scrolls, so the sidebar and gutter stay put.
    <div className="flex h-[100dvh] overflow-hidden bg-frame">
      <SidebarWithUnread
        open={sidebarOpen}
        onClose={closeSidebar}
        collapsed={sidebarCollapsed}
        onCollapse={() => setCollapsed(true)}
        user={user}
      />
      <div className="flex flex-col flex-1 overflow-hidden min-w-0 shell:py-2 shell:pr-2 shell:pl-0.5">
        <div className="flex flex-col flex-1 overflow-hidden bg-bg shell:rounded-lg shell:border shell:border-hairline-2 shell:shadow-glass-sm">
        <Header
          onMenuToggle={() => setSidebarOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          onSidebarExpand={() => setCollapsed(false)}
        />
        <main className="flex-1 overflow-auto bg-bg bb-app-canvas pb-bottomnav shell:pb-0 scroll-smooth-mobile">
          <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<OpsBoard />} />
              {/* Today merged into the Dashboard's "Today's schedule" section. */}
              <Route path="/today" element={<Navigate to="/dashboard" replace />} />
              <Route path="/workspace" element={<Workspace />} />
              <Route path="/clients" element={<Clients />} />
              <Route path="/clients/:id" element={<ClientProfile />} />
              <Route path="/requests" element={<Requests />} />
              <Route path="/requests/:id" element={<RequestDetail />} />
              <Route path="/pipeline" element={<Pipeline />} />
              <Route path="/deals" element={<Deals />} />
              <Route path="/opportunities/:id" element={<OpportunityDetail />} />
              <Route path="/jobs/:id" element={<JobDetail />} />
              <Route path="/quotes/:id" element={<QuoteDetail />} />
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
              {/* Quoting + Invoicing consolidated under one Billing surface. */}
              <Route path="/billing" element={<Billing />} />
              <Route path="/quoting" element={<Navigate to="/billing?view=quotes" replace />} />
              <Route path="/invoicing" element={<Navigate to="/billing?view=invoices" replace />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/scheduling" element={<Navigate to="/schedule" replace />} />
              {/* Sync Control Center — one screen for every external schedule
                  BrightBase pushes to / pulls from (Google, Airbnb feeds,
                  recurring), the background ticks, and the master
                  auto-pilot switch. */}
              <Route path="/sync" element={<SyncCenter />} />
              {/* Calendar dropped — native Schedule covers it (and syncs to GCal). */}
              <Route path="/calendar" element={<Navigate to="/schedule" replace />} />
              {/* Schedule reads the view mode from ?view=, not ?tab= (?tab=
                  is reserved for recurring/availability) — this redirect
                  used to send ?tab=dispatch, which Schedule.jsx silently
                  ignored (it happened to still land on the dispatch board
                  on desktop only because that's the default view there). */}
              <Route path="/dispatch" element={<Navigate to="/schedule?view=dispatch" replace />} />
              <Route path="/payroll" element={<Payroll />} />
              <Route path="/crew" element={<Crew />} />
              {/* Connecteam is gone — the crew is native (My Day + Crew page,
                  payroll reads the native time clock). Old bookmarks land on
                  the nearest native equivalent. */}
              <Route path="/crew-hours" element={<Navigate to="/payroll" replace />} />
              <Route path="/connecteam" element={<Navigate to="/crew" replace />} />
              <Route path="/comms" element={<Comms />} />
              <Route path="/properties" element={<Properties />} />
              <Route path="/properties/:propertyId" element={<PropertyDetail />} />
              <Route path="/properties/:propertyId/icals" element={<PropertyIcalsBulk />} />
              {/* The single home for recurring bookings — create a series,
                  list of series, per-visit skip/reschedule (just this visit),
                  and rule edits (future visits only). The old
                  /schedule?tab=recurring summary tab now redirects here. */}
              <Route path="/recurring" element={<Recurring />} />
              <Route path="/owner" element={<OwnerDashboard />} />
              {/* Tidy Up — retroactive duplicate detection + merge, and data-
                  quality flags. Reached from the board's "Tidy Up" nudge. */}
              <Route path="/cleanup" element={<Cleanup />} />
              <Route path="/funnel" element={<QuoteFunnel />} />
              <Route path="/settings" element={<Settings />} />
              {/* Living style guide — every design token + components/ui/
                  primitive in its documented states. Internal reference,
                  not linked from the main nav. */}
              <Route path="/design-system" element={<DesignSystem />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
          </ErrorBoundary>
        </main>
        </div>
      </div>
      <BottomNav />
      <PageAssistant />
      <GlobalSearch />
      {/* GlobalToasts is mounted once at the app root (main.jsx) so it covers
          every route, including /login and the public pages. */}
    </div>
  )
}
