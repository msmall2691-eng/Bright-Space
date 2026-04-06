import { useState, useCallback } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import Dashboard from './pages/Dashboard'
import Workspace from './pages/Workspace'
import Clients from './pages/Clients'
import ClientProfile from './pages/ClientProfile'
import Quoting from './pages/Quoting'
import Scheduling from './pages/Scheduling'
import Invoicing from './pages/Invoicing'
import Dispatch from './pages/Dispatch'
import Payroll from './pages/Payroll'
import Comms from './pages/Comms'
import Properties from './pages/Properties'
import Recurring from './pages/Recurring'
import Pipeline from './pages/Pipeline'
import Settings from './pages/Settings'

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()

  // Close sidebar on navigation (mobile)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <Header onMenuToggle={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<ClientProfile />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/quoting" element={<Quoting />} />
          <Route path="/scheduling" element={<Scheduling />} />
          <Route path="/invoicing" element={<Invoicing />} />
          <Route path="/dispatch" element={<Dispatch />} />
          <Route path="/payroll" element={<Payroll />} />
          <Route path="/comms" element={<Comms />} />
          <Route path="/properties" element={<Properties />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
        </main>
      </div>
    </div>
  )
}
