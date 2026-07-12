// Preset walking-pad trainings (device range 1.0-6.0 km/h), tuned for weight loss:
// sustained fat-burn zones plus intervals that raise calorie burn.
// A training is a list of segments { speed (km/h), minutes }.

export const trainings = [
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

// Every training ends with a fixed 1:45 (1.75 min) cooldown at 1 km/h.
const COOLDOWN = { speed: 1.0, minutes: 1.75 }
for (const t of trainings) t.segments.push({ ...COOLDOWN })

// Approx metabolic equivalent for a walking speed (km/h).
export function metForSpeed(kmh) {
  if (kmh < 3) return 2.0
  if (kmh < 4) return 3.0
  if (kmh < 4.5) return 3.5
  if (kmh < 5) return 4.3
  if (kmh < 5.5) return 5.0
  return 6.3
}

// Rolled-up stats for a training. weightKg used for the calorie estimate.
export function trainingStats(t, weightKg = 70) {
  let minutes = 0,
    distanceKm = 0,
    kcal = 0
  for (const s of t.segments) {
    minutes += s.minutes
    distanceKm += (s.speed * s.minutes) / 60
    kcal += metForSpeed(s.speed) * weightKg * (s.minutes / 60)
  }
  return { minutes, distanceKm, kcal: Math.round(kcal) }
}

// Segment boundaries in seconds, plus total, for driving playback.
export function timeline(t) {
  const segs = []
  let cum = 0
  for (const s of t.segments) {
    const start = cum
    cum += s.minutes * 60
    segs.push({ speed: s.speed, start, end: cum })
  }
  return { segs, total: cum }
}
