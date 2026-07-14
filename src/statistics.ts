// Session statistics: one entry per completed walk, persisted to localStorage.
// Storage key stays 'walkfit.history' so existing logs survive the rename to statistics.
const KEY = 'walkfit.history'
const MAX_ENTRIES = 500 // ~a year of daily walks; keeps localStorage bounded

export interface Session {
  date: string // ISO string, session start
  distance: number // metres
  duration: number // seconds
  kcal: number
  steps?: number // belt pedometer count; absent on logs from before step support (#43)
  avgHr: number | null // bpm, null when no HR sensor was connected
  hrMin?: number // bpm low over the session; absent when no HR sensor / pre-#43 logs
  hrMax?: number // bpm high over the session; absent when no HR sensor / pre-#43 logs
}

export interface WeekTotals {
  week: string // "YYYY-Www" ISO-week key
  sessions: number
  distance: number // metres
  duration: number // seconds
  kcal: number
}

// Per-calendar-day rollup for the activity rings + daily bar/HR charts (#43).
export interface DayTotals {
  date: string // "YYYY-MM-DD" local day key
  sessions: number
  distance: number // metres
  duration: number // seconds
  kcal: number
  steps: number
  hrMin: number | null // bpm low across the day's sessions (null when no HR data)
  hrMax: number | null // bpm high across the day
  hrAvg: number | null // duration-weighted mean of session avgHr
}

// Daily activity goals the rings fill against (issue #43). Configurable in Settings.
export interface Goals {
  kcal: number
  steps: number
  minutes: number
}
export const DEFAULT_GOALS: Goals = { kcal: 500, steps: 8000, minutes: 30 }
const GOALS_KEY = 'walkfit.goals'

export function loadStatistics(): Session[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function addSession(entry: Session): Session[] {
  const list = loadStatistics()
  list.push(entry)
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  localStorage.setItem(KEY, JSON.stringify(list))
  return list
}

// Merge imported sessions (#69): union by start date (the de-facto session id),
// existing entries win, result stays date-sorted and bounded.
// Backup imports feed parsed JSON straight in — one entry with a missing/garbage
// numeric would poison every reducer with NaN (and persist). Validate and coerce
// per-field instead of trusting the shape (#137).
function sanitizeSession(e: unknown): Session | null {
  if (!e || typeof e !== 'object') return null
  const raw = e as Record<string, unknown>
  if (typeof raw.date !== 'string') return null
  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)
  const distance = num(raw.distance)
  const duration = num(raw.duration)
  if (distance === null || duration === null || distance < 0 || duration < 0) return null
  const out: Session = {
    date: raw.date,
    distance,
    duration,
    kcal: num(raw.kcal) ?? 0,
    avgHr: num(raw.avgHr),
  }
  const steps = num(raw.steps)
  if (steps !== null) out.steps = steps
  const hrMin = num(raw.hrMin)
  const hrMax = num(raw.hrMax)
  if (hrMin !== null && hrMax !== null) {
    out.hrMin = hrMin
    out.hrMax = hrMax
  }
  return out
}

export function mergeSessions(entries: Session[]): Session[] {
  const list = loadStatistics()
  const have = new Set(list.map((s) => s.date))
  for (const rawEntry of entries) {
    const e = sanitizeSession(rawEntry)
    if (e && !have.has(e.date)) {
      list.push(e)
      have.add(e.date)
    }
  }
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  localStorage.setItem(KEY, JSON.stringify(list))
  return list
}

// Remove one session by its start timestamp (unique per walk in practice) — for
// deleting accidental starts the 50 m filter let through (#67).
export function removeSession(date: string): Session[] {
  const list = loadStatistics().filter((s) => s.date !== date)
  localStorage.setItem(KEY, JSON.stringify(list))
  return list
}

