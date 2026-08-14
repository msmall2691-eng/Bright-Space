/** @type {import('tailwindcss').Config} */
export default {
  // Dark mode is a manual toggle (theme.js adds body.theme-console), not the
  // OS-preference `media` default — selector strategy targets that same class
  // so `dark:` classes activate exactly when the app's own dark theme is on.
  darkMode: ['selector', '.theme-console'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Design tokens from index.css — use these instead of zinc/blue literals
        // so the app respects the paper/dark theme toggle.
        // App frame behind the sidebar + content sheet (Twenty-style gray
        // ground). Falls back to --bg-2 under any theme that predates it.
        frame:     'var(--frame, var(--bg-2))',
        bg:        'var(--bg)',
        'bg-2':    'var(--bg-2)',
        'bg-3':    'var(--bg-3)',
        panel:     'var(--panel)',
        ink:       'var(--ink)',
        'ink-2':   'var(--ink-2)',
        'ink-3':   'var(--ink-3)',
        hairline:  'var(--hairline)',
        'hairline-2': 'var(--hairline-2)',
        accent:    'var(--accent)',
        'accent-ink': 'var(--accent-ink)',
        // The whole app standardized its primary accent on `indigo-*`. We remap
        // that scale onto CSS variables so a single accent-picker choice
        // (body.accent-*) recolors every button / active-nav / link at once.
        // Channels are space-separated RGB so Tailwind's /opacity modifiers
        // (e.g. bg-indigo-500/15) keep working.
        indigo: {
          50:  'rgb(var(--accent-50) / <alpha-value>)',
          100: 'rgb(var(--accent-100) / <alpha-value>)',
          200: 'rgb(var(--accent-200) / <alpha-value>)',
          300: 'rgb(var(--accent-300) / <alpha-value>)',
          400: 'rgb(var(--accent-400) / <alpha-value>)',
          500: 'rgb(var(--accent-500) / <alpha-value>)',
          600: 'rgb(var(--accent-600) / <alpha-value>)',
          700: 'rgb(var(--accent-700) / <alpha-value>)',
          800: 'rgb(var(--accent-800) / <alpha-value>)',
          900: 'rgb(var(--accent-900) / <alpha-value>)',
          950: 'rgb(var(--accent-950) / <alpha-value>)',
        },
        // Primary brand colors
        brand: {
          50:  '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c3d66',
        },
      },
      boxShadow: {
        // Clean & airy: soft, wide, low-opacity ambient shadows so surfaces
        // gently float on the calm canvas instead of hard-edged boxes. Tuned
        // with a slate tint to match the cool neutral palette.
        glass: '0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -16px rgba(15,23,42,0.12)',
        'glass-lg': '0 1px 2px rgba(15,23,42,0.04), 0 18px 40px -20px rgba(15,23,42,0.18)',
        'glass-sm': '0 1px 2px rgba(15,23,42,0.04)',
      },
      backdropBlur: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '20px',
      },
      backgroundImage: {
        'gradient-hero': 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
        'gradient-glass': 'linear-gradient(135deg, rgba(255,255,255,0.8), rgba(255,255,255,0.4))',
        'gradient-subtle': 'linear-gradient(135deg, rgba(79,70,229,0.06) 0%, rgba(124,58,237,0.05) 100%)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      fontSize: {
        xs: ['11px', { lineHeight: '1.4', letterSpacing: '0.01em' }],
        sm: ['12px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
        base: ['14px', { lineHeight: '1.5' }],
        lg: ['16px', { lineHeight: '1.5' }],
        xl: ['18px', { lineHeight: '1.4' }],
        '2xl': ['24px', { lineHeight: '1.3', letterSpacing: '-0.005em' }],
        '3xl': ['32px', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
      },
      borderRadius: {
        // Clean & airy: a touch rounder than the old crisp look so cards read
        // as soft, modern surfaces. Small controls stay tight; cards breathe.
        xs: '4px',
        sm: '6px',
        md: '8px',
        lg: '10px',
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px',
      },
    },
  },
  plugins: [],
}
