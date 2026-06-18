import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    // Vite 8 builds with Rolldown and no longer bundles esbuild; 'oxc' is the
    // built-in minifier (the old 'esbuild' value now fails to resolve).
    minify: 'oxc',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split vendor libraries into separate chunks
          if (id.includes('node_modules/lucide-react')) return 'vendor-lucide'
          if (id.includes('node_modules/react-router-dom')) return 'vendor-router'
          if (id.includes('node_modules/react-dom')) return 'vendor-react'
          if (id.includes('node_modules')) return 'vendor-other'

          // App code (pages, components, hooks, utils) is left to Vite's
          // automatic splitting. Because every page is lazy-loaded via
          // React.lazy, Vite already emits one on-demand chunk per route,
          // folds single-use components into the route that needs them, and
          // hoists components shared by several routes into their own
          // auto-generated shared chunk (loaded only when one of those routes
          // is visited) — no duplication and a minimal eager payload. Manual
          // page/component grouping previously fought this, pulling every
          // component into the eager bundle and over-stuffing single routes.
        },
      },
    },
  },
})
