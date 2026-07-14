// Demo mode (#169): simulated treadmill + HR monitor behind the exact composable
// interfaces, plus a seeded dataset — so screenshots, docs and manual UI work need no
// physical belt. Explicitly opt-in (?demo or walkfit.demo=1) so it can never mask a
// real connection failure.
import { reactive } from 'vue'
import type { TreadmillState } from './treadmill'
import type { HeartRateState } from './heartrate'
import { SPEED_MIN, SPEED_MAX, SPEED_STEP } from './protocol'

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
export function seedDemoData() {
  if (localStorage.getItem('walkfit.history')) return // never clobber real data
  const day = (offset: number, h: number, m = 15) => {
    const d = new Date()
    d.setDate(d.getDate() - offset)
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }
  const walk = (offset: number, h: number, km: number, minutes: number, hrBase: number) => ({
    date: day(offset, h),
    distance: Math.round(km * 1000),
    duration: minutes * 60,
    kcal: Math.round(km * 52),
    steps: Math.round(km * 1400),
    avgHr: hrBase + 8,
    hrMin: hrBase - 12,
    hrMax: hrBase + 26,
  })
  const history = [
    walk(20, 8, 1.8, 26, 104),
    walk(19, 18, 2.4, 33, 108),
    walk(17, 7, 1.2, 17, 101),
    walk(16, 19, 3.1, 41, 112),
    walk(15, 8, 2.0, 28, 106),
    walk(13, 18, 2.6, 35, 109),
    walk(12, 7, 1.5, 21, 103),
    walk(11, 19, 3.4, 44, 114),
    walk(9, 8, 2.2, 30, 107),
    walk(8, 18, 2.8, 37, 110),
    walk(6, 7, 1.9, 27, 105),
    walk(5, 19, 3.0, 39, 111),
    walk(4, 8, 2.3, 31, 108),
    walk(3, 18, 2.7, 36, 109),
    walk(2, 7, 2.1, 29, 106),
    walk(1, 19, 3.2, 42, 113),
    walk(0, 8, 1.6, 22, 104),
  ]
  const weigh = (offset: number, kg: number, fat: number, muscle: number) => ({
    date: day(offset, 7, 5),
    kg,
    source: 'demo',
    fatPct: fat,
    muscleKg: muscle,
  })
  const weights = [
    weigh(20, 84.6, 26.4, 54.0),
    weigh(17, 84.1, 26.1, 54.2),
    weigh(14, 83.7, 25.8, 54.4),
    weigh(11, 83.4, 25.6, 54.5),
    weigh(8, 83.0, 25.2, 54.7),
    weigh(5, 82.6, 24.9, 54.9),
    weigh(2, 82.3, 24.7, 55.1),
    weigh(0, 82.1, 24.5, 55.2),
  ]
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
  ]
  localStorage.setItem('walkfit.setupDone', '1')
  localStorage.setItem('walkfit.history', JSON.stringify(history))
  localStorage.setItem('walkfit.weight.log', JSON.stringify(weights))
  localStorage.setItem('walkfit.weight', '82.1')
  localStorage.setItem('walkfit.weight.goal', '80')
  localStorage.setItem('walkfit.workouts.custom', JSON.stringify(custom))
  localStorage.setItem('walkfit.bestLap', '412')
}
