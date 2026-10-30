import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// The build output goes straight into the API's wwwroot so that one process
// serves both the API and the UI: same origin, no CORS, no second deployment,
// no CDN bill.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // The POS must keep working when the network does not. Precaching the
      // shell means the till opens from disk; sales queue in IndexedDB and
      // flush when the connection returns.
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // Never serve a cached API response - stale balances would be worse
        // than none. Offline reads come from IndexedDB, which the app controls.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
      manifest: {
        name: 'Waterhouse POS',
        short_name: 'Waterhouse',
        description: 'Point of sale and back office for a mineral water plant',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
    }),
  ],

  build: {
    outDir: '../Waterhouse.Api/wwwroot',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        // Charts are only used by the dashboard. Splitting them keeps the POS
        // route - the one that must load fastest - free of that weight.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('recharts') || id.includes('d3-')) return 'charts';
            if (id.includes('react-dom') || id.includes('/react/') || id.includes('react-router')) return 'react';
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },

  server: {
    port: 5173,
    proxy: {
      // Dev only. In production the API and the UI are the same origin.
      '/api': { target: 'http://localhost:5080', changeOrigin: true },
      '/health': { target: 'http://localhost:5080', changeOrigin: true },
    },
  },
});
