<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick, watch, defineAsyncComponent } from 'vue'
import { useTreadmill, SPEED_MIN, SPEED_MAX, SPEED_STEP } from './treadmill'
import { useHeartRate } from './heartrate'
import { workouts, timeline, metForSpeed } from './workouts'
import type { Workout, HrTarget } from './workouts'
import {
  loadStatistics,
  addSession,
  weeklyTotals,
  currentStreak,
  dailyTotals,
  loadGoals,
  saveGoals,
} from './statistics'
import type { Session } from './statistics'
import {
  trackPoint,
  laneStaggers,
  distanceSigns,
  BEND_R,
  STRAIGHT_M,
  LANE_W,
  LANES,
  TRACK_IN,
  TRACK_OUT,
} from './scenic'
import { loadWeightLog, addWeighIn } from './weight'
import type { WeightEntry } from './weight'
import { syncProvider } from './health'
import type { HealthProvider } from './health'
import { useWithings } from './withings'
import { useStrava } from './strava'
import WorkoutPicker from './WorkoutPicker.vue'

const {
  state,
  connect,
  autoConnect: tmAutoConnect,
  disconnect,
  forget: forgetTreadmill,
  start,
  stop,
  setSpeed,
  resetStats,
} = useTreadmill()
const hr = useHeartRate()
const strava = useStrava()
const origin = window.location.origin

// --- onboarding wizard ---
const wizardOpen = ref(true)
const wizardStep = ref(1) // 1 treadmill · 2 heart rate · 3 mode · 4 pick workout
function wizardWalk() {
  active.value = null
  wizardOpen.value = false
}
// Wizard's own start handlers: same shared start logic as the header-button menu, plus
// closing the wizard (WorkoutPicker itself has no "close" affordance in the wizard step —
// :closable="false" — the wizard's own Back button is the only way out besides picking).
function wizardStartPlan(w: Workout) {
  wizardOpen.value = false
  startWorkout(w)
}
function wizardStartHr(t: HrTarget) {
  wizardOpen.value = false
  startHrWorkout(t)
}

// --- header overflow menu (Workout / Statistics / Disconnect / Settings) ---
const moreMenuOpen = ref(false)
function menuOpenWorkouts() {
  moreMenuOpen.value = false
  openWorkoutMenu()
}
function menuOpenStatistics() {
  moreMenuOpen.value = false
  statisticsOpen.value = true
}
function menuDisconnect() {
  moreMenuOpen.value = false
  disconnect()
}
function menuOpenSettings() {
  moreMenuOpen.value = false
  settingsOpen.value = true
}

// --- settings ---
const settingsOpen = ref(false)
const debugOn = ref(localStorage.getItem('walkfit.debug') === '1')
watch(debugOn, (v) => localStorage.setItem('walkfit.debug', v ? '1' : '0'))

// --- audio cues ---
const audioOn = ref(localStorage.getItem('walkfit.audio') !== '0') // default on
watch(audioOn, (v) => localStorage.setItem('walkfit.audio', v ? '1' : '0'))
let audioCtx: AudioContext | null = null
function beep(freq = 880, ms = 120) {
  if (!audioOn.value) return
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext!)()
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.frequency.value = freq
    g.gain.value = 0.08
    o.connect(g)
    g.connect(audioCtx.destination)
    o.start()
    o.stop(audioCtx.currentTime + ms / 1000)
  } catch {
    // no audio output available — cues are best-effort
  }
}
function speak(text: string) {
  if (!audioOn.value) return
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.1
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch {
    // speech synthesis unavailable — cues are best-effort
  }
}

// --- heart rate zones ---
const maxHr = ref(Number(localStorage.getItem('walkfit.maxhr')) || 190)
watch(maxHr, (v) => localStorage.setItem('walkfit.maxhr', String(v)))

// --- weight (used for calorie estimates — see workoutStats / metForSpeed) ---
const weightKg = ref(Number(localStorage.getItem('walkfit.weight')) || 70)
watch(weightKg, (v) => localStorage.setItem('walkfit.weight', String(v)))
// Shared by the live HR badge (hrZone) and the HR-steered autopilot's target picker below,
// so the two can't drift apart. hi is a %-of-maxHr upper bound; Infinity for the top zone.
const HR_ZONES = [
  { z: 1, name: 'Warm up', color: '#6ab0ff', hi: 60 },
  { z: 2, name: 'Fat burn', color: '#2ed573', hi: 70 },
  { z: 3, name: 'Cardio', color: '#f5a623', hi: 80 },
  { z: 4, name: 'Hard', color: '#ff7f50', hi: 90 },
  { z: 5, name: 'Max', color: '#ff4757', hi: Infinity },
]
const hrZone = computed(() => {
  const bpm = hr.state.bpm
  if (!bpm) return { z: 0, name: '—', color: '#8a93a3' }
  const p = (bpm / maxHr.value) * 100
  return HR_ZONES.find((zn) => p < zn.hi) || HR_ZONES[HR_ZONES.length - 1]
})
const hrSpark = computed(() => {
  const h = hr.state.history
  if (h.length < 2) return null
  const W = 100,
    H = 40
  const min = Math.min(...h),
    max = Math.max(...h)
  const rng = Math.max(1, max - min)
  const pts = h.map(
    (v, i) =>
      `${((i / (h.length - 1)) * W).toFixed(1)},${(H - 0.1 * H - ((v - min) / rng) * 0.8 * H).toFixed(1)}`,
  )
  return { line: pts.join(' '), area: `M0,${H} L${pts.join(' L')} L${W},${H} Z` }
})

// --- HR workouts: hold a target heart-rate range by nudging belt speed ---
// Own table rather than reusing HR_ZONES: steer targets need a "Light" range below
// fat-burn (47.5–60% — 90–113 bpm at the default 190 max) that the display zones
// don't have, and the top "Max" zone is not a sane steer target.
const HR_TARGETS: HrTarget[] = [
  { id: 'light', name: 'Light', color: '#6ab0ff', loPct: 47.5, hiPct: 60 },
  { id: 'fatburn', name: 'Fat burn', color: '#2ed573', loPct: 60, hiPct: 70 },
  { id: 'cardio', name: 'Cardio', color: '#f5a623', loPct: 70, hiPct: 80 },
  { id: 'hard', name: 'Hard', color: '#ff7f50', loPct: 80, hiPct: 90 },
]
const HR_NUDGE_STEP = 0.3 // km/h per adjustment
const HR_ADJUST_INTERVAL = 20 // seconds between nudges (issue #18 calls for 15–30s)
// Contiguous, non-overlapping bpm ranges: hi is one below the next target's lo
// (Light 90–113, Fat burn 114–132, … at the default 190 max HR).
function hrTargetRange(t: HrTarget) {
  return {
    lo: Math.round((t.loPct / 100) * maxHr.value),
    hi: Math.round((t.hiPct / 100) * maxHr.value) - 1,
  }
}
const hrTarget = ref<HrTarget | null>(null) // active HR_TARGETS entry while the autopilot is steering speed
let lastHrAdjustElapsed = 0
function startHrWorkout(t: HrTarget) {
  active.value = null // mutually exclusive with a weight-loss workout
  hrTarget.value = t
  menuOpen.value = false
  lastHrAdjustElapsed = state.elapsed
  if (state.connected) start()
}
function endHrWorkout() {
  hrTarget.value = null
  stop()
}
// Nudge at most once per HR_ADJUST_INTERVAL, only while the belt is actually moving (so
// this can't fight the countdown-window enforcement in treadmill.js — setSpeed re-arms
// its own ~8s enforce window each call, well inside our >=20s cadence, so the two never
// overlap). setSpeed() itself clamps to SPEED_MIN..SPEED_MAX and snaps to the step grid,
// and state.speed already comes from the phantom-2x-filtered reading — no separate
// filtering needed here.
watch(
  () => [state.elapsed, state.running],
  () => {
    if (!hrTarget.value || !state.running) return
    if (state.elapsed - lastHrAdjustElapsed < HR_ADJUST_INTERVAL) return
    lastHrAdjustElapsed = state.elapsed
    const bpm = hr.state.bpm
    if (!bpm) return // no reading this cycle — try again next interval rather than guess
    const { lo, hi } = hrTargetRange(hrTarget.value)
    if (bpm < lo) setSpeed(state.targetSpeed + HR_NUDGE_STEP)
    else if (bpm > hi) setSpeed(state.targetSpeed - HR_NUDGE_STEP)
  },
)
// HR workout has nothing to steer by once the sensor disconnects.
watch(
  () => hr.state.connected,
  (connected) => {
    if (!connected && hrTarget.value) endHrWorkout()
  },
)

// --- view mode: athletics track loop, or the first-person 3D scenic walk (#51) ---
// Scenic3D pulls in three.js, so it's an async component: the chunk only downloads the
// first time the scenic view is opened — the main bundle stays three-free.
const Scenic3D = defineAsyncComponent(() => import('./Scenic3D.vue'))
const scenicSupported = ref(true)
function scenicUnsupported() {
  // no WebGL: remember it (disables the toggle) and fall back to the track view
  scenicSupported.value = false
  viewMode.value = 'track'
}
const viewMode = ref<'track' | 'scenic'>(
  localStorage.getItem('walkfit.view') === 'scenic' ? 'scenic' : 'track',
)
watch(viewMode, async (v) => {
  localStorage.setItem('walkfit.view', v)
  if (v === 'track') {
    // The track <svg> only exists in the DOM while this view is active (v-if), so its
    // path geometry — needed for the runner marker + progress ring — has to be (re)read
    // whenever it (re)mounts, not just once in onMounted. Without this, loading straight
    // into a persisted "scenic" preference leaves pathLen stuck at 0 forever, even after
    // switching to Track: marker frozen at (0,0), progress ring invisible.
    await nextTick()
    if (trackEl.value) pathLen.value = trackEl.value.getTotalLength()
  }
})

