import { useCallback, useEffect, useState } from 'react'
import { Mail, Plug, Shield, ChevronDown, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { get, post } from '../../api'
import { inp, lbl } from './constants'

/** Gmail / SMTP connection tab. Owns its own state, loads once when the
 *  section becomes active, and exposes save / test-connection actions.
 *  Renders the credentials block (with an advanced host/port disclosure),
 *  the sending-identity block, the auto-enrich toggle, and the test-result
 *  card. */
export default function EmailTab({ toast, active }) {
  const [emailConfig, setEmailConfig] = useState({
    smtp_user: '', smtp_pass: '', smtp_host: 'smtp.gmail.com', smtp_port: '587',
    imap_host: 'imap.gmail.com', imap_port: '993', from_email: '', from_name: '',
    email_auto_enrich: 'true',
  })
  const [emailSaving, setEmailSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [hasCredentials, setHasCredentials] = useState(false)
  const [credentialsSource, setCredentialsSource] = useState('none')

  const loadEmailSettings = useCallback(async () => {
    try {
      const data = await get('/api/settings/email')
      setHasCredentials(data.has_credentials || false)
      // credentials_source is display-only and NOT a saveable field on the
      // backend's EmailConfig model. Keep it in a sibling state instead of
      // folding it into emailConfig, otherwise saveEmailConfig posts it as a
      // phantom field — silently ignored today by pydantic, but a landmine
      // the day the model tightens (extra="forbid").
      setEmailConfig(prev => ({
        ...prev,
        smtp_user: data.smtp_user || '',
        smtp_pass: data.smtp_pass || '',
        smtp_host: data.smtp_host || 'smtp.gmail.com',
        smtp_port: data.smtp_port || '587',
        imap_host: data.imap_host || 'imap.gmail.com',
        imap_port: data.imap_port || '993',
        from_email: data.from_email || '',
        from_name: data.from_name || '',
        email_auto_enrich: data.email_auto_enrich || 'true',
      }))
      setCredentialsSource(data.credentials_source || 'none')
    } catch {}
  }, [])

  useEffect(() => { if (active) loadEmailSettings() }, [active, loadEmailSettings])

  const saveEmailConfig = async () => {
    setEmailSaving(true)
    try {
      await post('/api/settings/email', emailConfig)
      toast('Email settings saved')
      loadEmailSettings()
    } catch { toast('Failed to save', 'error') }
    setEmailSaving(false)
  }

  const testEmailConnection = async () => {
    setTesting(true); setTestResult(null)
    try {
      const res = await post('/api/settings/email/test')
      setTestResult(res)
    } catch (e) {
      setTestResult({ error: e.message || 'Test failed' })
    }
    setTesting(false)
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
      <div className="max-w-2xl pt-6">
        <div className="mb-5">
          <h2 className="text-lg font-bold text-ink">Gmail Connection</h2>
          <p className="text-sm text-ink-2 mt-1">
            Connect your Gmail to sync emails in Comms, auto-match senders to clients, and create leads from unknown contacts.
          </p>
        </div>

        {/* Status indicator */}
        <div className={`flex items-center gap-3 p-4 rounded-xl border mb-5 ${hasCredentials ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/25' : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/25'}`}>
          {hasCredentials
            ? <><CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" /><div><div className="text-sm font-medium text-emerald-800 dark:text-emerald-300">Credentials Found</div><div className="text-xs text-emerald-600">{credentialsSource === 'env' ? 'Using Railway environment variables (SMTP_USER / SMTP_PASS)' : 'Using saved database settings'}</div></div></>
            : <><AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" /><div><div className="text-sm font-medium text-amber-800 dark:text-amber-300">Not Connected</div><div className="text-xs text-amber-600">Enter your Gmail address and App Password, or set SMTP_USER and SMTP_PASS env vars on Railway</div></div></>
          }
        </div>

        {/* Credentials form */}
        <div className="bg-panel border border-hairline rounded-xl p-5 space-y-4 mb-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Shield className="w-4 h-4 text-blue-500" /> Credentials
          </div>

          <div>
            <label className={lbl}>Gmail Address</label>
            <input value={emailConfig.smtp_user} onChange={e => setEmailConfig(c => ({ ...c, smtp_user: e.target.value }))}
              placeholder="hello@maineclean.co"
              className={inp} />
          </div>

          <div>
            <label className={lbl}>App Password</label>
            <input type="password" value={emailConfig.smtp_pass} onChange={e => setEmailConfig(c => ({ ...c, smtp_pass: e.target.value }))}
              placeholder="16-character Google App Password"
              className={inp} />
            <p className="text-[11px] text-ink-3 mt-1">
              Generate at Google Account → Security → 2-Step Verification → App Passwords
            </p>
          </div>

          {/* IMAP/SMTP host+port default correctly for Gmail; tucked away
              so only non-Gmail setups need to open them. */}
          <details className="group">
            <summary className="flex items-center gap-1.5 cursor-pointer text-xs font-semibold text-ink-2 hover:text-ink select-none">
              <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
              Server details (advanced)
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>IMAP Host</label>
                  <input value={emailConfig.imap_host} onChange={e => setEmailConfig(c => ({ ...c, imap_host: e.target.value }))}
                    className={inp} />
                </div>
                <div>
                  <label className={lbl}>IMAP Port</label>
                  <input value={emailConfig.imap_port} onChange={e => setEmailConfig(c => ({ ...c, imap_port: e.target.value }))}
                    className={inp} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>SMTP Host</label>
                  <input value={emailConfig.smtp_host} onChange={e => setEmailConfig(c => ({ ...c, smtp_host: e.target.value }))}
                    className={inp} />
                </div>
                <div>
                  <label className={lbl}>SMTP Port</label>
                  <input value={emailConfig.smtp_port} onChange={e => setEmailConfig(c => ({ ...c, smtp_port: e.target.value }))}
                    className={inp} />
                </div>
              </div>
            </div>
          </details>
        </div>

        {/* Sending identity */}
        <div className="bg-panel border border-hairline rounded-xl p-5 space-y-4 mb-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Plug className="w-4 h-4 text-purple-500" /> Sending Identity
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>From Name</label>
              <input value={emailConfig.from_name} onChange={e => setEmailConfig(c => ({ ...c, from_name: e.target.value }))}
                placeholder="Maine Cleaning Co."
                className={inp} />
            </div>
            <div>
              <label className={lbl}>From Email</label>
              <input value={emailConfig.from_email} onChange={e => setEmailConfig(c => ({ ...c, from_email: e.target.value }))}
                placeholder="hello@maineclean.co"
                className={inp} />
            </div>
          </div>
        </div>

        {/* Auto-enrichment toggle */}
        <div className="bg-panel border border-hairline rounded-xl p-5 mb-5">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={emailConfig.email_auto_enrich === 'true'}
              onChange={e => setEmailConfig(c => ({ ...c, email_auto_enrich: e.target.checked ? 'true' : 'false' }))}
              className="w-4 h-4 rounded border-hairline text-indigo-600 focus:ring-0" />
            <div>
              <div className="text-sm font-medium text-ink">Auto-create contacts from emails</div>
              <div className="text-xs text-ink-3">When enabled, unknown email senders are automatically added as leads (like Twenty CRM)</div>
            </div>
          </label>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <button onClick={saveEmailConfig} disabled={emailSaving}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
            {emailSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Save Settings
          </button>
          <button onClick={testEmailConnection} disabled={testing}
            className="flex items-center gap-2 bg-panel border border-hairline hover:bg-bg text-ink-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors">
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
            Test Connection
          </button>
        </div>

        {/* Test results */}
        {testResult && (
          <div className="mt-4 bg-panel border border-hairline rounded-xl p-4 space-y-2">
            <div className="text-sm font-semibold text-ink">Connection Test Results</div>
            {testResult.error ? (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertTriangle className="w-4 h-4" /> {testResult.error}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm">
                  {testResult.imap === 'connected'
                    ? <><CheckCircle className="w-4 h-4 text-emerald-500" /><span className="text-emerald-700 dark:text-emerald-300">IMAP: Connected ({testResult.email_count} emails)</span></>
                    : <><AlertTriangle className="w-4 h-4 text-red-500" /><span className="text-red-600">IMAP: {testResult.imap}</span></>
                  }
                </div>
                <div className="flex items-center gap-2 text-sm">
                  {testResult.smtp === 'connected'
                    ? <><CheckCircle className="w-4 h-4 text-emerald-500" /><span className="text-emerald-700 dark:text-emerald-300">SMTP: Connected (outbound email ready)</span></>
                    : <><AlertTriangle className="w-4 h-4 text-red-500" /><span className="text-red-600">SMTP: {testResult.smtp}</span></>
                  }
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
