// Session history: one entry per completed walk, persisted to localStorage.
const KEY = 'walkfit.history'
const MAX_ENTRIES = 500 // ~a year of daily walks; keeps localStorage bounded

export function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

// entry: { date (ISO string, session start), distance (m), duration (s), kcal, avgHr (bpm or null) }
export function addSession(entry) {
  const list = loadHistory()
  list.push(entry)
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  localStorage.setItem(KEY, JSON.stringify(list))
  return list
}

function isoWeekKey(date) {
  // ISO week (Mon-start), keyed as "YYYY-Www" so it sorts/groups correctly across year ends.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Weekly rollups, most recent week first.
export function weeklyTotals(history) {
  const byWeek = new Map()
  for (const s of history) {
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

// Consecutive-day streak ending today or yesterday (a walk yesterday still counts
// as "keep the streak alive" — it only breaks once a full day is missed).
export function currentStreak(history, now = new Date()) {
  if (!history.length) return 0
  const days = new Set(history.map((s) => new Date(s.date).toDateString()))
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
