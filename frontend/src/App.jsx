import { Component, useState, useCallback, useEffect, Suspense, lazy } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import BottomNav from './components/BottomNav'
import AICommandBar from './components/AICommandBar'
import GlobalSearch from './components/GlobalSearch'
import TweaksPanel from './components/dev/TweaksPanel'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Requests from './pages/Requests'
import PublicQuote from './pages/PublicQuote'
import PublicPayment from './pages/PublicPayment'
import { useUnreadCount } from './hooks/useUnreadCount'
import { playChime } from './utils/chime'
import { notify } from './utils/notifications'
import GlobalToasts from './components/ui/GlobalToasts'
import { pushToast } from './utils/toastBus'

const PageLoader = () => <div className="flex items-center justify-center min-h-screen">Loading...</div>

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
  state = { hasError: false, error: null }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <h1 className="text-xl font-semibold text-zinc-900">Something went wrong</h1>
          <p className="text-sm text-zinc-500 max-w-md">{this.state.error?.message || 'An unexpected error occurred.'}</p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >Reload page</button>
        </div>
      )
    }
    return this.props.children
  }
}

// Wraps Sidebar with the global unread poller. Lives inline in App so the
// poll only runs when the user is actually inside the authenticated shell
// (skipped on /login and public /quote/:token, /pay/:token routes).
function SidebarWithUnread(props) {
  const navigate = useNavigate()
  const { unreadConversations } = useUnreadCount({
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
  useEffect(() => {
    document.title = unreadConversations > 0
      ? `(${unreadConversations}) BrightBase`
      : 'BrightBase'
  }, [unreadConversations])
  return <Sidebar {...props} badges={{ '/comms': unreadConversations }} />
}

// Lazy-loaded pages for code splitting
const Today = lazy(() => import('./pages/Today'))
const Workspace = lazy(() => import('./pages/Workspace'))
const Clients = lazy(() => import('./pages/Clients'))
const ClientProfile = lazy(() => import('./pages/ClientProfile'))
const Quoting = lazy(() => import('./pages/Quoting'))
const Schedule = lazy(() => import('./pages/Schedule'))
const Invoicing = lazy(() => import('./pages/Invoicing'))
const Payroll = lazy(() => import('./pages/Payroll'))
const Comms = lazy(() => import('./pages/Comms'))
const Properties = lazy(() => import('./pages/Properties'))
const PropertyDetail = lazy(() => import('./pages/PropertyDetail'))
const PropertyIcalsBulk = lazy(() => import('./pages/PropertyIcalsBulk'))
const Settings = lazy(() => import('./pages/Settings'))
const Calendar = lazy(() => import('./pages/Calendar'))

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const location = useLocation()
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  useUnhandledErrorToasts()

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

  const handleLoginSuccess = (loginResponse) => {
    setUser(loginResponse)
    localStorage.setItem('brightbase_user', JSON.stringify(loginResponse))
  }

  if (loading) {
    return <div className="flex items-center justify-center h-screen bg-white">Loading...</div>
  }

  const isPublicRoute = location.pathname.startsWith('/quote/') || location.pathname.startsWith('/pay/')
  const isLoginRoute = location.pathname === '/login'
  const isAuthenticated = !!user && !!localStorage.getItem('brightbase_jwt')

  if (isPublicRoute) {
    return (
      <Routes>
        <Route path="/quote/:token" element={<PublicQuote />} />
        <Route path="/pay/:token" element={<PublicPayment />} />
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

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-bg">
      <SidebarWithUnread open={sidebarOpen} onClose={closeSidebar} user={user} />
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <Header onMenuToggle={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-auto bg-bg pb-bottomnav lg:pb-0 scroll-smooth-mobile">
          <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/today" element={<Today />} />
              <Route path="/workspace" element={<Workspace />} />
              <Route path="/clients" element={<Clients />} />
              <Route path="/clients/:id" element={<ClientProfile />} />
              <Route path="/requests" element={<Requests />} />
              <Route path="/pipeline" element={<Requests />} />
              <Route path="/quoting" element={<Quoting />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/scheduling" element={<Navigate to="/schedule" replace />} />
              <Route path="/calendar" element={<Calendar />} />
              <Route path="/invoicing" element={<Invoicing />} />
              <Route path="/dispatch" element={<Navigate to="/schedule?tab=dispatch" replace />} />
              <Route path="/payroll" element={<Payroll />} />
              <Route path="/comms" element={<Comms />} />
              <Route path="/properties" element={<Properties />} />
              <Route path="/properties/:propertyId" element={<PropertyDetail />} />
              <Route path="/properties/:propertyId/icals" element={<PropertyIcalsBulk />} />
              <Route path="/recurring" element={<Navigate to="/schedule?tab=recurring" replace />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <BottomNav />
      <AICommandBar />
      <GlobalSearch />
      <GlobalToasts />
      {import.meta.env.DEV && <TweaksPanel />}
    </div>
  )
}