function isoWeekKey(date: Date): string {
  // ISO week (Mon-start), keyed as "YYYY-Www" so it sorts/groups correctly across year ends.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Weekly rollups, most recent week first.
export function weeklyTotals(sessions: Session[]): WeekTotals[] {
  const byWeek = new Map<string, WeekTotals>()
  for (const s of sessions) {
    const key = isoWeekKey(new Date(s.date))
    const w = byWeek.get(key) || { week: key, sessions: 0, distance: 0, duration: 0, kcal: 0 }
    w.sessions += 1
    w.distance += s.distance
    w.duration += s.duration
    w.kcal += s.kcal
    byWeek.set(key, w)
  }
  return [...byWeek.values()].sort((a, b) => (a.week < b.week ? 1 : -1))
}

function localDayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Per-day rollups for the last `days` calendar days ending today (local time), oldest
// first, zero-filled so days with no walk still get a (0) bucket for the bar charts. HR
// fields are null on days with no HR data. Pre-#43 sessions have no steps/hrMin/hrMax;
// they contribute 0 steps and fall back to avgHr for the day's HR range.
// Monday 00:00 (local) of the week containing d — the statistics dashboard shows
// full calendar weeks (Mon-Sun) and navigates by these anchors.
export function weekStart(d: Date = new Date()): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7))
  return out
}

export function dailyTotals(sessions: Session[], days: number, now = new Date()): DayTotals[] {
  const byDay = new Map<string, Session[]>()
  for (const s of sessions) {
    const k = localDayKey(new Date(s.date))
    const list = byDay.get(k)
    if (list) list.push(s)
    else byDay.set(k, [s])
  }
  const out: DayTotals[] = []
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - (days - 1))
  for (let i = 0; i < days; i++) {
    const list = byDay.get(localDayKey(cursor)) ?? []
    const lows = list.map((s) => s.hrMin ?? s.avgHr).filter((v): v is number => v != null)
    const highs = list.map((s) => s.hrMax ?? s.avgHr).filter((v): v is number => v != null)
    const withHr = list.filter((s) => s.avgHr != null)
    const hrDuration = withHr.reduce((a, s) => a + s.duration, 0)
    out.push({
      date: localDayKey(cursor),
      sessions: list.length,
      distance: list.reduce((a, s) => a + s.distance, 0),
      duration: list.reduce((a, s) => a + s.duration, 0),
      kcal: list.reduce((a, s) => a + s.kcal, 0),
      steps: list.reduce((a, s) => a + (s.steps ?? 0), 0),
      hrMin: lows.length ? Math.min(...lows) : null,
      hrMax: highs.length ? Math.max(...highs) : null,
      hrAvg: hrDuration
        ? Math.round(withHr.reduce((a, s) => a + (s.avgHr as number) * s.duration, 0) / hrDuration)
        : null,
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

export function loadGoals(): Goals {
  try {
    const raw = JSON.parse(localStorage.getItem(GOALS_KEY) || '{}')
    const pick = (v: unknown, fallback: number) => (Number(v) > 0 ? Number(v) : fallback)
    return {
      kcal: pick(raw.kcal, DEFAULT_GOALS.kcal),
      steps: pick(raw.steps, DEFAULT_GOALS.steps),
      minutes: pick(raw.minutes, DEFAULT_GOALS.minutes),
    }
  } catch {
    return { ...DEFAULT_GOALS }
  }
}

export function saveGoals(goals: Goals): void {
  // an emptied number input writes '' through v-model.number — coerce per-field so a
  // transient invalid value never persists (#137)
  const pick = (v: unknown, fallback: number) => (Number(v) > 0 ? Number(v) : fallback)
  localStorage.setItem(
    GOALS_KEY,
    JSON.stringify({
      kcal: pick(goals.kcal, DEFAULT_GOALS.kcal),
      steps: pick(goals.steps, DEFAULT_GOALS.steps),
      minutes: pick(goals.minutes, DEFAULT_GOALS.minutes),
    }),
  )
}

// Consecutive-day streak ending today or yesterday (a walk yesterday still counts
// as "keep the streak alive" — it only breaks once a full day is missed).
export function currentStreak(sessions: Session[], now = new Date()): number {
  if (!sessions.length) return 0
  const days = new Set(sessions.map((s) => new Date(s.date).toDateString()))
  let streak = 0
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1) // allow "today" gap
  while (days.has(cursor.toDateString())) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}
