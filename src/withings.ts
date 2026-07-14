import { reactive } from 'vue'
import type { HealthProvider } from './health'
import { loadLastSync, clearLastSync, loadCursor, clearCursor } from './health'
import type { WeighInSync } from './health'
import type { WeightEntry } from './weight'

// Withings weight sync (HealthProvider — see health.ts). OAuth2 like strava.ts: the
// authorize redirect happens in the browser, but token exchange/refresh need the
// client_secret and go through the proxy worker's /withings routes (see oauth-proxy/).
// The measures API itself sends permissive CORS headers, so weigh-ins are fetched
// browser-direct with the bearer token.
//
// Withings API quirks handled here:
// - Every response is a {status, body} envelope; status != 0 is an error even on HTTP 200.
// - The refresh token ROTATES on every refresh — persist the new pair immediately.
// - The authorization-code exchange requires the redirect_uri again.
const CLIENT_ID = import.meta.env.VITE_WITHINGS_CLIENT_ID || ''
const PROXY_URL = import.meta.env.VITE_WITHINGS_PROXY_URL || ''
const AUTHORIZE_URL = 'https://account.withings.com/oauth2_user/authorize2'
const MEASURE_URL = 'https://wbsapi.withings.net/measure'
const SCOPE = 'user.metrics'
const KEY = 'walkfit.withings'
const STATE_KEY = 'walkfit.withings.state' // CSRF nonce; also marks callbacks as ours

const ID = 'withings'

interface WithingsTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // unix seconds
}

interface Envelope<T> {
  status?: number
  error?: string
  body?: T
}

// Withings signals errors as {status != 0} inside an HTTP 200 — unwrap or throw.
export function unwrapEnvelope<T>(data: Envelope<T>): T {
  if (data.status !== 0 || !data.body) {
    throw new Error(data.error || `Withings error (status ${data.status ?? 'unknown'})`)
  }
  return data.body
}

export interface MeasureGroup {
  grpid: number
  date: number // unix seconds the measurement was taken
  modified?: number // unix seconds the measurement was last edited server-side
  category: number // 1 = real measurement, 2 = user objective
  measures: { value: number; unit: number; type: number }[]
}

// type 1 = weight; kg = value * 10^unit (e.g. value 82400, unit -3 -> 82.4 kg)
export function parseWeighIns(groups: MeasureGroup[]): WeightEntry[] {
  const entries: WeightEntry[] = []
  const val = (g: MeasureGroup, type: number) => {
    const m = g.measures.find((m) => m.type === type)
    return m ? Math.round(m.value * 10 ** m.unit * 100) / 100 : undefined
  }
  for (const g of groups) {
    if (g.category !== 1) continue
    const kg = val(g, 1)
    if (kg === undefined) continue // weight is the anchor; fat-only groups are skipped
    entries.push({
      date: new Date(g.date * 1000).toISOString(),
      kg,
      source: ID,
      grpid: g.grpid, // stable id: timestamp corrections replace instead of duplicate (#57)
      // body composition (#42): fat % (type 6) and muscle mass kg (type 76)
      fatPct: val(g, 6),
      muscleKg: val(g, 76),
    })
  }
  return entries
}

function loadTokens(): WithingsTokens | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    return null
  }
}
function saveTokens(t: WithingsTokens) {
  localStorage.setItem(KEY, JSON.stringify(t))
}

function redirectUri() {
  return window.location.origin + window.location.pathname
}

