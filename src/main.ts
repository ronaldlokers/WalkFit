import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { isDemo, seedDemoData } from './demo'

// Demo mode (#169): seed the canonical fixture before the app reads localStorage,
// so screenshots/docs show every feature populated. No-op unless explicitly opted in.
if (isDemo()) seedDemoData()

createApp(App).mount('#app')
