import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // relative base so the built app works under GitHub Pages' /<repo>/ subpath
  base: './',
  plugins: [vue()],
  server: { host: true },
  test: {
    // Vitest owns unit/component tests in src/; Playwright owns e2e/*.spec.js.
    include: ['src/**/*.test.{js,ts}'],
    // env is node by default; component tests opt into jsdom via a file docblock
    setupFiles: ['./test/setup.js'],
  },
})
