import { useState, useEffect } from 'react'
import { Settings2, Mail, Plug, Users, Settings as SettingsIcon } from 'lucide-react'
import UsersAdmin from '../components/UsersAdmin'
import SubApplications from '../components/SubApplications'
import PageHeader from '../components/ui/PageHeader'
import SubNav from '../components/ui/SubNav'
import { pushToast } from '../utils/toastBus'
import { useCustomFieldsTab, CustomFieldsBody, CustomFieldsSidePanel } from '../components/settings/CustomFieldsTab'
import { useAutomationSettings } from '../components/settings/AutomationTab'
import EmailTab from '../components/settings/EmailTab'
import DangerZone from '../components/settings/DangerZone'
import GeneralTab from '../components/settings/GeneralTab'
import IntegrationsTab from '../components/settings/IntegrationsTab'

export default function Settings() {
  // Honor a `#section` hash so deep links land on the right tab (e.g. the
  // Google-view empty state → /settings#integrations). Falls back to
  // General — where company identity, brand color, terms, auto-sync/
  // automation, and the danger zone all live — which is the natural first
  // stop otherwise. `automation` is kept as an alias to `general` below so
  // old bookmarks/links (e.g. Recurring's old banner) still land somewhere
  // sensible now that Automation isn't its own tab (Aug 2026 nav
  // simplification — it overlapped with General's "how this workspace
  // behaves" territory).
  // Users management is admin-only (the backend enforces it; this hides the
  // tab). Custom Fields (/api/fields — see modules/fields/router.py) and
  // Email (GET/POST /api/settings/email — see modules/settings/router.py)
  // are ALSO admin-only on the backend; a manager/viewer landing on either
  // gets a silently-swallowed 403 and a misleading empty/disconnected state,
  // so those tabs are gated the same way.
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('brightbase_user') || '{}').role === 'admin' }
    catch { return false }
  })()
  const sectionFromHash = () => {
    const h = (window.location.hash || '').replace(/^#/, '').split('?')[0]
    if (h === 'automation') return 'general'
    const allowed = ['general', 'integrations']
      .concat(isAdmin ? ['email', 'fields', 'users'] : [])
    return allowed.includes(h) ? h : 'general'
  }
  const [section, setSection] = useState(sectionFromHash) // 'fields' | 'email' | 'general' | 'integrations' | 'users'
  // Keep the tab in step if the hash changes while Settings is already open.
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const toast = (message, type = 'success') => pushToast(message, type)

  const customFields = useCustomFieldsTab({ toast, enabled: isAdmin })
  // Automation now renders inline within General (no standalone tab), so its
  // data loads whenever Integrations or General is active — Integrations
  // still reads it for the iCal Turnover card.
  const automation = useAutomationSettings({
    toast,
    active: section === 'integrations' || section === 'general',
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
            {/* Page-level tabs (Settings / Crew / Payroll) sit above the
                section switcher below. Both rows speak SubNav's underline
                vocabulary — the sections are just smaller. (The old solid
                indigo pills were the last filled tab bar in the office.) */}
            <SubNav className="mb-1.5" />

            <div className="flex items-center gap-4 overflow-x-auto scrollbar-thin">
              {[
                ['general', 'General', Settings2, true],
                ['integrations', 'Integrations', Plug, true],
                ['email', 'Email', Mail, isAdmin],
                ['fields', 'Custom Fields', Settings2, isAdmin],
                ['users', 'Users', Users, isAdmin],
              ].filter(([, , , show]) => show).map(([key, label, Icon]) => (
                <button key={key} onClick={() => setSection(key)}
                  aria-current={section === key ? 'true' : undefined}
                  className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 border-b-2 px-0.5 py-1.5 text-xs font-medium transition-colors ${
                    section === key
                      ? 'border-ink text-ink'
                      : 'border-transparent text-ink-3 hover:text-ink-2'}`}>
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>
          </PageHeader>
        </div>

        {/* === USERS SECTION (admin only) === */}
        {section === 'users' && isAdmin && (
          <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
            <div className="max-w-2xl pt-6">
              <UsersAdmin />
              {/* Draws nothing until somebody has actually applied — a
                  permanent empty panel here is one people learn to scroll
                  past, and this is where a real applicant would sit. */}
              <SubApplications />
            </div>
          </div>
        )}

        {/* === GENERAL SETTINGS SECTION === */}
        {/* Automation (auto-sync intervals, recurring auto-generate, customer
            messaging) renders inline here too — folded in from its old
            standalone tab (Aug 2026 nav simplification: it's the same "how
            this workspace behaves" territory General already anchors). */}
        {section === 'general' && (
          <GeneralTab
            toast={toast}
            active={section === 'general'}
            automation={automation}
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

        {/* === EMAIL SETTINGS SECTION (admin only) === */}
        {section === 'email' && isAdmin && <EmailTab toast={toast} active={section === 'email'} />}

        {/* === CUSTOM FIELDS SECTION (admin only) === */}
        {section === 'fields' && isAdmin && <CustomFieldsBody state={customFields} />}
      </div>

      {/* Side panel */}
      {section === 'fields' && isAdmin && <CustomFieldsSidePanel state={customFields} />}

    </div>
  )
}
