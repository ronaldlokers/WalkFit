// Demo mode (#169): simulated treadmill + HR monitor behind the exact composable
// interfaces, plus a seeded dataset — so screenshots, docs and manual UI work need no
// physical belt. Explicitly opt-in (?demo or walkfit.demo=1) so it can never mask a
// real connection failure.
import { reactive } from 'vue'
import type { TreadmillState } from './treadmill'
import type { HeartRateState } from './heartrate'
import { SPEED_MIN, SPEED_MAX, SPEED_STEP } from './protocol'
import type { Session, SeriesPoint } from './statistics'

export function isDemo(): boolean {
  return (
    new URLSearchParams(window.location.search).has('demo') ||
    localStorage.getItem('walkfit.demo') === '1'
  )
}

const MAX_SAMPLES = 1800

// Shared so the HR sim can react to belt speed like a real heart would.
const tm = reactive<TreadmillState>({
  secure: true,
  hasApi: true,
  supported: true,
  connecting: false,
  connected: false,
  remembered: true,
  running: false,
  deviceName: 'Demo Motion One',
  speed: 0,
  targetSpeed: SPEED_MIN,
  distance: 0,
  steps: 0,
  beltDistance: 0,
  beltKcal: 0,
  beltTime: 0,
  elapsed: 0,
  error: '',
  history: [],
  log: [],
})

let tmTimer: ReturnType<typeof setInterval> | undefined
function tickTreadmill() {
  if (tm.running) {
    // belt ramps toward the target like the real controller (~0.3 km/h per second)
    if (Math.abs(tm.speed - tm.targetSpeed) <= 0.3) tm.speed = tm.targetSpeed
    else tm.speed += Math.sign(tm.targetSpeed - tm.speed) * 0.3
    tm.speed = Math.round(tm.speed * 10) / 10
    tm.distance += tm.speed / 3.6
    tm.elapsed += 1
    tm.steps += Math.round((tm.speed / 3.6) * 1.6) // ~1.6 steps per metre walked
    tm.beltDistance = tm.distance
    tm.beltTime = tm.elapsed
    tm.beltKcal = Math.round(tm.elapsed * 0.07)
  } else if (tm.speed > 0) {
    // deceleration coast, like the real belt
    tm.speed = Math.max(0, Math.round((tm.speed - 0.6) * 10) / 10)
  }
  tm.history.push(tm.speed)
  if (tm.history.length > MAX_SAMPLES) tm.history.shift()
}

export function demoTreadmill() {
  async function connect() {
    tm.connecting = true
    await new Promise((r) => setTimeout(r, 400))
    tm.connecting = false
    tm.connected = true
    if (!tmTimer) tmTimer = setInterval(tickTreadmill, 1000)
  }
  async function autoConnect() {
    await connect() // a demo device is always in range
  }
  function disconnect() {
    tm.connected = false
    tm.running = false
    tm.speed = 0
    clearInterval(tmTimer)
    tmTimer = undefined
  }
  function forget() {
    disconnect()
    tm.remembered = false
  }
  async function start() {
    if (!tm.connected) return
    tm.targetSpeed = Math.max(tm.targetSpeed, SPEED_MIN)
    tm.running = true
  }
  async function stop() {
    tm.running = false
  }
  async function pause() {
    tm.running = false
  }
  async function setSpeed(kmh: number) {
    const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, kmh))
    tm.targetSpeed = Math.round(clamped / SPEED_STEP) * SPEED_STEP
    tm.targetSpeed = Math.round(tm.targetSpeed * 10) / 10
  }
  function resetStats() {
    tm.distance = 0
    tm.elapsed = 0
    tm.steps = 0
    tm.beltDistance = 0
    tm.beltKcal = 0
    tm.beltTime = 0
  }
  return {
    state: tm,
    connect,
    autoConnect,
    disconnect,
    forget,
    start,
    stop,
    pause,
    setSpeed,
    resetStats,
  }
}

