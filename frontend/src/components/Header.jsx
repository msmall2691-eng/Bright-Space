import { useLocation } from 'react-router-dom'
import { Menu } from 'lucide-react'

const titles = {
  '/dashboard':  { label: 'Dashboard',             desc: "Your business at a glance" },
  '/workspace':  { label: 'Workspace',             desc: 'Chat with your AI agents' },
  '/clients':    { label: 'Clients',               desc: 'Client management & onboarding' },
  '/quoting':    { label: 'Quoting',               desc: 'Build and send quotes' },
  '/scheduling': { label: 'Schedule',              desc: 'Jobs and calendar' },
  '/invoicing':  { label: 'Invoicing',             desc: 'Invoices and payments' },
  '/dispatch':   { label: 'Dispatch',              desc: 'Push shifts to Connecteam' },
  '/payroll':    { label: 'Payroll',               desc: 'Timesheets and mileage from Connecteam' },
  '/comms':      { label: 'Comms',                 desc: 'SMS, email, and leads' },
  '/properties': { label: 'STR Properties',        desc: 'Airbnb & VRBO iCal sync → auto turnover jobs' },
  '/recurring':  { label: 'Recurring Schedules',   desc: 'Weekly, biweekly & monthly cleaning schedules' },
}

export default function Header({ onMenuToggle }) {
  const { pathname } = useLocation()
  const base = '/' + pathname.split('/')[1]
  const info = titles[base] || { label: 'BrightBase', desc: '' }

  return (
    <header className="h-[52px] bg-white border-b border-gray-200 flex items-center px-4 sm:px-7 shrink-0">
      <button
        onClick={onMenuToggle}
        className="lg:hidden p-2 -ml-2 mr-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-[13px] font-semibold text-gray-900 shrink-0">{info.label}</h1>
        {info.desc && (
          <>
            <span className="text-gray-300 hidden sm:inline">/</span>
            <p className="text-[13px] text-gray-400 truncate hidden sm:block">{info.desc}</p>
          </>
        )}
      </div>
    </header>
  )
}