export function useWithings(): HealthProvider {
  const state = reactive({
    supported: !!(CLIENT_ID && PROXY_URL),
    connected: !!loadTokens(),
    connecting: false,
    syncing: false,
    error: '',
    accountLabel: '',
    lastSync: loadLastSync(ID),
  })

  function connect() {
    if (!state.supported) return
    const nonce = crypto.randomUUID()
    sessionStorage.setItem(STATE_KEY, nonce)
    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', CLIENT_ID)
    url.searchParams.set('scope', SCOPE)
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('state', nonce)
    window.location.href = url.toString()
  }

  function disconnect() {
    localStorage.removeItem(KEY)
    clearLastSync(ID) // reconnect re-syncs from scratch; the merge is idempotent anyway
    clearCursor(ID)
    state.connected = false
    state.accountLabel = ''
    state.lastSync = null
  }

  function applyTokenResponse(body: {
    access_token: string
    refresh_token: string
    expires_in: number
  }) {
    // Persist immediately — the rotated refresh token is the only copy that still works.
    saveTokens({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + body.expires_in,
    })
  }

  // Claims the shared OAuth callback only when the state nonce is ours (see health.ts).
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
    history.replaceState(null, '', window.location.pathname)

    if (error) {
      state.error = error === 'access_denied' ? 'Withings authorization declined.' : error
      return true
    }

    state.connecting = true
    state.error = ''
    try {
      const res = await fetch(`${PROXY_URL}/withings/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, redirect_uri: redirectUri() }),
      })
      applyTokenResponse(unwrapEnvelope(await res.json()))
      state.connected = true
    } catch (e) {
      state.error = (e as Error).message || String(e)
    } finally {
      state.connecting = false
    }
    return true
  }

  async function freshAccessToken(retried = false): Promise<string> {
    const t = loadTokens()
    if (!t) throw new Error('Not connected to Withings.')
    if (t.expiresAt > Date.now() / 1000 + 60) return t.accessToken // still valid, 1 min margin

    const res = await fetch(`${PROXY_URL}/withings/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: t.refreshToken }),
    })
    // Transient trouble (proxy 5xx, non-JSON body from an intermediary) must NOT destroy
    // a valid token pair — only a definitive rejection from Withings may disconnect (#57).
    if (!res.ok) {
      throw new Error(`Withings refresh failed (HTTP ${res.status}) — will retry later.`)
    }
    let data
    try {
      data = await res.json()
    } catch {
      throw new Error('Withings refresh returned an invalid response — will retry later.')
    }
    let body
    try {
      body = unwrapEnvelope<{ access_token: string; refresh_token: string; expires_in: number }>(
        data,
      )
    } catch (e) {
      // Withings rotates refresh tokens: another tab may have refreshed (and rotated)
      // while we held the now-stale token. Re-read before destroying the pair (#57).
      const current = loadTokens()
      if (!retried && current && current.refreshToken !== t.refreshToken) {
        return freshAccessToken(true)
      }
      disconnect() // definitive: refresh token expired/revoked — needs a fresh connect
      throw new Error(
        `Withings session expired — reconnect in Settings. (${(e as Error).message})`,
        { cause: e },
      )
    }
    applyTokenResponse(body)
    return body.access_token
  }

  // Incremental: lastupdate returns groups created OR modified since the cursor, so
  // corrections made in the Withings app flow through (the merge overwrites by grpid).
  // First sync (no cursor) pulls the full history, following pagination — a multi-year
  // scale history spans several pages and truncating would lose the tail forever (#57).
  // The next cursor derives from the response's own timestamps, never the client clock.
  async function syncWeight(): Promise<WeighInSync> {
    const accessToken = await freshAccessToken()
    // pre-cursor installs stored only the wall-clock lastSync — fall back to it once
    const cursor = loadCursor(ID) ?? loadLastSync(ID)
    const groups: MeasureGroup[] = []
    let offset: number | undefined
    let capped = false // hit the page cap with data still remaining
    for (let page = 0; ; page++) {
      if (page >= 50) {
        capped = true
        break
      }
      const params = new URLSearchParams({ action: 'getmeas', meastypes: '1,6,76', category: '1' })
      if (cursor) params.set('lastupdate', String(Math.floor(cursor / 1000)))
      if (offset) params.set('offset', String(offset))
      const res = await fetch(MEASURE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: params,
      })
      const body = unwrapEnvelope<{ measuregrps?: MeasureGroup[]; more?: number; offset?: number }>(
        await res.json(),
      )
      groups.push(...(body.measuregrps ?? []))
      if (!body.more || !body.offset) break
      offset = body.offset
    }
    // Withings returns newest-first: advancing the cursor past a capped fetch would
    // strand everything older than page 50 forever. On a cap, resume from the OLDEST
    // fetched timestamp so the next sync continues the backfill; the source+grpid
    // merge makes the overlap idempotent (#139).
    const newest = groups.reduce((max, g) => Math.max(max, g.modified ?? g.date), 0)
    const oldest = groups.reduce((min, g) => Math.min(min, g.modified ?? g.date), Infinity)
    const next = capped ? (Number.isFinite(oldest) ? oldest : null) : newest || null
    return { entries: parseWeighIns(groups), cursor: next ? next * 1000 : null }
  }

  return { id: ID, name: 'Withings', state, connect, disconnect, handleRedirect, syncWeight }
}
