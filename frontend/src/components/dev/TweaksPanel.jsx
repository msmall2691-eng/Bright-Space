import { useState, useEffect } from 'react'
import { Palette, Wind, Maximize2 } from 'lucide-react'

/**
 * Dev-only Tweaks Panel for theme/density/sidebar toggling.
 * Hidden in production. Lets designers/PMs try variants without code changes.
 */
export default function TweaksPanel() {
  const [theme, setTheme] = useState('paper')
  const [density, setDensity] = useState('default')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    // Load saved preferences
    const saved = localStorage.getItem('tweaks-panel-prefs')
    if (saved) {
      const prefs = JSON.parse(saved)
      setTheme(prefs.theme)
      setDensity(prefs.density)
      setSidebarCollapsed(prefs.sidebarCollapsed)
      applyTheme(prefs.theme, prefs.density, prefs.sidebarCollapsed)
    }
  }, [])

  const applyTheme = (t, d, sc) => {
    const body = document.documentElement
    body.classList.remove('theme-console', 'mode-clean')
    if (t === 'console') body.classList.add('theme-console')
    if (d === 'clean') body.classList.add('mode-clean')
    if (sc) {
      body.setAttribute('data-sidebar-collapsed', 'true')
    } else {
      body.removeAttribute('data-sidebar-collapsed')
    }

    // Save preferences
    localStorage.setItem('tweaks-panel-prefs', JSON.stringify({
      theme: t,
      density: d,
      sidebarCollapsed: sc
    }))
  }

  const handleThemeChange = (t) => {
    setTheme(t)
    applyTheme(t, density, sidebarCollapsed)
  }

  const handleDensityChange = (d) => {
    setDensity(d)
    applyTheme(theme, d, sidebarCollapsed)
  }

  const handleSidebarToggle = () => {
    const newCollapsed = !sidebarCollapsed
    setSidebarCollapsed(newCollapsed)
    applyTheme(theme, density, newCollapsed)
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 bg-white border border-zinc-200 rounded-xl shadow-lg p-4 w-72 text-sm">
      <div className="text-xs font-semibold text-zinc-600 uppercase tracking-wider mb-4">Dev Tweaks</div>

      {/* Theme */}
      <div className="mb-4">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-700 mb-2">
          <Palette className="w-3.5 h-3.5" />
          Theme
        </div>
        <div className="flex gap-2">
          {[
            { label: 'Paper', value: 'paper' },
            { label: 'Console', value: 'console' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => handleThemeChange(opt.value)}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                theme === opt.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Density */}
      <div className="mb-4">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-700 mb-2">
          <Wind className="w-3.5 h-3.5" />
          Density
        </div>
        <div className="flex gap-2">
          {[
            { label: 'Default', value: 'default' },
            { label: 'Clean', value: 'clean' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => handleDensityChange(opt.value)}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                density === opt.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Sidebar */}
      <div>
        <button
          onClick={handleSidebarToggle}
          className={`w-full flex items-center justify-between px-2 py-2 rounded text-xs font-medium transition-colors ${
            sidebarCollapsed
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <Maximize2 className="w-3.5 h-3.5" />
            Collapse Sidebar
          </div>
          <input
            type="checkbox"
            checked={sidebarCollapsed}
            onChange={() => {}}
            className="w-4 h-4"
          />
        </button>
      </div>
    </div>
  )
}
