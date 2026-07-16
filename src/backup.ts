// Backup & restore (#69): everything WalkFit knows lives in this browser's
// localStorage — a cleared profile or device switch would lose months of history.
// Export dumps the walkfit.* keys as a JSON file; import merges it back.
import { loadStatistics, mergeSessions, type Session } from './statistics'
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

// CSV export of the session log (#147) — read-only, spreadsheet-friendly; JSON export
// above remains the one full backup/restore format. One row per walk, newest first to
// match the walk log's own order; fields quoted only when they contain a comma/quote/
// newline (dates and numbers never do, so most rows stay unquoted).
const CSV_COLUMNS = [
  'date',
  'distanceKm',
  'durationMin',
  'kcal',
  'steps',
  'avgHr',
  'hrMin',
  'hrMax',
] as const
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function sessionRow(s: Session): string {
  return [
    s.date,
    (s.distance / 1000).toFixed(2),
    (s.duration / 60).toFixed(1),
    Math.round(s.kcal),
    s.steps ?? '',
    s.avgHr ?? '',
    s.hrMin ?? '',
    s.hrMax ?? '',
  ]
    .map(csvCell)
    .join(',')
}
export function exportCsv(sessions: Session[] = loadStatistics()): string {
  const header = CSV_COLUMNS.join(',')
  const rows = [...sessions].reverse().map(sessionRow)
  return [header, ...rows].join('\r\n') + '\r\n'
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
