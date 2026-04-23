/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
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
        glass: '0 8px 32px rgba(0, 0, 0, 0.1)',
        'glass-lg': '0 20px 40px rgba(0, 0, 0, 0.15)',
        'glass-sm': '0 4px 16px rgba(0, 0, 0, 0.08)',
      },
      backdropBlur: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '20px',
      },
      backgroundImage: {
        'gradient-hero': 'linear-gradient(135deg, #0ea5e9 0%, #8b5cf6 100%)',
        'gradient-glass': 'linear-gradient(135deg, rgba(255,255,255,0.8), rgba(255,255,255,0.4))',
        'gradient-subtle': 'linear-gradient(135deg, rgba(14,165,233,0.05) 0%, rgba(139,92,246,0.05) 100%)',
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
        xs: '4px',
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
    },
  },
  plugins: [],
}