// --- 2D track view: the same 400 m track model as the 3D walk (scenic.ts), top-down ---
// Mapping: 3D (x, z) → SVG (cx + z·k, cy + x·k). Loop paths use exact circular arcs, so
// getTotalLength maps linearly to walked metres and the marker/progress stay true.
const TK = 2.2 // px per metre — fits the 400×260 viewBox
const TCX = 200
const TCY = 130
function svgPt(s: number, o: number) {
  const p = trackPoint(s, o)
  return { x: TCX + p.z * TK, y: TCY + p.x * TK }
}
// closed loop at lateral offset o, starting at s = 0 and following the walking direction
function loopPath(o: number): string {
  const r = (BEND_R + o) * TK
  const hs = (STRAIGHT_M / 2) * TK
  return (
    `M ${TCX + hs} ${TCY + r} L ${TCX - hs} ${TCY + r} ` +
    `A ${r} ${r} 0 0 1 ${TCX - hs} ${TCY - r} ` +
    `L ${TCX + hs} ${TCY - r} A ${r} ${r} 0 0 1 ${TCX + hs} ${TCY + r} Z`
  )
}
const track2d = {
  band: loopPath((TRACK_IN + TRACK_OUT) / 2),
  bandW: (TRACK_OUT - TRACK_IN) * TK,
  laneLines: Array.from({ length: LANES + 1 }, (_, i) => loopPath(TRACK_IN + i * LANE_W)),
  lane1: loopPath(0), // the runner's guide path — lane-1 centreline, same as the 3D camera
  start: { a: svgPt(0, TRACK_IN), b: svgPt(0, TRACK_IN + LANE_W) },
  staggers: laneStaggers().map((st) => ({ a: svgPt(st.s, st.o0), b: svgPt(st.s, st.o1) })),
  signs: distanceSigns().map((sg) => ({ ...svgPt(sg.s, TRACK_OUT + 4.5), label: String(sg.s) })),
}

const trackEl = ref<SVGPathElement | null>(null)
const pathLen = ref(0)
const lapLength = 400 // metres per virtual lap — one athletics-track lap
onMounted(() => {
  if (trackEl.value) pathLen.value = trackEl.value.getTotalLength()
  if (state.supported) connectAuto() // silent reconnect to remembered devices
  handleOAuthRedirects() // no-op unless we just came back from an OAuth page
  // silent weigh-in sync for connected health services (fire-and-forget, like connectAuto)
  for (const p of healthProviders) if (p.state.connected) syncHealth(p)
})
async function connectAuto() {
  await Promise.allSettled([tmAutoConnect(), hr.autoConnect()])
}
const laps = computed(() => Math.floor(state.distance / lapLength))
const lapFraction = computed(() => (state.distance % lapLength) / lapLength)
const marker = computed(() => {
  if (!trackEl.value || !pathLen.value) return { x: 0, y: 0 }
  const p = trackEl.value.getPointAtLength(lapFraction.value * pathLen.value)
  return { x: p.x, y: p.y }
})
const dashOffset = computed(() => pathLen.value * (1 - lapFraction.value))

// --- lap times ---
const lapTimes = ref<number[]>([])
let lapStartElapsed = 0
watch(laps, (n, old) => {
  if (n > old) {
    lapTimes.value.push(state.elapsed - lapStartElapsed)
    lapStartElapsed = state.elapsed
    // two-tone lap chime
    beep(988, 90)
    setTimeout(() => beep(1319, 140), 110)
  } else if (n < old) {
    // stats were reset
    lapTimes.value = []
    lapStartElapsed = 0
  }
})
const lastLap = computed(() => lapTimes.value[lapTimes.value.length - 1] ?? null)
const bestLap = computed(() => (lapTimes.value.length ? Math.min(...lapTimes.value) : null))

// --- live calorie counter ---
// Integrated per-tick from actual speed (via metForSpeed), not a single average-speed
// estimate — accumulates correctly through a workout's varying-speed segments.
const liveKcal = ref(0)
let kcalAccum = 0
let lastKcalElapsed = 0
watch(
  () => state.elapsed,
  (elapsed, prevElapsed) => {
    if (elapsed < prevElapsed) {
      // stats were reset (Reset button, wizard pick, workout start)
      kcalAccum = 0
      lastKcalElapsed = 0
      liveKcal.value = 0
      return
    }
    if (!state.running) return
    const dt = elapsed - lastKcalElapsed
    if (dt <= 0) return
    kcalAccum += metForSpeed(state.speed) * weightKg.value * (dt / 3600)
    lastKcalElapsed = elapsed
    liveKcal.value = Math.round(kcalAccum)
  },
)

// --- session statistics ---
const MIN_SESSION_DISTANCE = 50 // metres — filters out accidental/blip starts
const sessions = ref(loadStatistics())
const statisticsOpen = ref(false)
const weekly = computed(() => weeklyTotals(sessions.value))
const streak = computed(() => currentStreak(sessions.value))
// Daily activity goals for the rings (#43); edits in Settings persist via the watcher.
const goals = reactive(loadGoals())
watch(goals, () => saveGoals({ ...goals }))

// --- daily activity: rings + charts (#43) ---
// Metric hues reuse the app's established identity colors (HR-zone badge, accent):
// kcal green / steps blue / time amber / HR red. Validated on the #171a21 card surface —
// contrast >3:1 and CVD ΔE 81 (target ≥12); they sit above the generic dark lightness
// band by design, matching the rest of the UI rather than a darker chart-only variant.
const METRIC_COLORS = { kcal: '#2ed573', steps: '#6ab0ff', time: '#f5a623', hr: '#ff4757' }
const chartDays = ref(7)
const daily = computed(() => dailyTotals(sessions.value, chartDays.value))
const todayTotals = computed(() => dailyTotals(sessions.value, 1)[0]!)

// Activity rings: outer→inner kcal/steps/time, filling toward the daily goals.
const rings = computed(() => {
  const t = todayTotals.value
  return [
    {
      id: 'kcal',
      label: 'Calories',
      color: METRIC_COLORS.kcal,
      value: Math.round(t.kcal),
      goal: goals.kcal,
      unit: 'kcal',
    },
    {
      id: 'steps',
      label: 'Steps',
      color: METRIC_COLORS.steps,
      value: t.steps,
      goal: goals.steps,
      unit: 'steps',
    },
    {
      id: 'time',
      label: 'Time',
      color: METRIC_COLORS.time,
      value: Math.round(t.duration / 60),
      goal: goals.minutes,
      unit: 'min',
    },
  ].map((r, i) => {
    const radius = 52 - i * 15
    const c = 2 * Math.PI * radius
    const pct = Math.min(r.value / r.goal, 1)
    return { ...r, radius, pct, dash: `${pct * c} ${c}` }
  })
})

const barCharts = computed(() => {
  const days = daily.value
  return [
    {
      id: 'kcal',
      label: 'Calories',
      color: METRIC_COLORS.kcal,
      unit: 'kcal',
      values: days.map((d) => Math.round(d.kcal)),
    },
    {
      id: 'steps',
      label: 'Steps',
      color: METRIC_COLORS.steps,
      unit: 'steps',
      values: days.map((d) => d.steps),
    },
    {
      id: 'time',
      label: 'Activity time',
      color: METRIC_COLORS.time,
      unit: 'min',
      values: days.map((d) => Math.round(d.duration / 60)),
    },
  ].map((m) => ({
    ...m,
    max: Math.max(...m.values, 1),
    total: m.values.reduce((a, b) => a + b, 0),
  }))
})

// Daily HR: min–max span bars + an avg tick, on a shared padded bpm scale.
const hrChart = computed(() => {
  const days = daily.value
  const withHr = days.filter((d) => d.hrMin !== null)
  if (!withHr.length) return null
  const lo = Math.min(...withHr.map((d) => d.hrMin!)) - 5
  const hi = Math.max(...withHr.map((d) => d.hrMax!)) + 5
  const span = hi - lo
  return {
    lo,
    hi,
    bars: days.map((d) =>
      d.hrMin === null
        ? null
        : {
            bottom: ((d.hrMin - lo) / span) * 100,
            height: Math.max(((d.hrMax! - d.hrMin) / span) * 100, 3),
            avg: d.hrAvg === null ? null : ((d.hrAvg - lo) / span) * 100,
            title: `${d.date}: ${d.hrMin}–${d.hrMax} bpm · avg ${d.hrAvg}`,
          },
    ),
  }
})