const hr = reactive<HeartRateState>({
  supported: true,
  connecting: false,
  connected: false,
  remembered: true,
  deviceName: 'Demo HR strap',
  bpm: 0,
  history: [],
  error: '',
})

let hrTimer: ReturnType<typeof setInterval> | undefined
let hrPhase = 0
function tickHeartRate() {
  hrPhase += 1
  // resting ~78, rises with belt speed, slow breathing wave + a little jitter
  const target = 78 + tm.speed * 11 + Math.sin(hrPhase / 9) * 4
  const current = hr.bpm || 78
  const next = current + (target - current) * 0.15 + (Math.random() - 0.5) * 2
  hr.bpm = Math.round(Math.min(185, Math.max(60, next)))
  hr.history.push(hr.bpm)
  if (hr.history.length > MAX_SAMPLES) hr.history.shift()
}

export function demoHeartRate() {
  async function connect() {
    hr.connecting = true
    await new Promise((r) => setTimeout(r, 300))
    hr.connecting = false
    hr.connected = true
    if (!hrTimer) hrTimer = setInterval(tickHeartRate, 1000)
  }
  async function autoConnect() {
    await connect()
  }
  function disconnect() {
    hr.connected = false
    hr.bpm = 0
    clearInterval(hrTimer)
    hrTimer = undefined
  }
  function forget() {
    disconnect()
    hr.remembered = false
  }
  return { state: hr, connect, autoConnect, disconnect, forget }
}

