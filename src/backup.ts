// Backup & restore (#69): everything WalkFit knows lives in this browser's
// localStorage — a cleared profile or device switch would lose months of history.
// Export dumps the walkfit.* keys as a JSON file; import merges it back.
import { mergeSessions } from './statistics'
import { mergeWeighIns } from './weight'

const PREFIX = 'walkfit.'
// OAuth token pairs are device-bound secrets — excluded unless explicitly requested
const TOKEN_KEYS = ['walkfit.strava', 'walkfit.withings']
// mid-walk snapshot: meaningless on another device/session
const TRANSIENT_KEYS = ['walkfit.session.inprogress']

export function exportData(includeTokens = false): string {
  const data: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (!k.startsWith(PREFIX)) continue
    if (!includeTokens && TOKEN_KEYS.includes(k)) continue
    if (TRANSIENT_KEYS.includes(k)) continue
    data[k] = localStorage.getItem(k)!
  }
  return JSON.stringify(
    { app: 'walkfit', version: 1, exportedAt: new Date().toISOString(), data },
    null,
    2,
  )
}

// Applies a backup: sessions and weigh-ins MERGE through their idempotent helpers
// (no duplicates, existing data survives); everything else overwrites. Returns the
// number of keys applied; throws on files that aren't WalkFit backups.
export function importData(json: string): number {
  let parsed: { app?: string; data?: Record<string, unknown> }
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Not a valid JSON file.')
  }
  if (parsed?.app !== 'walkfit' || typeof parsed.data !== 'object' || parsed.data === null) {
    throw new Error('Not a WalkFit backup file.')
  }
  let applied = 0
  for (const [k, v] of Object.entries(parsed.data)) {
    if (!k.startsWith(PREFIX) || typeof v !== 'string') continue
    try {
      if (k === 'walkfit.history') {
        mergeSessions(JSON.parse(v))
      } else if (k === 'walkfit.weight.log') {
        mergeWeighIns(JSON.parse(v))
      } else if (TRANSIENT_KEYS.includes(k)) {
        continue
      } else {
        localStorage.setItem(k, v)
      }
      applied++
    } catch {
      // one bad key must not abort the rest of the restore
    }
  }
  return applied
}