// Sparse x labels: weekday letters for 7d, day-of-month every 5th for longer ranges.
function dayLabel(dateKey: string, i: number): string {
  const d = new Date(dateKey + 'T00:00:00')
  if (chartDays.value === 7) return 'SMTWTFS'[d.getDay()]!
  return i % 5 === 0 || i === chartDays.value - 1 ? String(d.getDate()) : ''
}
let sessionStart: Date | null = null
let sessionName = 'Free walk'
let hrSum = 0
let hrCount = 0
let hrLo = 0 // session bpm low/high for the daily HR range chart (#43)
let hrHi = 0
watch(
  () => hr.state.bpm,
  (bpm) => {
    if (state.running && bpm > 0) {
      hrSum += bpm
      hrCount += 1
      if (!hrLo || bpm < hrLo) hrLo = bpm
      if (bpm > hrHi) hrHi = bpm
    }
  },
)
watch(
  () => state.running,
  (running, was) => {
    if (running && !was) {
      sessionStart = new Date()
      sessionName = active.value?.name || 'Free walk'
      hrSum = 0
      hrCount = 0
      hrLo = 0
      hrHi = 0
    } else if (!running && was) {
      if (state.distance >= MIN_SESSION_DISTANCE) {
        const session: Session = {
          date: (sessionStart || new Date()).toISOString(),
          distance: Math.round(state.distance),
          duration: Math.round(state.elapsed),
          kcal: liveKcal.value,
          steps: state.steps, // belt's own pedometer count (0 if FW never reported one)
          avgHr: hrCount ? Math.round(hrSum / hrCount) : null,
          ...(hrCount ? { hrMin: hrLo, hrMax: hrHi } : {}),
        }
        sessions.value = addSession(session)
        if (strava.state.connected) stravaPrompt.value = { session, name: sessionName }
      }
      sessionStart = null
    }
  },
)

// --- weight log (issue #16) ---
const weightLog = ref<WeightEntry[]>(loadWeightLog())
const latestWeight = computed(() => weightLog.value[weightLog.value.length - 1] ?? null)
// Delta vs the last weigh-in at least ~30 days before the newest one (falls back to the
// oldest entry when the log is younger than that; null until two entries exist).
const weightDelta = computed(() => {
  const log = weightLog.value
  if (log.length < 2) return null
  const latest = log[log.length - 1]
  const cutoff = new Date(latest.date).getTime() - 30 * 86400000
  let refEntry = log[0]
  for (const e of log) {
    if (new Date(e.date).getTime() <= cutoff) refEntry = e
    else break
  }
  return latest.kg - refEntry.kg
})
// Trend line, x proportional to time (weigh-ins are irregular — index-spacing would lie).
const weightSpark = computed(() => {
  const log = weightLog.value
  if (log.length < 2) return null
  const W = 320,
    H = 80
  const kgs = log.map((e) => e.kg)
  const min = Math.min(...kgs),
    max = Math.max(...kgs)
  const rng = Math.max(0.5, max - min) // floor so a flat log doesn't zoom into noise
  const t0 = new Date(log[0].date).getTime()
  const span = Math.max(1, new Date(log[log.length - 1].date).getTime() - t0)
  const pts = log.map(
    (e) =>
      `${(((new Date(e.date).getTime() - t0) / span) * W).toFixed(1)},${(H - 0.12 * H - ((e.kg - min) / rng) * 0.76 * H).toFixed(1)}`,
  )
  return { line: pts.join(' '), area: `M0,${H} L${pts.join(' L')} L${W},${H} Z`, min, max }
})
const weighInInput = ref<number | null>(null)
function logWeighIn() {
  if (!weighInInput.value) return
  const kg = Math.round(weighInInput.value * 10) / 10
  weightLog.value = addWeighIn({ date: new Date().toISOString(), kg, source: 'manual' })
  weighInInput.value = null
  syncWeightKg()
}
// Newest weigh-in drives the kcal-estimate weight (walkfit.weight persists via the
// weightKg watcher above).
function syncWeightKg() {
  const newest = weightLog.value[weightLog.value.length - 1]
  if (newest) weightKg.value = newest.kg
}
// The Settings weight field doubles as a manual weigh-in. @change fires on commit
// (blur/enter), not per keystroke, so edits don't spam the log.
function weightSettingChanged() {
  if (weightKg.value >= 30 && weightKg.value <= 250)
    weightLog.value = addWeighIn({
      date: new Date().toISOString(),
      kg: weightKg.value,
      source: 'manual',
    })
}

// --- health services (weigh-in sync providers — see health.ts) ---
const healthProviders: HealthProvider[] = [useWithings()]
async function syncHealth(p: HealthProvider) {
  const updated = await syncProvider(p)
  if (updated) {
    weightLog.value = updated
    syncWeightKg()
  }
}
// One ?code&state callback lands here for every OAuth flow (they share the redirect
// URI); each flow claims it only when the state nonce is its own, so probe in turn.
async function handleOAuthRedirects() {
  if (await strava.handleRedirect()) return
  for (const p of healthProviders) if (await p.handleRedirect()) return
}
function fmtSynced(ms: number | null) {
  return ms ? new Date(ms).toLocaleString() : 'never'
}

// --- Strava upload prompt ---
const stravaPrompt = ref<{ session: Session; name: string } | null>(null) // set while the post-walk popup is open
async function uploadToStrava() {
  if (!stravaPrompt.value) return
  const { session, name } = stravaPrompt.value
  try {
    await strava.uploadSession(session, name)
    stravaPrompt.value = null
  } catch {
    // strava.state.error already holds the message; leave the popup open so the
    // user sees it and can retry or dismiss.
  }
}

// --- speed control ---
const speedInput = ref(state.targetSpeed)
watch(
  () => state.targetSpeed,
  (v) => {
    speedInput.value = v
  },
)
function applySpeed() {
  setSpeed(speedInput.value)
}
function bump(delta: number) {
  speedInput.value = Math.min(
    SPEED_MAX,
    Math.max(SPEED_MIN, Math.round((speedInput.value + delta) / SPEED_STEP) * SPEED_STEP),
  )
  setSpeed(speedInput.value)
}

// --- workouts (weight-loss plans + HR-steered) ---
const menuOpen = ref(false)
const workoutTab = ref<'plans' | 'hr'>('plans') // header menu's initial tab
function openWorkoutMenu(tab: 'plans' | 'hr' = 'plans') {
  menuOpen.value = true
  workoutTab.value = tab
}
const active = ref<Workout | null>(null) // weight-loss workout currently running
const activeTl = computed(() => (active.value ? timeline(active.value) : null))
const curSegIndex = computed(() => {
  if (!activeTl.value) return -1
  return activeTl.value.segs.findIndex((s) => state.elapsed >= s.start && state.elapsed < s.end)
})
const curSeg = computed(() =>
  curSegIndex.value >= 0 ? activeTl.value!.segs[curSegIndex.value] : null,
)
const remaining = computed(() =>
  activeTl.value ? Math.max(0, activeTl.value.total - state.elapsed) : 0,
)
const timeToNext = computed(() =>
  curSeg.value ? Math.max(0, curSeg.value.end - state.elapsed) : 0,
)

// Countdown beeps in the last 3 s of a segment, then announce the new speed at the
// switch. Elapsed ticks at ~1 Hz, so track the last-beeped second to fire each once.
let lastCountdown = 0
watch(
  () => Math.ceil(timeToNext.value),
  (s) => {
    if (!active.value || !state.running) return
    if (s >= 1 && s <= 3 && s !== lastCountdown) {
      lastCountdown = s
      beep(s === 1 ? 1175 : 880, 110)
    } else if (s > 3) {
      lastCountdown = 0
    }
  },
)
watch(curSegIndex, (i, old) => {
  if (!active.value || !state.running || i <= 0 || old < 0) return
  speak(`${activeTl.value!.segs[i].speed.toFixed(1)} kilometers per hour`)
})

// Drive the belt through the plan: set the target to the current segment's speed at
// each boundary. The Bluetooth layer enforces it until the belt actually reaches it,
// so the countdown-ignored first write is retried automatically.
watch(
  () => [state.elapsed, state.running, active.value],
  () => {
    if (!active.value) return
    const tl = activeTl.value! // non-null whenever active is set
    if (state.running && state.elapsed >= tl.total) {
      finishWorkout()
      return
    }
    const seg = tl.segs.find((s) => state.elapsed >= s.start && state.elapsed < s.end)
    if (seg && Math.abs(state.targetSpeed - seg.speed) >= 0.05) setSpeed(seg.speed)
  },
)

async function startWorkout(t: Workout) {
  active.value = t
  hrTarget.value = null // mutually exclusive with an HR workout
  resetStats()
  menuOpen.value = false
  setSpeed(t.segments[0].speed) // sets target for the start sequence
  if (state.connected) await start()
}
function endWorkout() {
  active.value = null
  stop()
}
function finishWorkout() {
  const t = active.value
  active.value = null
  stop()
  if (t) {
    speak(`${t.name} complete`)
    alert(`${t.name} complete! ${(state.distance / 1000).toFixed(2)} km walked.`)
  }
}

// --- chart geometry (shared) ---
const CH_W = 320,
  CH_H = 120
const gridLines = [2, 4, 6].map((s) => ({ s, y: CH_H - (s / SPEED_MAX) * CH_H }))

