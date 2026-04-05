import { Routes, Route, Navigate } from 'react-router-dom'
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
import Settings from './pages/Settings'

export default function App() {
  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<ClientProfile />} />
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
