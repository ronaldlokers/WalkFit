/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // relative base so the built app works under GitHub Pages' /<repo>/ subpath
  base: './',
  plugins: [vue()],
  server: { host: true },
  test: {
    // env is node by default; component tests opt into jsdom via a file docblock
    setupFiles: ['./test/setup.js'],
  },
})
