import { useState, useEffect } from 'react'
import { Settings2, Mail, Plug, RefreshCw, Users, Settings as SettingsIcon } from 'lucide-react'
import UsersAdmin from '../components/UsersAdmin'
import PageHeader from '../components/ui/PageHeader'
import { pushToast } from '../utils/toastBus'
import { useCustomFieldsTab, CustomFieldsBody, CustomFieldsSidePanel } from '../components/settings/CustomFieldsTab'
import AutomationTab, { useAutomationSettings } from '../components/settings/AutomationTab'
import EmailTab from '../components/settings/EmailTab'
import DangerZone from '../components/settings/DangerZone'
import GeneralTab from '../components/settings/GeneralTab'
import IntegrationsTab from '../components/settings/IntegrationsTab'

export default function Settings() {
  // Honor a `#section` hash so deep links land on the right tab (e.g. the
  // Recurring page's "auto-generate is off" banner → /settings#automation, and
  // the Google-view empty state → /settings#integrations). Falls back to
  // General — where company identity, brand color, terms, and the danger zone
  // live — which is the natural first stop otherwise.
  const sectionFromHash = () => {
    const h = (window.location.hash || '').replace(/^#/, '').split('?')[0]
    return ['general', 'integrations', 'automation', 'email', 'fields', 'users'].includes(h) ? h : 'general'
  }
  const [section, setSection] = useState(sectionFromHash) // 'fields' | 'email' | 'general' | 'integrations' | 'automation' | 'users'
  // Keep the tab in step if the hash changes while Settings is already open.
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  // Users management is admin-only (the backend enforces it; this hides the tab).
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
    catch { return false }
  })()
  const toast = (message, type = 'success') => pushToast(message, type)

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
        <div className="border-b border-hairline bg-panel">
          <PageHeader
            title="Settings"
            subtitle="Manage your account and integrations"
            icon={SettingsIcon}
            iconColor="slate"
          >
            <div className="flex gap-2 overflow-x-auto scrollbar-thin -mx-1 px-1">
              <button onClick={() => setSection('general')}
                className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'general' ? 'bg-indigo-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                <Settings2 className="w-3.5 h-3.5" /> General
              </button>
              <button onClick={() => setSection('integrations')}
                className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'integrations' ? 'bg-indigo-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                <Plug className="w-3.5 h-3.5" /> Integrations
              </button>
              <button onClick={() => setSection('automation')}
                className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'automation' ? 'bg-indigo-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                <RefreshCw className="w-3.5 h-3.5" /> Automation
              </button>
              <button onClick={() => setSection('email')}
                className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'email' ? 'bg-indigo-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                <Mail className="w-3.5 h-3.5" /> Email
              </button>
              <button onClick={() => setSection('fields')}
                className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'fields' ? 'bg-indigo-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                <Settings2 className="w-3.5 h-3.5" /> Custom Fields
              </button>
              {isAdmin && (
                <button onClick={() => setSection('users')}
                  className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${section === 'users' ? 'bg-indigo-600 text-white' : 'bg-panel text-ink-2 border border-hairline hover:border-hairline-2'}`}>
                  <Users className="w-3.5 h-3.5" /> Users
                </button>
              )}
            </div>
          </PageHeader>
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

    </div>
  )
}
