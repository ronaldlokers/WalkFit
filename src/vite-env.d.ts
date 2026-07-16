/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Build-time integration config (see .env.example) — a feature's vars unset = hidden.
interface ImportMetaEnv {
  readonly VITE_STRAVA_CLIENT_ID?: string
  readonly VITE_STRAVA_PROXY_URL?: string
  readonly VITE_WITHINGS_CLIENT_ID?: string
  readonly VITE_WITHINGS_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Safari's prefixed AudioContext, used as a fallback by App.vue's beep().
interface Window {
  webkitAudioContext?: typeof AudioContext
}
