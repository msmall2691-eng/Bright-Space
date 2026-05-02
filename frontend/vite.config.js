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
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split vendor libraries into separate chunks
          if (id.includes('node_modules/lucide-react')) return 'vendor-lucide'
          if (id.includes('node_modules/react-router-dom')) return 'vendor-router'
          if (id.includes('node_modules/react-dom')) return 'vendor-react'
          if (id.includes('node_modules')) return 'vendor-other'

          // Split feature pages into lazy-loaded chunks
          if (id.includes('/pages/Schedule') || id.includes('/pages/Scheduling')) {
            return 'pages-schedule'
          }
          if (id.includes('/pages/Invoicing') || id.includes('/pages/Quoting')) {
            return 'pages-finance'
          }
          if (id.includes('/pages/Settings') || id.includes('/pages/Workspace')) {
            return 'pages-admin'
          }
          if (id.includes('/pages/Clients') || id.includes('/pages/ClientProfile')) {
            return 'pages-clients'
          }
          if (id.includes('/components')) return 'components-shared'
        },
      },
    },
  },
})
