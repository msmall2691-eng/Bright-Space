import { useState, useCallback } from 'react'
import { Settings2, Mail, Plug, RefreshCw, Users } from 'lucide-react'
import UsersAdmin from '../components/UsersAdmin'
import Toast from '../components/settings/Toast'
import { useCustomFieldsTab, CustomFieldsBody, CustomFieldsSidePanel } from '../components/settings/CustomFieldsTab'
import AutomationTab, { useAutomationSettings } from '../components/settings/AutomationTab'
import EmailTab from '../components/settings/EmailTab'
import DangerZone from '../components/settings/DangerZone'
import GeneralTab from '../components/settings/GeneralTab'
import IntegrationsTab from '../components/settings/IntegrationsTab'

export default function Settings() {
  // Land on General — that's where company identity, brand color, terms, and
  // the danger zone live, which is the natural first stop. Previously landed
  // on Custom Fields, which is a niche power-user screen.
  const [section, setSection] = useState('general') // 'fields' | 'email' | 'general' | 'integrations' | 'automation' | 'users'
  // Users management is admin-only (the backend enforces it; this hides the tab).
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
    catch { return false }
  })()
  const [toasts, setToasts] = useState([])

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000)
  }, [])

  const customFields = useCustomFieldsTab({ toast })
  const automation = useAutomationSettings({
    toast,
    active: section === 'integrations' || section === 'automation' || section === 'general',
  })
  const { automationSettings, setAutomationSettings } = automation

  return (
    <div className="flex h-full">

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Header */}
        <div className="px-4 sm:px-8 py-6 border-b border-hairline bg-panel">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold text-ink">Settings</h1>
              <p className="text-sm text-ink-3 mt-1">Manage your account and integrations</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSection('general')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'general' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Settings2 className="w-3.5 h-3.5" /> General
            </button>
            <button onClick={() => setSection('integrations')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'integrations' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Plug className="w-3.5 h-3.5" /> Integrations
            </button>
            <button onClick={() => setSection('automation')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'automation' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <RefreshCw className="w-3.5 h-3.5" /> Automation
            </button>
            <button onClick={() => setSection('email')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'email' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Mail className="w-3.5 h-3.5" /> Email
            </button>
            <button onClick={() => setSection('fields')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'fields' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
              <Settings2 className="w-3.5 h-3.5" /> Custom Fields
            </button>
            {isAdmin && (
              <button onClick={() => setSection('users')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'users' ? 'bg-blue-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                <Users className="w-3.5 h-3.5" /> Users
              </button>
            )}
          </div>
        </div>

        {/* === USERS SECTION (admin only) === */}
        {section === 'users' && isAdmin && (
          <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
            <div className="max-w-2xl pt-6">
              <UsersAdmin />
            </div>
          </div>
        )}

        {/* === GENERAL SETTINGS SECTION === */}
        {section === 'general' && (
          <GeneralTab
            toast={toast}
            active={section === 'general'}
            dangerZone={<DangerZone toast={toast} automationSettings={automationSettings} setAutomationSettings={setAutomationSettings} />}
          />
        )}

        {/* === INTEGRATIONS SECTION === */}
        {section === 'integrations' && (
          <IntegrationsTab
            toast={toast}
            active={section === 'integrations'}
          />
        )}

        {/* === AUTOMATION SECTION === */}
        {section === 'automation' && <AutomationTab state={automation} toast={toast} active={section === 'automation'} />}

        {/* === EMAIL SETTINGS SECTION === */}
        {section === 'email' && <EmailTab toast={toast} active={section === 'email'} />}

        {/* === CUSTOM FIELDS SECTION === */}
        {section === 'fields' && <CustomFieldsBody state={customFields} />}
      </div>

      {/* Side panel */}
      {section === 'fields' && <CustomFieldsSidePanel state={customFields} />}

      <Toast toasts={toasts} />

    </div>
  )
}
