import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // relative base so the built app works under GitHub Pages' /<repo>/ subpath
  base: './',
  plugins: [
    vue(),
    // Offline start for the installed PWA (#150): the app is 100% localStorage,
    // static-site-only (see CLAUDE.md) — the only thing that ever needed a network
    // was the initial page load itself. Precaches every built asset, including the
    // lazy three.js/Scenic3D chunk, so the 3D view works offline too, not just a 2D
    // fallback. manifest: false — public/manifest.webmanifest is hand-authored and
    // already linked from index.html; this plugin only owns the service worker.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // the main JS chunk is already <250 kB (CI-guarded); this just raises the
        // precache's own inline-size ceiling so workbox doesn't warn on the 3D chunk
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  server: { host: true },
  test: {
    // Vitest owns unit/component tests in src/; Playwright owns e2e/*.spec.js.
    include: ['src/**/*.test.ts'],
    // env is node by default; component tests opt into jsdom via a file docblock
    setupFiles: ['./test/setup.js'],
  },
})
