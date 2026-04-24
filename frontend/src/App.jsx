import { useState, useCallback, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import BottomNav from './components/BottomNav'
import AICommandBar from './components/AICommandBar'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Workspace from './pages/Workspace'
import Clients from './pages/Clients'
import ClientProfile from './pages/ClientProfile'
import Quoting from './pages/Quoting'
import Schedule from './pages/Schedule'
import Invoicing from './pages/Invoicing'
import Payroll from './pages/Payroll'
import Comms from './pages/Comms'
import Properties from './pages/Properties'
import PropertyDetail from './pages/PropertyDetail'
import Requests from './pages/Requests'
import Settings from './pages/Settings'
import PublicQuote from './pages/PublicQuote'

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const location = useLocation()
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

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

  const isPublicRoute = location.pathname.startsWith('/quote/')
  const isLoginRoute = location.pathname === '/login'
  const isAuthenticated = !!user && !!localStorage.getItem('brightbase_jwt')

  if (isPublicRoute) {
    return (
      <Routes>
        <Route path="/quote/:token" element={<PublicQuote />} />
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
    <div className="flex h-[100dvh] overflow-hidden bg-[#FCFCFC]">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} user={user} />
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <Header onMenuToggle={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-auto bg-[#FCFCFC] pb-bottomnav lg:pb-0 scroll-smooth-mobile">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/clients/:id" element={<ClientProfile />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/pipeline" element={<Requests />} />
            <Route path="/quoting" element={<Quoting />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/scheduling" element={<Navigate to="/schedule" replace />} />
            <Route path="/invoicing" element={<Invoicing />} />
            <Route path="/dispatch" element={<Navigate to="/schedule?tab=dispatch" replace />} />
            <Route path="/payroll" element={<Payroll />} />
            <Route path="/comms" element={<Comms />} />
            <Route path="/properties" element={<Properties />} />
            <Route path="/properties/:propertyId" element={<PropertyDetail />} />
            <Route path="/recurring" element={<Navigate to="/schedule?tab=recurring" replace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
      <BottomNav />
      <AICommandBar />
    </div>
  )
}