// --- canonical seed fixture: populates every feature surface once, idempotently ---
// #196: 90-day window so the month heatmap, week nav and streak/milestone badges all
// have real range to page through, not just a handful of days. Deterministic — no
// Math.random/Date.now — so the README screenshots stay reproducible; `wobble` stands
// in for randomness via a sine wave instead.
function seedWobble(n: number, amp: number) {
  return Math.sin(n * 1.7) * amp
}
export function seedDemoData() {
  if (localStorage.getItem('walkfit.history')) return // never clobber real data
  const day = (offset: number, h: number, m = 15) => {
    const d = new Date()
    d.setDate(d.getDate() - offset)
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }
  // in-session speed/HR shape (#149) for the walk-detail sparkline — a short
  // deterministic arc around the walk's average, not real telemetry
  function walkSeries(minutes: number, avgSpeed: number, hrBase: number) {
    const steps = 18
    const points: SeriesPoint[] = []
    for (let i = 0; i <= steps; i++) {
      const t = Math.round((i / steps) * minutes * 60)
      const speed = Math.max(SPEED_MIN, Math.round((avgSpeed + seedWobble(i, 0.6)) * 10) / 10)
      const bpm = Math.round(hrBase + speed * 6 + seedWobble(i + 3, 5))
      points.push([t, speed, bpm])
    }
    return points
  }
  function walk(
    offset: number,
    h: number,
    km: number,
    minutes: number,
    hrBase: number,
    opts: { workout?: string; withSeries?: boolean } = {},
  ) {
    const avgSpeed = Math.round((km / (minutes / 60)) * 10) / 10
    return {
      date: day(offset, h),
      distance: Math.round(km * 1000),
      duration: minutes * 60,
      kcal: Math.round(km * 52),
      steps: Math.round(km * 1400),
      avgHr: hrBase + 8,
      hrMin: hrBase - 12,
      hrMax: hrBase + 26,
      ...(opts.workout ? { workout: opts.workout } : {}),
      ...(opts.withSeries ? { series: walkSeries(minutes, avgSpeed, hrBase) } : {}),
    }
  }
  // real preset/HR-target names (workouts.ts / App.vue's HR_TARGETS + i18n's
  // 'session.hrWorkout' format) so tagged sessions in the walk log look genuine
  const PLAN_NAMES = ['Fat Burn 30', 'Easy Walk 30', 'Power Walk 45']
  const HR_NAMES = ['Fat burn HR workout', 'Cardio HR workout', 'Light HR workout']
  const history: Session[] = []
  // offset 89 (oldest) down to 0 (today). A deliberate 5-day gap at offset 46-50
  // breaks the streak on purpose — visible as a blank stretch in the month heatmap
  // and week nav, not just a smooth unbroken history. Elsewhere every 5th day is a
  // rest day; the most recent 15 days are walked every day for a clean live streak.
  for (let offset = 89; offset >= 0; offset--) {
    const inGap = offset <= 50 && offset >= 46
    const inLiveStreak = offset <= 14
    const isRestDay = !inLiveStreak && offset % 5 === 4
    if (inGap || isRestDay) continue
    const dow = offset % 7
    const morning = dow % 2 === 0
    const km = Math.max(
      1.0,
      Math.round((2.0 + seedWobble(offset, 1.0) + (dow >= 5 ? 0.6 : 0)) * 10) / 10,
    )
    const minutes = Math.max(12, Math.round(km * 14 + seedWobble(offset + 1, 2)))
    const hrBase = 100 + Math.round(seedWobble(offset + 2, 6))
    const taggedIdx = offset % 6
    const workout =
      taggedIdx === 0
        ? PLAN_NAMES[offset % PLAN_NAMES.length]
        : taggedIdx === 3
          ? HR_NAMES[offset % HR_NAMES.length]
          : undefined
    const withSeries = offset % 4 === 0
    history.push(walk(offset, morning ? 8 : 19, km, minutes, hrBase, { workout, withSeries }))
  }
  // deliberate multi-session day (#43 DayTotals rollup across >1 walk/day): a short
  // extra evening walk stacked on top of today's morning session
  history.push(walk(0, 20, 1.4, 20, 106))
  const weigh = (offset: number, kg: number, fat: number, muscle: number) => ({
    date: day(offset, 7, 5),
    kg: Math.round(kg * 10) / 10,
    source: 'demo',
    fatPct: Math.round(fat * 10) / 10,
    muscleKg: Math.round(muscle * 10) / 10,
  })
  // ~weekly weigh-ins across the same 90-day window, net downward trend with small
  // non-monotonic noise (real scales don't produce a perfectly straight line)
  const weighInOffsets = [88, 81, 74, 67, 60, 53, 46, 39, 32, 25, 18, 11, 4, 0]
  const weights = weighInOffsets.map((offset, i) =>
    weigh(
      offset,
      85.0 - i * 0.3 + seedWobble(i, 0.25),
      26.5 - i * 0.13 + seedWobble(i + 1, 0.15),
      53.8 + i * 0.1 + seedWobble(i + 2, 0.1),
    ),
  )
  const custom = [
    {
      id: 'custom-demo',
      name: 'My hill day',
      focus: 'Alternating brisk and easy blocks',
      segments: [
        { speed: 2.5, minutes: 4 },
        { speed: 4.5, minutes: 6 },
        { speed: 3.0, minutes: 4 },
        { speed: 5.0, minutes: 6 },
        { speed: 2.5, minutes: 5 },
      ],
    },
    {
      id: 'custom-demo-2',
      name: 'Lunch loop',
      focus: 'Short brisk-paced break walk',
      segments: [
        { speed: 3.0, minutes: 3 },
        { speed: 5.0, minutes: 10 },
        { speed: 3.0, minutes: 3 },
      ],
    },
  ]
  localStorage.setItem('walkfit.setupDone', '1')
  localStorage.setItem('walkfit.history', JSON.stringify(history))
  localStorage.setItem('walkfit.weight.log', JSON.stringify(weights))
  localStorage.setItem('walkfit.weight', String(weights[weights.length - 1]!.kg))
  localStorage.setItem('walkfit.weight.goal', '80')
  localStorage.setItem('walkfit.workouts.custom', JSON.stringify(custom))
}
