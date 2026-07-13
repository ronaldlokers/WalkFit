/// <reference types="vite/client" />

// Build-time Strava config (see .env.example) — both unset disables the feature.
interface ImportMetaEnv {
  readonly VITE_STRAVA_CLIENT_ID?: string
  readonly VITE_STRAVA_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Safari's prefixed AudioContext, used as a fallback by App.vue's beep().
interface Window {
  webkitAudioContext?: typeof AudioContext
}
