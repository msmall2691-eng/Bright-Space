/**
 * BrightBase Design Tokens
 * Core color, spacing, and typography definitions
 * Used across components and pages
 */

export const colors = {
  // Primary Brand Colors
  primary: {
    50: '#f0f9ff',
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

  // Accent (Violet)
  accent: {
    50: '#faf5ff',
    100: '#f3e8ff',
    200: '#e9d5ff',
    300: '#d8b4fe',
    400: '#c084fc',
    500: '#a855f7',
    600: '#9333ea',
    700: '#7e22ce',
    800: '#6b21a8',
    900: '#581c87',
  },

  // Semantic Colors
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#3b82f6',

  // Neutrals
  neutral: {
    50: '#f9fafb',
    100: '#f3f4f6',
    200: '#e5e7eb',
    300: '#d1d5db',
    400: '#9ca3af',
    500: '#6b7280',
    600: '#4b5563',
    700: '#374151',
    800: '#1f2937',
    900: '#111827',
  },

  // White & Black
  white: '#ffffff',
  black: '#000000',
};

export const gradients = {
  // Hero/Primary Gradient
  hero: 'linear-gradient(135deg, #0ea5e9 0%, #8b5cf6 100%)',

  // Glass Effect Backgrounds
  glassLight: 'linear-gradient(135deg, rgba(255,255,255,0.8), rgba(255,255,255,0.4))',
  glassPrimary: 'linear-gradient(135deg, rgba(14,165,233,0.15), rgba(14,165,233,0.05))',
  glassAccent: 'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(59,130,246,0.05))',

  // Subtle Background Gradients
  subtleBlue: 'linear-gradient(135deg, rgba(14,165,233,0.05) 0%, rgba(139,92,246,0.05) 100%)',
};

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
  '3xl': '32px',
  '4xl': '40px',
  '5xl': '48px',
};

export const typography = {
  // Display (32px, bold)
  display: {
    fontSize: '32px',
    fontWeight: '700',
    lineHeight: '1.2',
    letterSpacing: '-0.01em',
  },

  // Heading 1 (24px, semibold)
  heading1: {
    fontSize: '24px',
    fontWeight: '600',
    lineHeight: '1.3',
    letterSpacing: '-0.005em',
  },

  // Heading 2 (18px, semibold)
  heading2: {
    fontSize: '18px',
    fontWeight: '600',
    lineHeight: '1.4',
  },

  // Body Large (16px, normal)
  bodyLarge: {
    fontSize: '16px',
    fontWeight: '400',
    lineHeight: '1.5',
  },

  // Body (14px, normal)
  body: {
    fontSize: '14px',
    fontWeight: '400',
    lineHeight: '1.5',
  },

  // Body Small (13px, normal)
  bodySmall: {
    fontSize: '13px',
    fontWeight: '400',
    lineHeight: '1.5',
  },

  // Label (12px, semibold)
  label: {
    fontSize: '12px',
    fontWeight: '600',
    lineHeight: '1.4',
    letterSpacing: '0.02em',
  },

  // Caption (11px, medium)
  caption: {
    fontSize: '11px',
    fontWeight: '500',
    lineHeight: '1.4',
    letterSpacing: '0.01em',
  },
};

export const shadows = {
  xs: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  sm: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
  md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
  lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
  xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  glass: '0 8px 32px rgba(0, 0, 0, 0.1)',
  glassLg: '0 20px 40px rgba(0, 0, 0, 0.15)',
};

export const borderRadius = {
  xs: '4px',
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  '2xl': '20px',
  full: '9999px',
};

export const transitions = {
  fast: 'transition-all duration-150',
  base: 'transition-all duration-200',
  slow: 'transition-all duration-300',
  colorFast: 'transition-colors duration-150',
  colorBase: 'transition-colors duration-200',
  transformBase: 'transition-transform duration-300',
};

export const glassEffect = {
  light: 'bg-white/70 backdrop-blur-lg border border-white/20',
  lightLg: 'bg-white/80 backdrop-blur-xl border border-white/20',
  primary: 'bg-blue-50/60 backdrop-blur-lg border border-blue-200/30',
  accent: 'bg-violet-50/60 backdrop-blur-lg border border-violet-200/30',
};

export default {
  colors,
  gradients,
  spacing,
  typography,
  shadows,
  borderRadius,
  transitions,
  glassEffect,
};
