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
    // Optimize bundle size and code splitting
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split vendor libraries
          'vendor-lucide': ['lucide-react'],
          'vendor-router': ['react-router-dom'],
          // Split pages into chunks
          'pages-admin': ['./src/pages/Settings', './src/pages/Workspace'],
          'pages-scheduling': ['./src/pages/Scheduling', './src/pages/Schedule'],
          'pages-finance': ['./src/pages/Invoicing', './src/pages/Quoting'],
        },
        // Compress and optimize
        compact: true,
      },
    },
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
      },
    },
  },
})
