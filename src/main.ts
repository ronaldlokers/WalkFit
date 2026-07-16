import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { isDemo, seedDemoData } from './demo'
import { registerSW } from 'virtual:pwa-register'

// Demo mode (#169): seed the canonical fixture before the app reads localStorage,
// so screenshots/docs show every feature populated. No-op unless explicitly opted in.
if (isDemo()) seedDemoData()

createApp(App).mount('#app')

// Offline start for the installed PWA (#150) — silent update, no in-app prompt UI to
// wire up for it. import.meta.env.PROD guards dev (vite-plugin-pwa's dev SW would
// otherwise fight Vite's own HMR).
if (import.meta.env.PROD) registerSW({ immediate: true })
