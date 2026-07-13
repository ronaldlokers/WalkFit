import { reactive } from 'vue'
import type { Session } from './statistics'

// Strava OAuth2 + activity upload. The client_id below is public (it's part of the
// authorize URL every user's browser sends), but client_secret is not — token exchange
// and refresh go through a small proxy worker (see oauth-proxy/) that holds it.
// Both env vars are build-time (Vite): unset = feature quietly disabled.
const CLIENT_ID = import.meta.env.VITE_STRAVA_CLIENT_ID || ''
const PROXY_URL = import.meta.env.VITE_STRAVA_PROXY_URL || ''
const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize'
const ACTIVITIES_URL = 'https://www.strava.com/api/v3/activities'
const SCOPE = 'activity:write'
const KEY = 'walkfit.strava'
const STATE_KEY = 'walkfit.strava.state' // CSRF check across the redirect round-trip

interface StravaTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // unix seconds
  athleteName: string
}

export interface StravaState {
  supported: boolean
  connected: boolean
  athleteName: string
  connecting: boolean
  uploading: boolean
  error: string
}

function loadTokens(): StravaTokens | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    return null
  }
}
function saveTokens(t: StravaTokens) {
  localStorage.setItem(KEY, JSON.stringify(t))
}

export function useStrava() {
  const state = reactive<StravaState>({
    supported: !!(CLIENT_ID && PROXY_URL),
    connected: !!loadTokens(),
    athleteName: loadTokens()?.athleteName || '',
    connecting: false,
    uploading: false,
    error: '',
  })

  function connect() {
    if (!state.supported) return
    const nonce = crypto.randomUUID()
    sessionStorage.setItem(STATE_KEY, nonce)
    const redirectUri = window.location.origin + window.location.pathname
    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('client_id', CLIENT_ID)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('approval_prompt', 'auto')
    url.searchParams.set('scope', SCOPE)
    url.searchParams.set('state', nonce)
    window.location.href = url.toString()
  }

  function disconnect() {
    localStorage.removeItem(KEY)
    state.connected = false
    state.athleteName = ''
  }

  // Call once on app load: picks up ?code=&state= left by the Strava redirect,
  // exchanges it via the proxy, and strips the query string back to a clean URL.
  // Returns true only when it consumed the callback: several OAuth flows (Strava, the
  // health providers) share this redirect URI, so each flow claims a callback only
  // when the returned `state` matches its OWN stored nonce and leaves the URL alone
  // otherwise. The nonce doubles as the CSRF check.
  async function handleRedirect(): Promise<boolean> {
    if (!state.supported) return false
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const returnedState = params.get('state')
    const error = params.get('error')
    if (!code && !error) return false

    const expected = sessionStorage.getItem(STATE_KEY)
    if (!expected || returnedState !== expected) return false // not our callback

    sessionStorage.removeItem(STATE_KEY)
    history.replaceState(null, '', window.location.pathname) // drop ?code&state from the URL

    if (error) {
      state.error = error === 'access_denied' ? 'Strava authorization declined.' : error
      return true
    }

    state.connecting = true
    state.error = ''
    try {
      const res = await fetch(`${PROXY_URL}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Strava sign-in failed.')
      saveTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at, // unix seconds
        athleteName: [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(' '),
      })
      state.connected = true
      state.athleteName = loadTokens()!.athleteName
    } catch (e) {
      state.error = (e as Error).message || String(e)
    } finally {
      state.connecting = false
    }
    return true
  }

  async function freshAccessToken(): Promise<string> {
    const t = loadTokens()
    if (!t) throw new Error('Not connected to Strava.')
    if (t.expiresAt > Date.now() / 1000 + 60) return t.accessToken // still valid, 1 min margin

    const res = await fetch(`${PROXY_URL}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: t.refreshToken }),
    })
    const data = await res.json()
    if (!res.ok) {
      disconnect() // refresh token itself expired/revoked — needs a fresh connect
      throw new Error(data.message || 'Strava session expired — reconnect in Settings.')
    }
    const next = {
      ...t,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
    }
    saveTokens(next)
    return next.accessToken
  }

  // session: one entry from src/statistics.ts.
  async function uploadSession(session: Session, name: string) {
    state.uploading = true
    state.error = ''
    try {
      const accessToken = await freshAccessToken()
      const res = await fetch(ACTIVITIES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name,
          type: 'Walk',
          start_date_local: session.date,
          elapsed_time: session.duration,
          distance: session.distance,
          trainer: 1, // indoor/treadmill — no GPS track
          description: 'Logged with WalkFit.',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Upload failed.')
      return data
    } catch (e) {
      state.error = (e as Error).message || String(e)
      throw e
    } finally {
      state.uploading = false
    }
  }

  return { state, connect, disconnect, handleRedirect, uploadSession }
}