function planPath(t: Workout) {
  const { segs, total } = timeline(t)
  const pts: string[] = []
  for (const s of segs) {
    const x0 = (s.start / total) * CH_W,
      x1 = (s.end / total) * CH_W
    const y = CH_H - (s.speed / SPEED_MAX) * CH_H
    pts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`)
  }
  return { line: pts.join(' '), area: `M0,${CH_H} L${pts.join(' L')} L${CH_W},${CH_H} Z` }
}

const activePlan = computed(() => (active.value ? planPath(active.value) : null))
const progressX = computed(() =>
  activeTl.value ? Math.min(state.elapsed / activeTl.value.total, 1) * CH_W : 0,
)
const actualLine = computed(() => {
  if (!activeTl.value) return ''
  const total = activeTl.value.total
  return state.history
    .map(
      (s, i) =>
        `${((Math.min(i, total) / total) * CH_W).toFixed(1)},${(CH_H - (Math.min(s, SPEED_MAX) / SPEED_MAX) * CH_H).toFixed(1)}`,
    )
    .join(' ')
})

// free-walk chart (no workout active)
const walkPoints = computed(() => {
  const h = state.history
  if (h.length < 2) return []
  return h.map((s, i) => ({
    x: (i / (h.length - 1)) * CH_W,
    y: CH_H - (Math.min(s, SPEED_MAX) / SPEED_MAX) * CH_H,
  }))
})
const walkLine = computed(() =>
  walkPoints.value.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
)
const walkArea = computed(() => {
  const p = walkPoints.value
  if (!p.length) return ''
  return `M0,${CH_H} L${walkLine.value.split(' ').join(' L')} L${CH_W},${CH_H} Z`
})
const peakSpeed = computed(() => (state.history.length ? Math.max(...state.history) : 0))

// --- formatting ---
function mmss(sec: number) {
  sec = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
}
const fmtDist = computed(() =>
  state.distance >= 1000
    ? (state.distance / 1000).toFixed(2) + ' km'
    : Math.round(state.distance) + ' m',
)
const pace = computed(() => {
  if (state.speed <= 0) return '—'
  const s = 3600 / state.speed
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
})
</script>

<template>
  <div class="app">
    <header>
      <div class="brand">
        <span class="dot" :class="{ on: state.connected, run: state.running }"></span>
        <h1>Walk<span>Fit</span></h1>
      </div>
      <!-- live session stats (#46) — real zeros, faded while the belt is idle -->
      <div class="stat-strip" :class="{ idle: !state.running }">
        <div class="sstat">
          <span class="sv">{{ mmss(state.elapsed) }}</span>
          <span class="sk">time</span>
        </div>
        <div class="sstat">
          <span class="sv">{{ fmtDist }}</span>
          <span class="sk">distance</span>
        </div>
        <div class="sstat">
          <span class="sv">{{ liveKcal }}</span>
          <span class="sk">kcal</span>
        </div>
        <div class="sstat speed">
          <span class="sv">{{ state.speed.toFixed(1) }}</span>
          <span class="sk">km/h</span>
        </div>
        <div class="sstat">
          <span class="sv">{{ pace }}</span>
          <span class="sk">min/km</span>
        </div>
      </div>
      <div class="head-actions">
        <button
          v-if="hr.state.connected"
          class="hr-badge"
          :class="{ on: !!hrTarget }"
          :title="hrTarget ? 'HR workout — tap to change' : `${hrZone.name} — tap for HR workout`"
          @click="openWorkoutMenu('hr')"
        >
          <svg
            v-if="hrSpark"
            class="hr-badge-spark"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
          >
            <path class="hr-spark-area" :d="hrSpark.area" :style="{ fill: hrZone.color }" />
            <polyline
              class="hr-spark-line"
              :points="hrSpark.line"
              :style="{ stroke: hrZone.color }"
            />
          </svg>
          <span class="hr-badge-content">♥ {{ hr.state.bpm || '–' }}</span>
        </button>
        <button
          v-if="!state.connected"
          class="btn primary sm"
          :disabled="state.connecting"
          @click="connect"
        >
          {{ state.connecting ? 'Connecting…' : 'Connect' }}
        </button>
        <!-- anchor wrapper: the dropdown panel positions itself relative to this,
             directly under the ☰ button, instead of guessing header height in CSS -->
        <div class="menu-anchor">
          <button class="cog" aria-label="Menu" @click="moreMenuOpen = true">☰</button>

          <!-- click-outside-to-close backdrop, invisible, full-screen, below the panel -->
          <div v-if="moreMenuOpen" class="menu-backdrop" @click="moreMenuOpen = false"></div>
          <div v-if="moreMenuOpen" class="menu-panel">
            <button class="menu-item" @click="menuOpenWorkouts">📋 Workout</button>
            <button class="menu-item" @click="menuOpenStatistics">📈 Statistics</button>
            <button v-if="state.connected" class="menu-item" @click="menuDisconnect">
              🔌 Disconnect
            </button>
            <button class="menu-item" @click="menuOpenSettings">⚙ Settings</button>
          </div>
        </div>
      </div>
    </header>

    <p v-if="!state.secure" class="warn">
      <b>Insecure context.</b> Web Bluetooth needs <code>https://</code> or <code>localhost</code>.
      You’re on <code>{{ origin }}</code> — reopen at <code>http://localhost:5173</code>.
    </p>
    <p v-else-if="!state.hasApi" class="warn">
      Web Bluetooth is disabled. <b>On Linux</b> enable
      <code>chrome://flags/#enable-experimental-web-platform-features</code> → Enabled → relaunch.
    </p>
    <p v-if="state.error" class="warn">{{ state.error }}</p>

    <!-- virtual loop / scenic walk -->
    <section class="track-wrap">
      <div class="view-toggle">
        <button class="view-btn" :class="{ on: viewMode === 'track' }" @click="viewMode = 'track'">
          🏟️ Track
        </button>
        <button
          class="view-btn"
          :class="{ on: viewMode === 'scenic' }"
          :disabled="!scenicSupported"
          :title="scenicSupported ? undefined : 'Needs WebGL'"
          @click="viewMode = 'scenic'"
        >
          🌳 Scenic
        </button>
      </div>

      <svg v-if="viewMode === 'track'" viewBox="0 0 400 260" class="track">
        <!-- top-down render of the same 400 m track model the 3D view walks (scenic.ts):
             six lanes, lane-1 start/finish, staggered starts, 100 m marks -->
        <path class="track-band" :d="track2d.band" :stroke-width="track2d.bandW" />
        <path v-for="(d, i) in track2d.laneLines" :key="`lane-${i}`" class="track-lane" :d="d" />
        <line
          class="startline"
          :x1="track2d.start.a.x"
          :y1="track2d.start.a.y"
          :x2="track2d.start.b.x"
          :y2="track2d.start.b.y"
        />
        <line
          v-for="(st, i) in track2d.staggers"
          :key="`stagger-${i}`"
          class="stagger"
          :x1="st.a.x"
          :y1="st.a.y"
          :x2="st.b.x"
          :y2="st.b.y"
        />
        <text
          v-for="(sg, i) in track2d.signs"
          :key="`sign-${i}`"
          class="track-sign"
          :x="sg.x"
          :y="sg.y"
        >
          {{ sg.label }}
        </text>
        <!-- invisible guide path: the lane-1 centreline the marker + progress follow -->
        <path ref="trackEl" class="track-line" :d="track2d.lane1" />
        <path
          class="track-progress"
          :d="track2d.lane1"
          :stroke-dasharray="pathLen"
          :stroke-dashoffset="dashOffset"
        />
        <g :transform="`translate(${marker.x},${marker.y})`" class="runner">
          <circle class="halo" r="10" />
          <circle class="body" r="6" />
          <text y="1">🏃</text>
        </g>
        <text class="lap-num" x="200" y="120">{{ laps }}</text>
        <text class="lap-label" x="200" y="150">
          {{ laps === 1 ? 'lap' : 'laps' }} · 400 m track
        </text>
        <text v-if="lastLap !== null" class="lap-times" x="200" y="174">
          last {{ mmss(lastLap) }} · best {{ mmss(bestLap!) }}
        </text>
      </svg>

      <!-- scenic walk: side-scrolling street scene. Prop positions come from a "world
           position in metres" model (see groundScenery/clouds), not a repeating tile —
           each fixed-size distance bucket deterministically hashes to whether/what spawns,
           so the scene never repeats obviously but also never jumps between renders. -->
      <div v-else class="scene3d-wrap">
        <Scenic3D
          :distance="state.distance"
          :speed="state.speed"
          @unsupported="scenicUnsupported"
        />
        <!-- lap badge carried over from the track view, overlaid on the 3D canvas -->
        <div class="scene-badge3d">
          <div class="scene-badge3d-main">
            {{ laps }} <span class="scene-badge3d-unit">× 400m</span>
          </div>
          <div class="scene-badge3d-sub">
            {{
              lastLap !== null ? `last ${mmss(lastLap)} · best ${mmss(bestLap!)}` : 'walk to start'
            }}
          </div>
        </div>
      </div>
    </section>

    <section class="action-row" :class="{ disabled: !state.connected }">
      <button class="btn go" :disabled="!state.connected" @click="start">▶ Start</button>
      <button class="btn halt" :disabled="!state.connected" @click="stop">■ Stop</button>
      <button class="btn ghost" @click="resetStats">Reset</button>
    </section>

    <section v-if="!active && !hrTarget" class="controls" :class="{ disabled: !state.connected }">
      <div class="speed-row">
        <button class="btn round" :disabled="!state.connected" @click="bump(-SPEED_STEP)">−</button>
        <div class="speed-set">
          <span class="target">{{ speedInput.toFixed(1) }} <small>km/h target</small></span>
          <input
            v-model.number="speedInput"
            type="range"
            :min="SPEED_MIN"
            :max="SPEED_MAX"
            :step="SPEED_STEP"
            :disabled="!state.connected"
            @change="applySpeed"
          />
        </div>
        <button class="btn round" :disabled="!state.connected" @click="bump(SPEED_STEP)">+</button>
      </div>
    </section>

    <!-- workout banner + profile, OR free-walk speed chart -->
    <section v-if="active" class="chart-wrap">
      <div class="workout-banner">
        <div>
          <span class="workout-name">{{ active.name }}</span>
          <span v-if="curSeg" class="workout-seg">
            seg {{ curSegIndex + 1 }}/{{ activeTl!.segs.length }} · now
            {{ curSeg.speed.toFixed(1) }} km/h · next in {{ mmss(timeToNext) }}
          </span>
        </div>
        <button class="btn halt sm" @click="endWorkout">End</button>
      </div>
      <svg viewBox="0 0 320 120" class="chart">
        <rect class="done" x="0" y="0" :width="progressX" height="120" />
        <g v-for="g in gridLines" :key="g.s">
          <line class="grid" x1="0" :y1="g.y" x2="320" :y2="g.y" />
          <text class="grid-label" x="3" :y="g.y - 3">{{ g.s }}</text>
        </g>
        <path class="area" :d="activePlan!.area" />
        <polyline class="plan" :points="activePlan!.line" />
        <polyline v-if="actualLine" class="actual" :points="actualLine" />
        <line class="cursor" :x1="progressX" y1="0" :x2="progressX" y2="120" />
        <circle class="cursor-dot" :cx="progressX" cy="6" r="4" />
      </svg>
      <div class="workout-foot">
        <span>{{ mmss(state.elapsed) }} / {{ mmss(activeTl!.total) }}</span>
        <span>{{ mmss(remaining) }} left</span>
      </div>
    </section>

    <section v-else class="chart-wrap">
      <div v-if="hrTarget" class="workout-banner">
        <div>
          <span class="workout-name">HR workout · {{ hrTarget.name }}</span>
          <span class="workout-seg">
            target {{ hrTargetRange(hrTarget).lo }}–{{ hrTargetRange(hrTarget).hi }} bpm · now
            {{ hr.state.bpm || '–' }} bpm · {{ state.targetSpeed.toFixed(1) }} km/h
          </span>
        </div>
        <button class="btn halt sm" @click="endHrWorkout">End</button>
      </div>
      <div v-else class="chart-head">
        <span class="chart-title">Speed over time</span>
        <span v-if="peakSpeed" class="chart-peak">peak {{ peakSpeed.toFixed(1) }} km/h</span>
      </div>
      <svg viewBox="0 0 320 120" class="chart">
        <g v-for="g in gridLines" :key="g.s">
          <line class="grid" x1="0" :y1="g.y" x2="320" :y2="g.y" />
          <text class="grid-label" x="3" :y="g.y - 3">{{ g.s }} km/h</text>
        </g>
        <path v-if="walkArea" class="area" :d="walkArea" />
        <polyline v-if="walkLine" class="actual" :points="walkLine" />
      </svg>
      <p v-if="state.history.length < 2" class="chart-empty">Start walking, or pick a workout.</p>
    </section>

    <p v-if="hr.state.error" class="warn">Heart rate: {{ hr.state.error }}</p>

    <!-- controls -->

    <details v-if="debugOn" class="dbg" open>
      <summary>Debug: speed events</summary>
      <p class="dbg-now">
        elapsed {{ mmss(state.elapsed) }} · seg {{ curSegIndex }} · target {{ state.targetSpeed }} ·
        rx {{ state.speed }}
      </p>
      <pre>{{ state.log.join('\n') }}</pre>
    </details>

    <!-- workout menu: weight-loss plans, or HR-steered targets -->
    <div v-if="menuOpen" class="overlay" @click.self="menuOpen = false">
      <div class="sheet">
        <WorkoutPicker
          :workouts="workouts"
          :weight-kg="weightKg"
          :max-hr="maxHr"
          :connected="state.connected"
          :hr-targets="HR_TARGETS"
          :active-hr-target="hrTarget"
          :adjust-interval="HR_ADJUST_INTERVAL"
          :start-tab="workoutTab"
          @start-plan="startWorkout"
          @start-hr="startHrWorkout"
          @stop-hr="endHrWorkout"
          @close="menuOpen = false"
        />
      </div>
    </div>

    <!-- post-walk Strava upload prompt -->
    <div v-if="stravaPrompt" class="overlay" @click.self="stravaPrompt = null">
      <div class="sheet strava-sheet">
        <div class="sheet-head">
          <h2>Upload to Strava?</h2>
          <button class="x" @click="stravaPrompt = null">✕</button>
        </div>
        <div class="detail-tiles">
          <div>
            <span class="v">{{ (stravaPrompt.session.distance / 1000).toFixed(2) }}</span>
            <span class="k">km</span>
          </div>
          <div>
            <span class="v">{{ mmss(stravaPrompt.session.duration) }}</span>
            <span class="k">time</span>
          </div>
          <div>
            <span class="v">{{
              (
                stravaPrompt.session.distance /
                1000 /
                (stravaPrompt.session.duration / 3600)
              ).toFixed(1)
            }}</span>
            <span class="k">km/h avg</span>
          </div>
        </div>
        <p v-if="strava.state.error" class="hint warn-note">{{ strava.state.error }}</p>
        <div class="detail-actions">
          <button class="btn ghost" :disabled="strava.state.uploading" @click="stravaPrompt = null">
            Skip
          </button>
          <button class="btn go" :disabled="strava.state.uploading" @click="uploadToStrava">
            {{ strava.state.uploading ? 'Uploading…' : 'Upload' }}
          </button>
        </div>
      </div>
    </div>

    <!-- session statistics -->
    <div v-if="statisticsOpen" class="overlay" @click.self="statisticsOpen = false">
      <div class="sheet">
        <div class="sheet-head">
          <h2>Statistics</h2>
          <button class="x" @click="statisticsOpen = false">✕</button>
        </div>

        <div v-if="!sessions.length" class="hist-empty">
          <span class="hist-empty-icon">🏃</span>
          <p class="hint">No walks logged yet — finish a walk to see it here.</p>
        </div>

        <div v-else class="hist-body">
          <div class="hist-section">
            <h3>Daily activity</h3>
            <div class="rings-wrap">
              <svg class="rings" viewBox="0 0 120 120" aria-hidden="true">
                <g v-for="r in rings" :key="r.id">
                  <circle class="ring-track" cx="60" cy="60" :r="r.radius" :stroke="r.color" />
                  <circle
                    v-if="r.pct > 0"
                    class="ring-fill"
                    cx="60"
                    cy="60"
                    :r="r.radius"
                    :stroke="r.color"
                    :stroke-dasharray="r.dash"
                    transform="rotate(-90 60 60)"
                  />
                </g>
              </svg>
              <div class="ring-legend">
                <div v-for="r in rings" :key="r.id" class="ring-item">
                  <span class="ring-dot" :style="{ background: r.color }"></span>
                  <span class="ring-label">{{ r.label }}</span>
                  <span class="ring-val"
                    >{{ r.value }}<span class="ring-goal"> / {{ r.goal }} {{ r.unit }}</span
                    ><span v-if="r.pct >= 1" class="ring-done"> ✓</span></span
                  >
                </div>
              </div>
            </div>
          </div>

          <div class="detail-tiles hist-tiles">
            <div>
              <span class="v">{{ streak }}<span class="unit">🔥</span></span>
              <span class="k">day streak</span>
            </div>
            <div>
              <span class="v">{{ sessions.length }}</span>
              <span class="k">{{ sessions.length === 1 ? 'walk' : 'walks' }} total</span>
            </div>
          </div>

          <div class="hist-section">
            <div class="daily-head">
              <h3>Daily detail</h3>
              <div class="range-chips">
                <button
                  v-for="n in [7, 14, 30]"
                  :key="n"
                  class="chip"
                  :class="{ on: chartDays === n }"
                  @click="chartDays = n"
                >
                  {{ n }}d
                </button>
              </div>
            </div>

            <div v-for="m in barCharts" :key="m.id" class="daychart">
              <div class="daychart-head">
                <span class="daychart-label"
                  ><span class="ring-dot" :style="{ background: m.color }"></span
                  >{{ m.label }}</span
                >
                <span class="daychart-total">{{ m.total }} {{ m.unit }}</span>
              </div>
              <div class="bars">
                <div
                  v-for="(v, i) in m.values"
                  :key="i"
                  class="bar-slot"
                  :title="`${daily[i]!.date}: ${v} ${m.unit}`"
                >
                  <div
                    class="bar"
                    :style="
                      v === 0
                        ? { height: '2px', background: '#252b37' }
                        : { height: (v / m.max) * 100 + '%', background: m.color }
                    "
                  ></div>
                </div>
              </div>
              <div class="bar-labels">
                <span v-for="(d, i) in daily" :key="d.date">{{ dayLabel(d.date, i) }}</span>
              </div>
            </div>

            <div class="daychart">
              <div class="daychart-head">
                <span class="daychart-label"
                  ><span class="ring-dot" :style="{ background: METRIC_COLORS.hr }"></span>Heart
                  rate</span
                >
                <span v-if="hrChart" class="daychart-total"
                  >{{ hrChart.lo }}–{{ hrChart.hi }} bpm · ─ avg</span
                >
              </div>
              <template v-if="hrChart">
                <div class="bars hr-bars">
                  <div
                    v-for="(b, i) in hrChart.bars"
                    :key="i"
                    class="bar-slot"
                    :title="b ? b.title : ''"
                  >
                    <template v-if="b">
                      <div
                        class="hr-span"
                        :style="{ bottom: b.bottom + '%', height: b.height + '%' }"
                      ></div>
                      <div v-if="b.avg !== null" class="hr-avg" :style="{ bottom: b.avg + '%' }" />
                    </template>
                  </div>
                </div>
                <div class="bar-labels">
                  <span v-for="(d, i) in daily" :key="d.date">{{ dayLabel(d.date, i) }}</span>
                </div>
              </template>
              <p v-else class="hint chart-empty-hint">
                No heart-rate data in this range — connect a HR sensor during a walk.
              </p>
            </div>
          </div>

          <div class="hist-section">
            <h3>By week</h3>
            <ul class="weeklist">
              <li v-for="w in weekly" :key="w.week">
                <div class="week-head">
                  <span class="week-label">{{ w.week }}</span>
                  <span class="week-meta"
                    >{{ w.sessions }} {{ w.sessions === 1 ? 'walk' : 'walks' }}</span
                  >
                </div>
                <div class="week-stats">
                  <span class="week-stat"
                    ><span class="week-stat-v">{{ (w.distance / 1000).toFixed(1) }}</span
                    ><span class="week-stat-k">km</span></span
                  >
                  <span class="week-stat"
                    ><span class="week-stat-v">{{ mmss(w.duration) }}</span
                    ><span class="week-stat-k">time</span></span
                  >
                  <span class="week-stat"
                    ><span class="week-stat-v">~{{ Math.round(w.kcal) }}</span
                    ><span class="week-stat-k">kcal</span></span
                  >
                </div>
              </li>
            </ul>
          </div>
        </div>

        <div class="hist-section weight-section">
          <h3>Weight</h3>
          <div v-if="latestWeight" class="detail-tiles hist-tiles">
            <div>
              <span class="v">{{ latestWeight.kg.toFixed(1) }}<span class="unit">kg</span></span>
              <span class="k">latest</span>
            </div>
            <div>
              <span class="v"
                >{{
                  weightDelta === null
                    ? '—'
                    : (weightDelta > 0 ? '+' : '') + weightDelta.toFixed(1)
                }}<span v-if="weightDelta !== null" class="unit">kg</span></span
              >
              <span class="k">vs ~30 days</span>
            </div>
          </div>
          <template v-if="weightSpark">
            <svg class="weight-chart" viewBox="0 0 320 80" preserveAspectRatio="none">
              <path class="weight-area" :d="weightSpark.area" />
              <polyline class="weight-line" :points="weightSpark.line" />
            </svg>
            <div class="weight-range">
              {{ weightSpark.min.toFixed(1) }}–{{ weightSpark.max.toFixed(1) }} kg
            </div>
          </template>
          <p v-if="!weightLog.length" class="hint">
            No weigh-ins yet — log one to start the trend.
          </p>
          <div class="set-row weigh-row">
            <span class="set-inline">
              <input
                v-model.number="weighInInput"
                type="number"
                step="0.1"
                min="30"
                max="250"
                :placeholder="String(weightKg)"
                @keyup.enter="logWeighIn"
              />
              <span class="set-unit">kg</span>
            </span>
            <button class="btn go sm" :disabled="!weighInInput" @click="logWeighIn">
              Log weigh-in
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- onboarding wizard -->
    <div v-if="wizardOpen" class="overlay wizard-overlay">
      <div class="wizard">
        <div class="wiz-head">
          <div class="wiz-dots">
            <span v-for="n in 3" :key="n" :class="{ on: wizardStep >= n }"></span>
          </div>
          <button class="x" aria-label="Skip setup" @click="wizardOpen = false">✕</button>
        </div>

        <!-- 1: treadmill -->
        <div v-if="wizardStep === 1" class="wiz-step">
          <div class="wiz-icon">🏃</div>
          <h2>Connect your treadmill</h2>
          <p>Turn the belt on, then connect over Bluetooth.</p>
          <button
            v-if="!state.connected"
            class="btn go wiz-cta"
            :disabled="state.connecting"
            @click="connect"
          >
            {{ state.connecting ? 'Connecting…' : 'Connect treadmill' }}
          </button>
          <p v-else class="wiz-ok">✓ {{ state.deviceName }} connected</p>
          <p v-if="state.error" class="warn">{{ state.error }}</p>
          <div class="wiz-nav">
            <span></span>
            <button class="btn ghost" @click="wizardStep = 2">
              {{ state.connected ? 'Next' : 'Skip' }}
            </button>
          </div>
        </div>

        <!-- 2: heart rate -->
        <div v-else-if="wizardStep === 2" class="wiz-step">
          <div class="wiz-icon">❤️</div>
          <h2>Connect heart rate</h2>
          <p>Optional. Broadcast HR from your Garmin or a chest strap to see live zones.</p>
          <button
            v-if="!hr.state.connected"
            class="btn go wiz-cta"
            :disabled="hr.state.connecting"
            @click="hr.connect"
          >
            {{ hr.state.connecting ? 'Connecting…' : 'Connect sensor' }}
          </button>
          <p v-else class="wiz-ok">✓ {{ hr.state.deviceName }} connected</p>
          <p v-if="hr.state.error" class="warn">{{ hr.state.error }}</p>
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 1">Back</button>
            <button class="btn ghost" @click="wizardStep = 3">
              {{ hr.state.connected ? 'Next' : 'Skip' }}
            </button>
          </div>
        </div>

        <!-- 3: mode -->
        <div v-else-if="wizardStep === 3" class="wiz-step">
          <div class="wiz-icon">🎯</div>
          <h2>What today?</h2>
          <div class="mode-grid">
            <button class="mode-card" @click="wizardWalk">
              <span class="mode-emoji">🚶</span>
              <span class="mode-name">Free walk</span>
              <span class="mode-desc">Set your own pace</span>
            </button>
            <button class="mode-card" @click="wizardStep = 4">
              <span class="mode-emoji">📋</span>
              <span class="mode-name">Workout</span>
              <span class="mode-desc">Weight-loss plan, or HR-steered</span>
            </button>
          </div>
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 2">Back</button>
            <span></span>
          </div>
        </div>

        <!-- 4: pick a workout — same picker the header/HR-badge menu uses -->
        <div v-else class="wiz-step wiz-workout-step">
          <WorkoutPicker
            :workouts="workouts"
            :weight-kg="weightKg"
            :max-hr="maxHr"
            :connected="state.connected"
            :hr-targets="HR_TARGETS"
            :active-hr-target="hrTarget"
            :adjust-interval="HR_ADJUST_INTERVAL"
            :closable="false"
            @start-plan="wizardStartPlan"
            @start-hr="wizardStartHr"
          />
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 3">Back</button>
            <span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- settings -->
    <div v-if="settingsOpen" class="overlay" @click.self="settingsOpen = false">
      <div class="sheet">
        <div class="sheet-head">
          <h2>Settings</h2>
          <button class="x" @click="settingsOpen = false">✕</button>
        </div>
        <div class="settings">
          <h3>Treadmill</h3>
          <div class="set-row">
            <span>{{
              state.connected ? state.deviceName : state.remembered ? 'Remembered' : 'Not connected'
            }}</span>
            <div class="set-actions">
              <button
                v-if="!state.connected"
                class="btn ghost sm"
                :disabled="state.connecting"
                @click="connect"
              >
                {{ state.connecting ? 'Connecting…' : 'Connect' }}
              </button>
              <button v-else class="btn ghost sm" @click="disconnect">Disconnect</button>
              <button v-if="state.remembered" class="btn ghost sm forget" @click="forgetTreadmill">
                Forget
              </button>
            </div>
          </div>

          <h3>Heart rate</h3>
          <div class="set-row">
            <span>{{
              hr.state.connected
                ? hr.state.deviceName
                : hr.state.remembered
                  ? 'Remembered'
                  : 'Not connected'
            }}</span>
            <div class="set-actions">
              <button
                v-if="!hr.state.connected"
                class="btn ghost sm"
                :disabled="hr.state.connecting"
                @click="hr.connect"
              >
                {{ hr.state.connecting ? 'Connecting…' : 'Connect' }}
              </button>
              <button v-else class="btn ghost sm" @click="hr.disconnect">Disconnect</button>
              <button v-if="hr.state.remembered" class="btn ghost sm forget" @click="hr.forget">
                Forget
              </button>
            </div>
          </div>
          <div class="set-row">
            <span>Max HR</span>
            <input v-model.number="maxHr" type="number" min="120" max="220" />
          </div>
          <p class="set-note">
            Fat-burn zone: {{ Math.round(maxHr * 0.6) }}–{{ Math.round(maxHr * 0.7) }} bpm
          </p>
          <div class="set-row">
            <span>Weight</span>
            <span class="set-inline">
              <input
                v-model.number="weightKg"
                type="number"
                min="30"
                max="200"
                @change="weightSettingChanged"
              />
              <span class="set-unit">kg</span>
            </span>
          </div>
          <p class="set-note">Used to estimate calories burned.</p>

          <h3>Daily goals</h3>
          <div class="set-row">
            <span>Calories</span>
            <span class="set-inline">
              <input v-model.number="goals.kcal" type="number" min="50" max="5000" step="50" />
              <span class="set-unit">kcal</span>
            </span>
          </div>
          <div class="set-row">
            <span>Steps</span>
            <input v-model.number="goals.steps" type="number" min="500" max="50000" step="500" />
          </div>
          <div class="set-row">
            <span>Activity time</span>
            <span class="set-inline">
              <input v-model.number="goals.minutes" type="number" min="5" max="300" step="5" />
              <span class="set-unit">min</span>
            </span>
          </div>
          <p class="set-note">The activity rings in Statistics fill toward these.</p>

          <template v-if="strava.state.supported">
            <h3>Strava</h3>
            <div class="set-row">
              <span>{{
                strava.state.connected ? strava.state.athleteName || 'Connected' : 'Not connected'
              }}</span>
              <div class="set-actions">
                <button
                  v-if="!strava.state.connected"
                  class="btn ghost sm"
                  :disabled="strava.state.connecting"
                  @click="strava.connect"
                >
                  {{ strava.state.connecting ? 'Connecting…' : 'Connect' }}
                </button>
                <button v-else class="btn ghost sm" @click="strava.disconnect">Disconnect</button>
              </div>
            </div>
            <p v-if="strava.state.error" class="set-note warn-note">{{ strava.state.error }}</p>
            <p class="set-note">Prompts to upload each finished walk once connected.</p>
          </template>

          <template v-for="p in healthProviders" :key="p.id">
            <template v-if="p.state.supported">
              <h3>{{ p.name }}</h3>
              <div class="set-row">
                <span>{{
                  p.state.connected ? p.state.accountLabel || 'Connected' : 'Not connected'
                }}</span>
                <div class="set-actions">
                  <button
                    v-if="!p.state.connected"
                    class="btn ghost sm"
                    :disabled="p.state.connecting"
                    @click="p.connect"
                  >
                    {{ p.state.connecting ? 'Connecting…' : 'Connect' }}
                  </button>
                  <template v-else>
                    <button class="btn ghost sm" :disabled="p.state.syncing" @click="syncHealth(p)">
                      {{ p.state.syncing ? 'Syncing…' : 'Sync now' }}
                    </button>
                    <button class="btn ghost sm" @click="p.disconnect">Disconnect</button>
                  </template>
                </div>
              </div>
              <p v-if="p.state.error" class="set-note warn-note">{{ p.state.error }}</p>
              <p class="set-note">
                Weigh-ins sync into the weight log{{
                  p.state.connected ? ` — last synced ${fmtSynced(p.state.lastSync)}` : ''
                }}.
              </p>
            </template>
          </template>

          <h3>Sound</h3>
          <label class="set-row toggle">
            <span>Audio cues</span>
            <input v-model="audioOn" type="checkbox" />
          </label>
          <p class="set-note">Countdown beeps + spoken speed at segment changes, lap chime.</p>

          <h3>Advanced</h3>
          <label class="set-row toggle">
            <span>Debug panel</span>
            <input v-model="debugOn" type="checkbox" />
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  max-width: 460px;
  margin: 0 auto;
  padding: 18px 16px 40px;
}
/* Desktop (#48): stop rendering a phone column in the middle of a wide screen.
   Two-column grid — the track/scenic visual keeps roughly its phone-column width on
   the left; the controls and speed chart move beside it. Pure CSS: template order is
   unchanged, and below the breakpoint everything stays the single column. */
@media (min-width: 900px) {
  .app {
    max-width: 980px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    column-gap: 28px;
    align-content: start;
  }
  .app > header,
  .app > .warn,
  .app > .dbg {
    grid-column: 1 / -1;
  }
  .app > .track-wrap {
    grid-column: 1;
    grid-row: span 3; /* action-row + controls + chart on the right */
    align-self: start;
  }
  .app > .action-row,
  .app > .controls,
  .app > .chart-wrap {
    grid-column: 2;
    align-self: start;
  }
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap; /* narrow screens: the stat strip wraps to its own row */
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
h1 {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.5px;
}
h1 span {
  color: var(--accent);
}
.head-actions {
  display: flex;
  gap: 8px;
}
.dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #555;
  transition: 0.3s;
}
.dot.on {
  background: #f5a623;
  box-shadow: 0 0 10px #f5a623;
}
.dot.run {
  background: var(--accent);
  box-shadow: 0 0 12px var(--accent);
}

.warn {
  background: #3a1d1d;
  border: 1px solid #7a2e2e;
  color: #ffb4b4;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  margin: 8px 0;
}
code {
  background: #00000040;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 12px;
}

.track-wrap {
  margin: 6px 0 14px;
}
.track {
  width: 100%;
  display: block;
}
.track-band {
  fill: none;
  stroke: #83392d; /* tartan red; width bound from the lane count so lanes stay true */
}
.track-lane {
  fill: none;
  stroke: rgba(255, 255, 255, 0.25);
  stroke-width: 0.5;
}
/* geometry guide only — the runner marker and progress ring follow it via
   getTotalLength/getPointAtLength, so it never needs to be painted */
.track-line {
  fill: none;
  stroke: none;
}
.track-progress {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2.2; /* stays inside lane 1 (one lane ≈ 2.7 px at this scale) */
  stroke-linecap: round;
  transition: stroke-dashoffset 0.25s linear;
  filter: drop-shadow(0 0 6px rgba(46, 213, 115, 0.5));
}
.startline {
  stroke: #eee;
  stroke-width: 2;
}
.stagger {
  stroke: rgba(255, 255, 255, 0.8);
  stroke-width: 1.2;
}
.track-sign {
  fill: #8a93a3;
  font-size: 9px;
  font-weight: 600;
  text-anchor: middle;
}
.runner text {
  text-anchor: middle;
  font-size: 9px;
}
.runner .halo {
  fill: rgba(46, 213, 115, 0.18);
}
.runner .body {
  fill: var(--accent);
}
.runner {
  transition: transform 0.25s linear;
}
.lap-num {
  text-anchor: middle;
  font-size: 46px;
  font-weight: 800;
  fill: #fff;
}
.lap-label {
  text-anchor: middle;
  font-size: 12px;
  fill: #8a93a3;
  letter-spacing: 0.5px;
}
.lap-times {
  text-anchor: middle;
  font-size: 11px;
  fill: #8a93a3;
  font-variant-numeric: tabular-nums;
}

.view-toggle {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.view-btn {
  flex: 1;
  background: #171a21;
  border: 1px solid #232833;
  color: #8a93a3;
  border-radius: 10px;
  padding: 7px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.view-btn.on {
  color: #e8ecf2;
  border-color: var(--accent);
  background: #1a2420;
}

/* --- 3D scenic (#51): canvas wrapper + overlaid lap badge --- */
.scene3d-wrap {
  position: relative;
}
.scene-badge3d {
  position: absolute;
  top: 8px;
  left: 8px;
  background: rgba(10, 12, 16, 0.72);
  border: 1px solid #232833;
  border-radius: 10px;
  padding: 6px 12px;
  pointer-events: none;
}
.scene-badge3d-main {
  font-size: 14px;
  font-weight: 700;
}
.scene-badge3d-unit {
  color: #8a93a3;
  font-size: 10px;
  font-weight: 500;
}
.scene-badge3d-sub {
  font-size: 10.5px;
  color: #8a93a3;
}

.chart-wrap {
  margin: 0 0 18px;
}
.chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}
.chart-title {
  font-size: 13px;
  font-weight: 600;
  color: #cbd3df;
}
.chart-peak {
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
}
.chart {
  width: 100%;
  display: block;
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 14px;
}
.chart .grid {
  stroke: #232833;
  stroke-width: 1;
}
.chart .grid-label {
  fill: #5b6473;
  font-size: 7px;
}
.chart .area {
  fill: rgba(46, 213, 115, 0.12);
}
.chart .plan {
  fill: none;
  stroke: rgba(46, 213, 115, 0.7);
  stroke-width: 2;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.chart .actual {
  fill: none;
  stroke: #fff;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.chart .done {
  fill: rgba(255, 255, 255, 0.04);
}
.chart .cursor {
  stroke: #f5a623;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
.chart .cursor-dot {
  fill: #f5a623;
}
.chart-empty {
  text-align: center;
  font-size: 12.5px;
  color: #8a93a3;
  margin-top: 8px;
}

.workout-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.workout-name {
  font-weight: 700;
  font-size: 15px;
  display: block;
}
.workout-seg {
  font-size: 12px;
  color: #8a93a3;
}
.workout-foot {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #8a93a3;
  margin-top: 6px;
}

/* --- header live-stat strip (#46) --- */
/* Always its own full-width row under the brand row: the app is a fluid column
   (max 460px), so five chips never fit inline beside brand + actions. */
.stat-strip {
  order: 3;
  flex-basis: 100%;
  display: flex;
  align-items: stretch;
  gap: 6px;
}
.sstat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 10px;
  padding: 5px 4px 4px;
  transition: opacity 0.35s;
}
.sv {
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sstat.speed .sv {
  color: var(--accent);
}
.sk {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8a93a3;
  white-space: nowrap;
}
/* idle: real zeros, faded — the strip never hides, so no layout jump on start */
.stat-strip.idle .sstat {
  opacity: 0.45;
}
/* Desktop (#48): the wide header has room — chips sit inline between brand and actions. */
@media (min-width: 900px) {
  .stat-strip {
    order: 0; /* DOM order: brand · strip · actions */
    flex-basis: auto;
    flex: 1;
    justify-content: center;
    margin: 0 10px;
  }
  .sstat {
    flex: 0 1 96px;
    padding: 5px 10px 4px;
  }
}

.hr-spark-area {
  fill-opacity: 0.14;
}
.hr-spark-line {
  fill: none;
  stroke-width: 2;
  stroke-opacity: 0.55;
  vector-effect: non-scaling-stroke;
}
.dbg {
  margin: 8px 0 18px;
  font-size: 12px;
  color: #8a93a3;
}
.dbg summary {
  cursor: pointer;
}
.dbg-now {
  margin: 6px 0;
  color: #cbd3df;
}
.dbg pre {
  padding: 8px;
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 8px;
  overflow-x: auto;
  font-family: ui-monospace, monospace;
  line-height: 1.5;
}

.cog {
  background: #1b1f27;
  border: 1px solid #2a303c;
  color: #cbd3df;
  border-radius: 10px;
  padding: 5px 11px;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
.hr-badge {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #1b1f27;
  border: 1px solid #2a303c;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 800;
  font-family: inherit;
  cursor: pointer;
}
.hr-badge.on {
  border-color: var(--accent);
}
.hr-badge-spark {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  opacity: 0.4;
}
.hr-badge-content {
  position: relative;
  z-index: 1;
  color: #ff4757;
}
.settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 8px;
}
.settings h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #8a93a3;
  margin-top: 10px;
}
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
}
.set-row input[type='number'] {
  width: 72px;
  background: #12151b;
  border: 1px solid #232833;
  color: #e8ecf2;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 14px;
  text-align: right;
}
.set-inline {
  display: flex;
  align-items: center;
  gap: 6px;
}
.set-unit {
  color: #8a93a3;
  font-size: 13px;
}
.set-row input[type='checkbox'] {
  width: 20px;
  height: 20px;
  accent-color: var(--accent);
}
.set-row.toggle {
  cursor: pointer;
}
.set-note {
  font-size: 12.5px;
  color: #8a93a3;
  padding: 0 2px;
}
.set-actions {
  display: flex;
  gap: 8px;
}
.controls.disabled {
  opacity: 0.55;
}
.speed-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.speed-set {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.target {
  font-weight: 700;
  font-size: 15px;
}
.target small {
  color: #8a93a3;
  font-weight: 400;
  font-size: 12px;
}
input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}
.action-row {
  display: flex;
  gap: 10px;
  margin: 2px 0 16px;
}
.action-row.disabled {
  opacity: 0.55;
}

.hint {
  margin-top: 14px;
  font-size: 12.5px;
  color: #8a93a3;
  line-height: 1.5;
}
.warn-note {
  color: #ff7f50;
}
.strava-sheet {
  max-width: 380px;
}
.strava-sheet .detail-tiles {
  margin: 4px 0 16px;
}

.overlay {
  position: fixed;
  inset: 0;
  background: #000a;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 20;
}
.wizard-overlay {
  align-items: center;
  background: #0b0d12;
  padding: 16px;
}
.menu-anchor {
  position: relative;
}
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}
.menu-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 21;
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 14px;
  padding: 6px;
  min-width: 190px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  background: none;
  border: none;
  color: #e8ecf2;
  padding: 11px 12px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.menu-item:hover {
  background: #1b1f27;
}
.wizard {
  width: 100%;
  max-width: 440px;
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 20px;
  padding: 18px;
  max-height: 92vh;
  overflow-y: auto;
}
.wiz-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}
.wiz-dots {
  display: flex;
  gap: 6px;
}
.wiz-dots span {
  width: 22px;
  height: 5px;
  border-radius: 3px;
  background: #232833;
  transition: 0.2s;
}
.wiz-dots span.on {
  background: var(--accent);
}
.wiz-step {
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: center;
}
.wiz-workout-step {
  text-align: left;
}
.wiz-icon {
  font-size: 46px;
  margin: 8px 0 0;
}
.wiz-step h2 {
  font-size: 22px;
  font-weight: 800;
}
.wiz-step > p {
  color: #8a93a3;
  font-size: 14px;
  line-height: 1.5;
}
.wiz-cta {
  align-self: center;
  padding: 13px 22px;
}
.wiz-ok {
  color: var(--accent);
  font-weight: 700;
}
.wiz-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.wiz-nav .btn {
  min-width: 84px;
}
.mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 6px 0;
}
.mode-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 12px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 16px;
  cursor: pointer;
  color: inherit;
}
.mode-card:hover {
  border-color: var(--accent);
}
.mode-emoji {
  font-size: 34px;
}
.mode-name {
  font-weight: 700;
  font-size: 15px;
}
.mode-desc {
  font-size: 12px;
  color: #8a93a3;
}
.sheet {
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 20px 20px 0 0;
  width: 100%;
  max-width: 460px;
  max-height: 88vh;
  overflow-y: auto;
  padding: 8px 16px 24px;
}
/* Desktop (#48): sheets center as dialogs (instead of bottom-anchored) with more room —
   the statistics charts benefit most. .strava-sheet keeps its tighter width. */
@media (min-width: 900px) {
  .overlay {
    align-items: center;
    padding: 24px;
  }
  .sheet {
    max-width: 640px;
    border-radius: 20px;
    padding: 8px 24px 24px;
  }
  .sheet.strava-sheet {
    max-width: 380px;
  }
}
.sheet-head {
  display: flex;
  align-items: center;
  gap: 10px;
  position: sticky;
  top: 0;
  background: #12151b;
  padding: 10px 0;
}
.sheet-head h2 {
  font-size: 18px;
  font-weight: 800;
  flex: 1;
  text-align: center;
}
.x {
  background: #1b1f27;
  border: none;
  color: #cbd3df;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  font-size: 16px;
  cursor: pointer;
}

.detail-tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.detail-tiles > div {
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 12px;
  padding: 10px;
  text-align: center;
}
.detail-tiles .v {
  display: block;
  font-size: 22px;
  font-weight: 800;
  color: var(--accent);
}
.detail-tiles .k {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8a93a3;
}
/* --- statistics --- */
.hist-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  padding: 48px 16px 36px;
}
.hist-empty-icon {
  font-size: 40px;
  opacity: 0.6;
}
.hist-empty .hint {
  margin-top: 0;
}
.hist-body {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding-top: 4px;
}
.hist-tiles > div {
  padding: 16px 10px;
}
.hist-tiles .v {
  font-size: 26px;
}
.hist-tiles .unit {
  margin-left: 3px;
  font-size: 16px;
  vertical-align: 2px;
}
.hist-section h3 {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #8a93a3;
  margin: 0 0 10px 2px;
}
/* --- daily activity rings --- */
.rings-wrap {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 6px 2px;
}
.rings {
  width: 128px;
  height: 128px;
  flex: none;
}
.ring-track {
  fill: none;
  stroke-width: 10;
  opacity: 0.16;
}
.ring-fill {
  fill: none;
  stroke-width: 10;
  stroke-linecap: round;
  transition: stroke-dasharray 0.4s ease;
}
.ring-legend {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.ring-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
}
.ring-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
  display: inline-block;
  align-self: center;
}
.ring-label {
  color: #8a93a3;
  min-width: 62px;
}
.ring-val {
  font-weight: 700;
}
.ring-goal {
  color: #8a93a3;
  font-weight: 400;
  font-size: 12px;
}
.ring-done {
  color: var(--accent);
}
/* --- daily bar / HR charts --- */
.daily-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.range-chips {
  display: flex;
  gap: 6px;
}
.chip {
  background: #1b1f27;
  border: 1px solid #232833;
  color: #cbd3df;
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
  cursor: pointer;
}
.chip.on {
  background: var(--accent);
  border-color: transparent;
  color: #05210f;
  font-weight: 700;
}
.daychart {
  margin-top: 14px;
}
.daychart-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
  font-size: 13px;
}
.daychart-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #cbd3df;
  font-weight: 600;
}
.daychart-total {
  color: #8a93a3;
  font-size: 12px;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 64px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 10px;
  padding: 6px 6px 0;
  overflow: hidden;
}
.bar-slot {
  flex: 1;
  height: 100%;
  position: relative;
  display: flex;
  align-items: flex-end;
}
.bar {
  width: 100%;
  border-radius: 3px 3px 0 0;
}
.hr-bars {
  height: 90px;
  padding: 6px;
}
.hr-span {
  position: absolute;
  left: 18%;
  width: 64%;
  background: rgba(255, 71, 87, 0.4);
  border: 1px solid #ff4757;
  border-radius: 4px;
}
.hr-avg {
  position: absolute;
  left: 10%;
  width: 80%;
  height: 2px;
  border-radius: 1px;
  background: #e8ecf2;
}
.bar-labels {
  display: flex;
  gap: 2px;
  margin-top: 4px;
  padding: 0 6px;
}
.bar-labels span {
  flex: 1;
  text-align: center;
  font-size: 10px;
  color: #8a93a3;
}
.chart-empty-hint {
  margin: 4px 0 0;
  font-size: 12px;
}
.weeklist {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.weeklist li {
  padding: 14px 16px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 14px;
  transition: border-color 0.15s;
}
.weeklist li:hover {
  border-color: #333a46;
}
.weight-chart {
  display: block;
  width: 100%;
  height: 90px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 14px;
}
.weight-area {
  fill: rgba(46, 213, 115, 0.12);
}
.weight-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
}
.weight-range {
  text-align: right;
  font-size: 11px;
  color: #8a93a3;
  margin-top: 4px;
}
.weight-section {
  /* separate the Weight block from the By-week block above it */
  margin-top: 22px;
}
.weight-section .hist-tiles {
  margin-bottom: 12px;
}
.weigh-row {
  margin-top: 10px;
}
.week-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}
.week-label {
  font-weight: 800;
  font-size: 14px;
  letter-spacing: 0.2px;
}
.week-meta {
  font-size: 12px;
  color: #8a93a3;
}
.week-stats {
  display: flex;
  gap: 10px;
}
.week-stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  background: #12151b;
  border-radius: 8px;
  text-align: center;
}
.week-stat-v {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.week-stat-k {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #8a93a3;
}
.detail-actions {
  display: flex;
  gap: 10px;
}
.detail-actions .btn.ghost {
  flex: 0 0 auto;
}
</style>
