// Preset walking-pad workouts (device range 1.0-6.0 km/h), tuned for weight loss:
// sustained fat-burn zones plus intervals that raise calorie burn.
// A workout is a list of segments { speed (km/h), minutes }.

export interface Segment {
  speed: number // km/h
  minutes: number
}

export interface Workout {
  id: string
  name: string
  focus: string
  segments: Segment[]
}

export interface TimelineSegment {
  speed: number // km/h
  start: number // seconds
  end: number // seconds
}

export interface Timeline {
  segs: TimelineSegment[]
  total: number // seconds
}

export interface WorkoutStats {
  minutes: number
  distanceKm: number
  kcal: number
}

// A steer target for the HR-steered workout mode: hold bpm inside lo..hi % of max HR.
// Rows live in App.vue's HR_TARGETS; the shape is shared with WorkoutPicker's HR tab.
export interface HrTarget {
  id: string
  name: string
  color: string
  loPct: number
  hiPct: number
}

export const workouts: Workout[] = [
  {
    id: 'fatburn30',
    name: 'Fat Burn 30',
    focus: 'Steady fat-burn zone — sustainable brisk walk',
    segments: [
      { speed: 2.5, minutes: 3 },
      { speed: 4.5, minutes: 24 },
      { speed: 2.5, minutes: 3 },
    ],
  },
  {
    id: 'intervals30',
    name: 'Interval Melt 30',
    focus: 'Brisk/recovery intervals to torch more calories',
    segments: [
      { speed: 2.5, minutes: 3 },
      { speed: 5.5, minutes: 3 },
      { speed: 3.0, minutes: 3 },
      { speed: 5.5, minutes: 3 },
      { speed: 3.0, minutes: 3 },
      { speed: 5.5, minutes: 3 },
      { speed: 3.0, minutes: 3 },
      { speed: 5.5, minutes: 3 },
      { speed: 3.0, minutes: 3 },
      { speed: 2.0, minutes: 3 },
    ],
  },
  {
    id: 'power45',
    name: 'Power Walk 45',
    focus: 'Long steady session — high total burn',
    segments: [
      { speed: 2.5, minutes: 5 },
      { speed: 4.0, minutes: 35 },
      { speed: 2.0, minutes: 5 },
    ],
  },
  {
    id: 'quick20',
    name: 'Quick Burn 20',
    focus: 'Short, punchy intervals for a busy day',
    segments: [
      { speed: 2.5, minutes: 2 },
      { speed: 5.0, minutes: 3 },
      { speed: 3.0, minutes: 1 },
      { speed: 5.0, minutes: 3 },
      { speed: 3.0, minutes: 1 },
      { speed: 5.0, minutes: 3 },
      { speed: 3.0, minutes: 1 },
      { speed: 5.0, minutes: 3 },
      { speed: 2.0, minutes: 2 },
    ],
  },
  {
    id: 'easy30',
    name: 'Easy Walk 30',
    focus: 'Gentle recovery pace',
    segments: [
      { speed: 2.5, minutes: 3 },
      { speed: 3.5, minutes: 24 },
      { speed: 2.5, minutes: 3 },
    ],
  },
]

// Every workout ends with a fixed 1:45 (1.75 min) cooldown at 1 km/h.
const COOLDOWN: Segment = { speed: 1.0, minutes: 1.75 }
for (const w of workouts) w.segments.push({ ...COOLDOWN })

// Contiguous, non-overlapping bpm ranges for a steer target: hi is one below the next
// target's lo (Light 90–113, Fat burn 114–132, … at the default 190 max HR).
export function hrTargetRange(t: HrTarget, maxHr: number): { lo: number; hi: number } {
  return {
    lo: Math.round((t.loPct / 100) * maxHr),
    hi: Math.round((t.hiPct / 100) * maxHr) - 1,
  }
}

// Approx metabolic equivalent for a walking speed (km/h).
export function metForSpeed(kmh: number): number {
  if (kmh < 3) return 2.0
  if (kmh < 4) return 3.0
  if (kmh < 4.5) return 3.5
  if (kmh < 5) return 4.3
  if (kmh < 5.5) return 5.0
  return 6.3
}

// Rolled-up stats for a workout. weightKg used for the calorie estimate.
export function workoutStats(w: Pick<Workout, 'segments'>, weightKg = 70): WorkoutStats {
  let minutes = 0,
    distanceKm = 0,
    kcal = 0
  for (const s of w.segments) {
    minutes += s.minutes
    distanceKm += (s.speed * s.minutes) / 60
    kcal += metForSpeed(s.speed) * weightKg * (s.minutes / 60)
  }
  return { minutes, distanceKm, kcal: Math.round(kcal) }
}

// Segment boundaries in seconds, plus total, for driving playback.
export function timeline(w: Pick<Workout, 'segments'>): Timeline {
  const segs: TimelineSegment[] = []
  let cum = 0
  for (const s of w.segments) {
    const start = cum
    cum += s.minutes * 60
    segs.push({ speed: s.speed, start, end: cum })
  }
  return { segs, total: cum }
}

// --- custom workouts (#68): user-built segment plans, persisted locally ---
const CUSTOM_KEY = 'walkfit.workouts.custom'
// device speed range (see treadmill.ts SPEED_MIN/MAX — duplicated to keep this module
// framework-free); minutes capped to keep a plan sane
const CUSTOM_SPEED_MIN = 1.0
const CUSTOM_SPEED_MAX = 6.0
const CUSTOM_MAX_SEGMENTS = 24

function sanitizeCustom(w: Workout): Workout | null {
  if (!w || typeof w.id !== 'string' || typeof w.name !== 'string') return null
  if (!Array.isArray(w.segments) || !w.segments.length) return null
  // Guard each element: a null/garbage segment (corrupt storage, edited backup) must
  // drop THIS workout, not throw — a throw escapes loadCustomWorkouts' map and the
  // next save would persist [] and wipe every stored plan (#136).
  if (w.segments.some((s) => !s || typeof s !== 'object')) return null
  const segments = w.segments.slice(0, CUSTOM_MAX_SEGMENTS).map((s) => ({
    speed:
      Math.round(
        Math.min(CUSTOM_SPEED_MAX, Math.max(CUSTOM_SPEED_MIN, Number(s.speed) || 0)) * 10,
      ) / 10,
    minutes: Math.round(Math.min(120, Math.max(1, Number(s.minutes) || 0))),
  }))
  return {
    id: w.id,
    name: w.name.trim().slice(0, 40) || 'My workout',
    focus: w.focus || '',
    segments,
  }
}

export function loadCustomWorkouts(): Workout[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.map(sanitizeCustom).filter((w): w is Workout => w !== null)
  } catch {
    return []
  }
}

// Add or replace (same id) a custom workout; segments are clamped to the device range.
export function saveCustomWorkout(w: Workout): Workout[] {
  const clean = sanitizeCustom(w)
  if (!clean) return loadCustomWorkouts()
  const list = loadCustomWorkouts().filter((x) => x.id !== clean.id)
  list.push(clean)
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list))
  return list
}

export function deleteCustomWorkout(id: string): Workout[] {
  const list = loadCustomWorkouts().filter((x) => x.id !== id)
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list))
  return list
}
