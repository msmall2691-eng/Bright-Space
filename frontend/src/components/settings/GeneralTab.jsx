import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, Loader2, ArrowRight } from 'lucide-react'
import { del, get, post, upload } from '../../api'
import { applyTheme, getTheme, applyAccent, getAccent, ACCENTS } from '../../theme'
import NotificationsCard from './NotificationsCard'
import { inp, lbl } from './constants'

// Swatch color per accent (a representative 500/600) for the picker dots.
// amber/emerald are intentionally absent — see the ACCENTS comment in
// theme.js (they collide with the fixed status-dot colors).
const ACCENT_SWATCH = {
  indigo: '#4f46e5', violet: '#7c3aed', blue: '#2563eb',
  rose: '#e11d48', cyan: '#0891b2',
}
import ServiceScopesEditor from './ServiceScopesEditor'

/** General settings tab — Appearance + Company Info + Logo + Service
 *  Descriptions + Property Photos & Data + Regional Settings + main
 *  Save Changes button. Owns all its own state (there are no cross-tab
 *  reads on any of these fields). Parent supplies `toast` + a
 *  `dangerZone` render slot so the DangerZone component keeps living at
 *  the bottom of this tab without cross-importing here. */
export default function GeneralTab({ toast, active, dangerZone }) {
  const [themeChoice, setThemeChoice] = useState(getTheme())
  const [accentChoice, setAccentChoice] = useState(getAccent())
  const [showScout, setShowScout] = useState(() => localStorage.getItem('brightbase_hide_scout') !== '1')

  const [generalSettings, setGeneralSettings] = useState({
    company_name: 'Maine Cleaning Co.',
    company_email: '',
    company_phone: '',
    timezone: 'America/New_York',
    currency: 'USD',
    quote_terms: '',
    quote_policies: '',
    brand_color: '#1f2937',
    // Must be in the initial state: the /general loader only copies keys that
    // already exist here, so without this the saved logo wouldn't re-hydrate
    // on reload (preview would wrongly show "No logo").
    company_logo_url: '',
  })
  const [generalSaving, setGeneralSaving] = useState(false)

  // Property photos (Google Street View) + property-data (RentCast) integration.
  // Keys are write-only: the API never returns them, only whether each is set.
  const [propertyMedia, setPropertyMedia] = useState({
    property_photo_enabled: false, google_maps_key_set: false, google_maps_api_key: '',
    property_enrichment_enabled: false, rentcast_key_set: false, rentcast_api_key: '',
  })
  const [propertyMediaSaving, setPropertyMediaSaving] = useState(false)

  const [logoUploading, setLogoUploading] = useState(false)

  useEffect(() => {
    if (!active) return
    get('/api/settings/general')
      .then(d => setGeneralSettings(s => {
        const next = { ...s }
        for (const k of Object.keys(next)) if (d?.[k] != null) next[k] = d[k]
        return next
      }))
      .catch(() => {})
    get('/api/settings/property-media')
      .then(d => setPropertyMedia(m => ({ ...m, ...d })))
      .catch(() => {})
  }, [active])

  const saveGeneralSettings = async () => {
    setGeneralSaving(true)
    try {
      await post('/api/settings/general', generalSettings)
      toast('General settings saved')
    } catch {
      toast('Failed to save general settings', 'error')
    }
    setGeneralSaving(false)
  }

  const savePropertyMedia = async () => {
    setPropertyMediaSaving(true)
    try {
      const body = {
        property_photo_enabled: propertyMedia.property_photo_enabled,
        property_enrichment_enabled: propertyMedia.property_enrichment_enabled,
      }
      if (propertyMedia.google_maps_api_key?.trim()) body.google_maps_api_key = propertyMedia.google_maps_api_key.trim()
      if (propertyMedia.rentcast_api_key?.trim()) body.rentcast_api_key = propertyMedia.rentcast_api_key.trim()
      const d = await post('/api/settings/property-media', body)
      setPropertyMedia(m => ({ ...m, ...d, google_maps_api_key: '', rentcast_api_key: '' }))
      toast('Property photo & data settings saved')
    } catch (err) {
      toast(err.message || 'Failed to save', 'error')
    }
    setPropertyMediaSaving(false)
  }

  const uploadLogo = async (file) => {
    if (!file) return
    setLogoUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const data = await upload('/api/settings/general/logo', fd)
      setGeneralSettings(s => ({ ...s, company_logo_url: data.company_logo_url }))
      toast('Logo uploaded')
    } catch (err) {
      toast(err.message || 'Failed to upload logo', 'error')
    }
    setLogoUploading(false)
  }
  const removeLogo = async () => {
    setLogoUploading(true)
    try {
      await del('/api/settings/general/logo')
      setGeneralSettings(s => ({ ...s, company_logo_url: '' }))
      toast('Logo removed')
    } catch (err) {
      toast(err.message || 'Failed to remove logo', 'error')
    }
    setLogoUploading(false)
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8 bg-bg">
      <div className="max-w-2xl pt-6 space-y-5">
        <div>
          <h2 className="text-lg font-bold text-ink mb-4">Appearance</h2>
          <div className="bg-panel rounded-xl border border-hairline p-5">
            <label className={lbl}>Theme</label>
            <div className="flex gap-2 mt-1">
              {[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'neon', label: 'Neon' },
              ].map(opt => (
                <button key={opt.value} type="button"
                  onClick={() => setThemeChoice(applyTheme(opt.value))}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    themeChoice === opt.value
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-bg-2 text-ink-2 border-hairline hover:border-hairline-2'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-3 mt-2">Applies instantly and is remembered on this device.</p>

            {/* Accent color — recolors the whole app live. */}
            <div className="border-t border-hairline mt-5 pt-5">
              <label className={lbl}>Accent color</label>
              <div className="flex items-center gap-2.5 mt-2 flex-wrap">
                {ACCENTS.map(name => (
                  <button key={name} type="button"
                    onClick={() => setAccentChoice(applyAccent(name))}
                    title={name.charAt(0).toUpperCase() + name.slice(1)}
                    aria-label={`Accent ${name}`}
                    className={`w-8 h-8 rounded-full transition-transform hover:scale-110 focus:outline-none ${
                      accentChoice === name ? 'ring-2 ring-offset-2 ring-offset-panel ring-ink-3 scale-110' : ''
                    }`}
                    style={{ backgroundColor: ACCENT_SWATCH[name] }}>
                    {accentChoice === name && <CheckCircle className="w-4 h-4 text-white mx-auto" />}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-3 mt-2 capitalize">{accentChoice} — buttons, links, and highlights across the app.</p>
            </div>

            <div className="border-t border-hairline mt-5 pt-5">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>
                  <span className={lbl}>AI assistant</span>
                  <span className="block text-xs text-ink-3 mt-0.5">Show the floating AI assistant button on every page. Applies to this device only.</span>
                </span>
                <input type="checkbox" checked={showScout}
                  onChange={e => {
                    const show = e.target.checked
                    setShowScout(show)
                    if (show) localStorage.removeItem('brightbase_hide_scout')
                    else localStorage.setItem('brightbase_hide_scout', '1')
                    window.dispatchEvent(new Event('scout-visibility'))
                  }}
                  className="w-4 h-4 shrink-0 cursor-pointer" />
              </label>
            </div>
          </div>
        </div>

        <NotificationsCard toast={toast} />

        <div>
          <h2 className="text-lg font-bold text-ink mb-4">Company Information</h2>
          <div className="bg-panel rounded-xl border border-hairline p-5">
            <div>
              <label className={lbl}>Company Name</label>
              <input type="text" value={generalSettings.company_name}
                onChange={e => setGeneralSettings(s => ({ ...s, company_name: e.target.value }))}
                placeholder="Maine Cleaning Co."
                className={inp} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <div>
                <label className={lbl}>Company Email</label>
                <input type="email" value={generalSettings.company_email}
                  onChange={e => setGeneralSettings(s => ({ ...s, company_email: e.target.value }))}
                  placeholder="office@mainecleaningco.com"
                  className={inp} />
              </div>
              <div>
                <label className={lbl}>Company Phone</label>
                <input type="tel" value={generalSettings.company_phone}
                  onChange={e => setGeneralSettings(s => ({ ...s, company_phone: e.target.value }))}
                  placeholder="+1 (207) 555-0100"
                  className={inp} />
              </div>
            </div>
            <p className="text-[11px] text-ink-3 mt-2">Shown on the public quote page ("Questions?") and used across customer-facing email.</p>
            <div className="mt-4">
              <label className={lbl}>Brand Color</label>
              <div className="flex items-center gap-2">
                <input type="color" value={generalSettings.brand_color || '#1f2937'}
                  onChange={e => setGeneralSettings(s => ({ ...s, brand_color: e.target.value }))}
                  className="h-9 w-12 rounded border border-hairline cursor-pointer bg-panel" />
                <input type="text" value={generalSettings.brand_color || ''}
                  onChange={e => setGeneralSettings(s => ({ ...s, brand_color: e.target.value }))}
                  placeholder="#1f2937" className={inp + ' w-32'} />
              </div>
              <p className="text-[11px] text-ink-3 mt-1">Header color on the quote email, public quote page, and PDF.</p>
            </div>
            <div className="mt-4">
              <label className={lbl}>Company Logo</label>
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 shrink-0 rounded-lg border border-hairline bg-bg-2 flex items-center justify-center overflow-hidden">
                  {generalSettings.company_logo_url ? (
                    <img src={generalSettings.company_logo_url} alt="Logo" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-[10px] text-ink-3 text-center px-1">No logo</span>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <label className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors ${logoUploading ? 'bg-bg-2 text-ink-3 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}>
                      {logoUploading ? 'Uploading…' : 'Upload logo'}
                      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" className="hidden"
                        disabled={logoUploading}
                        onChange={e => { uploadLogo(e.target.files?.[0]); e.target.value = '' }} />
                    </label>
                    {generalSettings.company_logo_url && (
                      <button type="button" onClick={removeLogo} disabled={logoUploading}
                        className="px-3 py-2 rounded-lg text-sm font-medium bg-bg-2 text-ink-2 hover:bg-bg-2 disabled:opacity-50">Remove</button>
                    )}
                  </div>
                  <p className="text-[11px] text-ink-3">PNG, JPG, GIF, WEBP, or SVG up to 2&nbsp;MB. Shown on the quote email, public quote page, and PDF.</p>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <label className={lbl}>Quote Terms &amp; Conditions (optional)</label>
              <textarea rows={4} value={generalSettings.quote_terms}
                onChange={e => setGeneralSettings(s => ({ ...s, quote_terms: e.target.value }))}
                placeholder="Payment due upon completion. Cancellations require 24h notice. …"
                className={inp + ' resize-none'} />
              <p className="text-[11px] text-ink-3 mt-1">Appears at the bottom of every public quote page. Leave blank to hide.</p>
            </div>
            <div className="mt-4">
              <label className={lbl}>Service Policies (one per line)</label>
              <textarea rows={6} value={generalSettings.quote_policies}
                onChange={e => setGeneralSettings(s => ({ ...s, quote_policies: e.target.value }))}
                placeholder={"Please pick up personal items so we can clean thoroughly.\nPlease make sure the home is accessible on your scheduled day.\nCancellations need 24 hours' notice.\nSecure pets during the visit."}
                className={inp + ' resize-none'} />
              <p className="text-[11px] text-ink-3 mt-1">Shown as a friendly checklist on the quote email, PDF, and public page (heading “A Few Things Before We Clean”). One policy per line. Leave blank to use the built-in professional defaults.</p>
            </div>
          </div>
        </div>

        <ServiceScopesEditor toast={toast} />

        <div>
          <h2 className="text-lg font-bold text-ink mb-4">Property Photos &amp; Data</h2>
          <div className="bg-panel rounded-xl border border-hairline p-5 space-y-5">
            {/* Street View photo */}
            <div>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>
                  <span className={lbl + ' !mb-0'}>Front-of-house photo (Google Street View)</span>
                  <span className="block text-xs text-ink-3 mt-0.5">Shows a photo of the property address on the quote page, email, and PDF.</span>
                </span>
                <input type="checkbox" checked={!!propertyMedia.property_photo_enabled}
                  onChange={e => setPropertyMedia(m => ({ ...m, property_photo_enabled: e.target.checked }))}
                  className="w-4 h-4 shrink-0 cursor-pointer" />
              </label>
              <div className="mt-3">
                <label className={lbl}>Google Maps API key {propertyMedia.google_maps_key_set && <span className="text-emerald-600 normal-case font-medium">· saved</span>}</label>
                <input type="password" autoComplete="off" value={propertyMedia.google_maps_api_key}
                  onChange={e => setPropertyMedia(m => ({ ...m, google_maps_api_key: e.target.value }))}
                  placeholder={propertyMedia.google_maps_key_set ? '•••••••••• (leave blank to keep)' : 'Paste your Google Maps API key'}
                  className={inp} />
                <p className="text-[11px] text-ink-3 mt-1">Needs the Street View Static API enabled. A small per-image cost applies on Google's side.</p>
              </div>
            </div>
            <div className="border-t border-hairline" />
            {/* RentCast property data */}
            <div>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>
                  <span className={lbl + ' !mb-0'}>Auto-fill property specs (RentCast)</span>
                  <span className="block text-xs text-ink-3 mt-0.5">Looks up square footage, beds, and baths by address to pre-fill the quote.</span>
                </span>
                <input type="checkbox" checked={!!propertyMedia.property_enrichment_enabled}
                  onChange={e => setPropertyMedia(m => ({ ...m, property_enrichment_enabled: e.target.checked }))}
                  className="w-4 h-4 shrink-0 cursor-pointer" />
              </label>
              <div className="mt-3">
                <label className={lbl}>RentCast API key {propertyMedia.rentcast_key_set && <span className="text-emerald-600 normal-case font-medium">· saved</span>}</label>
                <input type="password" autoComplete="off" value={propertyMedia.rentcast_api_key}
                  onChange={e => setPropertyMedia(m => ({ ...m, rentcast_api_key: e.target.value }))}
                  placeholder={propertyMedia.rentcast_key_set ? '•••••••••• (leave blank to keep)' : 'Paste your RentCast API key'}
                  className={inp} />
                <p className="text-[11px] text-ink-3 mt-1">Free tier available at rentcast.io. Used only to fill missing specs — the customer's submitted details always win.</p>
              </div>
            </div>
            <button onClick={savePropertyMedia} disabled={propertyMediaSaving}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60">
              {propertyMediaSaving ? 'Saving…' : 'Save property settings'}
            </button>
          </div>
        </div>

        <div>
          <h2 className="text-lg font-bold text-ink mb-4">Data Quality</h2>
          <div className="bg-panel rounded-xl border border-hairline p-5">
            <p className="text-sm text-ink-2">
              Review and merge duplicate clients and properties, and catch other
              data-quality gaps intake dedup can't reach.
            </p>
            <Link to="/cleanup"
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 transition-all hover:gap-1.5 dark:text-indigo-400">
              Open Tidy Up<ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        <div>
          <h2 className="text-lg font-bold text-ink mb-4">Regional Settings</h2>
          <div className="bg-panel rounded-xl border border-hairline p-5 space-y-4">
            <div>
              <label className={lbl}>Timezone</label>
              <select value={generalSettings.timezone}
                onChange={e => setGeneralSettings(s => ({ ...s, timezone: e.target.value }))}
                className={inp}>
                <option value="America/New_York">Eastern Time (ET)</option>
                <option value="America/Chicago">Central Time (CT)</option>
                <option value="America/Denver">Mountain Time (MT)</option>
                <option value="America/Los_Angeles">Pacific Time (PT)</option>
                <option value="UTC">UTC</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Currency</label>
              {/* Bright Space is US-only today — every downstream (quotes,
                  invoices, Stripe integration) assumes USD. EUR/GBP/CAD were
                  visible in the dropdown but not actually supported anywhere,
                  which set operators up to save a value that would silently
                  do nothing. When we expand, re-add the options AND wire up
                  the formatters. */}
              <select value={generalSettings.currency}
                onChange={e => setGeneralSettings(s => ({ ...s, currency: e.target.value }))}
                className={inp}>
                <option value="USD">USD ($)</option>
              </select>
            </div>
          </div>
        </div>

        <button onClick={saveGeneralSettings} disabled={generalSaving}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors">
          {generalSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          Save Changes
        </button>

        {dangerZone}
      </div>
    </div>
  )
}
