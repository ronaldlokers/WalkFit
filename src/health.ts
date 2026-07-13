// Health-service sync: a small provider abstraction so weigh-in sources (Withings now;
// Garmin Connect, Apple Health import, ... later) plug in without the app knowing any
// provider specifics. Providers own their OAuth flow and sync cursor; the app renders
// them generically in Settings and merges whatever they return into the weight log.
import { mergeWeighIns } from './weight'
import type { WeightEntry } from './weight'

export interface HealthProviderState {
  supported: boolean // build-time env present — hidden from the UI entirely when false
  connected: boolean
  connecting: boolean
  syncing: boolean
  error: string
  accountLabel: string // e.g. account name/email once connected, '' otherwise
  lastSync: number | null // ms epoch of the last successful sync, null = never
}

export interface HealthProvider {
  id: string // stable slug, doubles as the WeightEntry.source ('withings', ...)
  name: string // display name ('Withings')
  state: HealthProviderState // reactive
  connect(): void
  disconnect(): void
  // Consume the OAuth redirect ONLY if the returned `state` nonce is this provider's
  // own (each provider keeps its nonce under its own sessionStorage key). Returns true
  // when consumed — several providers (and Strava) share one redirect URI, so exactly
  // one flow may claim a given callback and strip the query string.
  handleRedirect(): Promise<boolean>
  // Incremental fetch of new/changed weigh-ins; the provider tracks its own cursor.
  syncWeight(): Promise<WeightEntry[]>
}

const LAST_SYNC_PREFIX = 'walkfit.health.lastSync.'

export function loadLastSync(id: string): number | null {
  const raw = localStorage.getItem(LAST_SYNC_PREFIX + id)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : null
}
export function saveLastSync(id: string, ms: number) {
  localStorage.setItem(LAST_SYNC_PREFIX + id, String(ms))
}
export function clearLastSync(id: string) {
  localStorage.removeItem(LAST_SYNC_PREFIX + id)
}

// Sync one provider into the weight log. Returns the updated log (or null when the
// provider wasn't connected / had nothing) so the caller can refresh its reactive copy
// and let the newest entry drive the kcal weight.
export async function syncProvider(p: HealthProvider): Promise<WeightEntry[] | null> {
  if (!p.state.connected || p.state.syncing) return null
  p.state.syncing = true
  p.state.error = ''
  try {
    const entries = await p.syncWeight()
    p.state.lastSync = Date.now()
    saveLastSync(p.id, p.state.lastSync)
    return entries.length ? mergeWeighIns(entries) : null
  } catch (e) {
    p.state.error = (e as Error).message || String(e)
    return null
  } finally {
    p.state.syncing = false
  }
}
