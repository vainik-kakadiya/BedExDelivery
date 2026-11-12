import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Read VITE_* variables from the repo-root .env
  envDir: '../..',
  plugins: [
    react(),
    // DRP: the driver portal is an installable PWA. Offline queue (IndexedDB) arrives in weeks 4–5.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'BedEx Driver',
        short_name: 'BedEx',
        description: 'BedEx Delivery driver app',
        start_url: '/driver',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0F172A',
        background_color: '#F7F8FA',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
