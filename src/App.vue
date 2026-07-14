<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick, watch, defineAsyncComponent } from 'vue'
import { useTreadmill, SPEED_MIN, SPEED_MAX, SPEED_STEP } from './treadmill'
import { useHeartRate } from './heartrate'
import {
  workouts,
  timeline,
  metForSpeed,
  hrTargetRange,
  loadCustomWorkouts,
  saveCustomWorkout,
  deleteCustomWorkout,
} from './workouts'
import type { Workout, HrTarget } from './workouts'
import {
  loadStatistics,
  addSession,
  removeSession,
  loadGoals,
  saveGoals,
  dailyTotals,
} from './statistics'
import type { Session } from './statistics'
import { mmss } from './format'
import {
  trackPoint,
  laneStaggers,
  laneNumbers,
  BREAK_LINE_S,
  relayZoneLines,
  hurdleTicks,
  waterfallPoints,
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
import StatisticsSheet from './StatisticsSheet.vue'
import SettingsSheet from './SettingsSheet.vue'

const {
  state,
  connect,
  autoConnect: tmAutoConnect,
  disconnect,
  forget: forgetTreadmill,
  start,
  stop,
  pause,
  setSpeed,
  resetStats,
} = useTreadmill()
const hr = useHeartRate()
const strava = useStrava()
const origin = window.location.origin

// --- onboarding wizard ---
// The onboarding wizard shows only until it's been completed or dismissed once —
// returning users (and mid-walk reloads) go straight to the main screen (#63).
const wizardOpen = ref(localStorage.getItem('walkfit.setupDone') !== '1')
// After a backup import the persisted state is authoritative — reload rather than
// hand-refreshing every ref (#69).
function reloadApp() {
  window.location.reload()
}
function markSetupDone() {
  localStorage.setItem('walkfit.setupDone', '1')
}
const wizardStep = ref(1) // 1 treadmill · 2 heart rate · 3 mode · 4 pick workout
function wizardWalk() {
  active.value = null
  wizardOpen.value = false
  markSetupDone()
}
// Wizard's own start handlers: same shared start logic as the header-button menu, plus
// closing the wizard (WorkoutPicker itself has no "close" affordance in the wizard step —
// :closable="false" — the wizard's own Back button is the only way out besides picking).
function wizardStartPlan(w: Workout) {
  wizardOpen.value = false
  markSetupDone()
  startWorkout(w)
}
function wizardStartHr(t: HrTarget) {
  wizardOpen.value = false
  markSetupDone()
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
// Target weight (#71): drives the goal line on the trend chart. 0/empty = none.
const goalWeight = ref(Number(localStorage.getItem('walkfit.weight.goal')) || 0)
watch(goalWeight, (v) => localStorage.setItem('walkfit.weight.goal', String(v || 0)))
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
const hrTarget = ref<HrTarget | null>(null) // active HR_TARGETS entry while the autopilot is steering speed
let lastHrAdjustElapsed = 0
function startHrWorkout(t: HrTarget) {
  if (!hr.state.connected) return // nothing to steer by (#63) — the picker disables these too
  finalizeSession() // log an in-progress free walk (≥50 m) instead of wiping it (#55)
  active.value = null // mutually exclusive with a weight-loss workout
  hrTarget.value = t
  resetStats()
  if (state.running) beginSession() // belt already moving — the new session starts now
  menuOpen.value = false
  lastHrAdjustElapsed = state.elapsed
  if (state.connected) start()
}
function endHrWorkout() {
  hrTarget.value = null
  stopWalk()
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
    // stats were reset mid-workout (Reset button): rebase, or no nudge would fire until
    // elapsed re-exceeded the pre-reset value (#55) — same pattern as the kcal watcher
    if (state.elapsed < lastHrAdjustElapsed) lastHrAdjustElapsed = 0
    if (state.elapsed - lastHrAdjustElapsed < HR_ADJUST_INTERVAL) return
    lastHrAdjustElapsed = state.elapsed
    const bpm = hr.state.bpm
    if (!bpm) return // no reading this cycle — try again next interval rather than guess
    const { lo, hi } = hrTargetRange(hrTarget.value, maxHr.value)
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

// --- free-walk target goal (#68): distance or duration, with audio milestones ---
interface WalkGoal {
  type: 'distance' | 'time'
  value: number // metres or seconds
  label: string
}
const GOAL_PRESETS: WalkGoal[] = [
  { type: 'distance', value: 1000, label: '1 km' },
  { type: 'distance', value: 2000, label: '2 km' },
  { type: 'distance', value: 5000, label: '5 km' },
  { type: 'time', value: 20 * 60, label: '20 min' },
  { type: 'time', value: 30 * 60, label: '30 min' },
]
const walkGoal = ref<WalkGoal | null>(null)
let goalAnnounced = 0 // 0 none · 1 halfway · 2 reached
function toggleGoal(g: WalkGoal) {
  walkGoal.value = walkGoal.value === g ? null : g
  goalAnnounced = 0
}
const goalProgress = computed(() => {
  const g = walkGoal.value
  if (!g) return 0
  const t = sessionTotals()
  return Math.min(1, (g.type === 'distance' ? t.distance : t.elapsed) / g.value)
})
watch(goalProgress, (p) => {
  if (!walkGoal.value || !state.running) return
  if (p >= 1 && goalAnnounced < 2) {
    goalAnnounced = 2
    beep(1320, 300)
    speak('Goal reached!')
  } else if (p >= 0.5 && goalAnnounced < 1) {
    goalAnnounced = 1
    speak('Halfway there')
  }
})

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
// --- experimental layouts (#103): 'current' (default) | 'immersive' | 'dashboard' ---
// Prototypes behind a switcher (Settings → Display) so they can be compared on the
// real treadmill without churning the default. Composition only — same components.
const layout = ref(localStorage.getItem('walkfit.layout') || 'current')
watch(layout, (v) => localStorage.setItem('walkfit.layout', v))
// kiosk concept folded into immersive as a big-numbers option
const bigNumbers = ref(localStorage.getItem('walkfit.layout.big') === '1')
watch(bigNumbers, (v) => localStorage.setItem('walkfit.layout.big', v ? '1' : '0'))
// Immersive HUD fades after 5 s untouched while walking; any interaction wakes it.
const hudHidden = ref(false)
let hudTimer: ReturnType<typeof setTimeout> | null = null
function wakeHud() {
  hudHidden.value = false
  if (hudTimer) clearTimeout(hudTimer)
  hudTimer = setTimeout(() => {
    if (layout.value === 'immersive' && state.running) hudHidden.value = true
  }, 5000)
}
// (re)arm the fade when a walk starts in immersive; show the HUD everywhere else
watch(
  () => [layout.value, state.running] as const,
  ([l, running]) => {
    if (l === 'immersive' && running) wakeHud()
    else {
      hudHidden.value = false
      if (hudTimer) clearTimeout(hudTimer)
    }
  },
)

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
// Mapping: 3D (x, z) → SVG (cx + z·k, cy + x·k). Lateral offsets are exaggerated ×TE
// (transit-map style) so the six lanes stay readable at map scale — at true proportion
// the whole band is ~16 px and the lanes vanish. Loop paths use exact circular arcs, so
// getTotalLength maps linearly to walked metres and the marker/progress stay true.
const TK = 2.0 // px per metre along the loop
const TE = 2.5 // lateral lane-width exaggeration
const TCX = 200
const TCY = 130
function svgPt(s: number, o: number) {
  const p = trackPoint(s, o * TE)
  return { x: TCX + p.z * TK, y: TCY + p.x * TK }
}
// closed loop at (exaggerated) lateral offset o, starting at s = 0, walking direction
function loopPath(o: number): string {
  const r = (BEND_R + o * TE) * TK
  const hs = (STRAIGHT_M / 2) * TK
  return (
    `M ${TCX + hs} ${TCY + r} L ${TCX - hs} ${TCY + r} ` +
    `A ${r} ${r} 0 0 1 ${TCX - hs} ${TCY - r} ` +
    `L ${TCX + hs} ${TCY - r} A ${r} ${r} 0 0 1 ${TCX + hs} ${TCY + r} Z`
  )
}
const track2d = {
  band: loopPath((TRACK_IN + TRACK_OUT) / 2),
  bandW: (TRACK_OUT - TRACK_IN) * TE * TK,
  laneW: LANE_W * TE * TK, // one lane in px — sizes the progress stroke
  laneLines: Array.from({ length: LANES + 1 }, (_, i) => loopPath(TRACK_IN + i * LANE_W)),
  lane1: loopPath(0), // the runner's guide path — lane-1 centreline, same as the 3D camera
  // common finish line across all lanes at s = 0, same as the 3D view
  finish: { a: svgPt(0, TRACK_IN), b: svgPt(0, TRACK_OUT) },
  staggers: laneStaggers().map((st) => ({ a: svgPt(st.s, st.o0), b: svgPt(st.s, st.o1) })),
  // painted lane numbers + the green 200 m break line, exactly where the 3D view (and a
  // real track) has them: just past the finish line.
  laneNums: laneNumbers().map((n) => ({ ...svgPt(n.s, n.o), lane: n.lane })),
  breakLine: { a: svgPt(BREAK_LINE_S, TRACK_IN), b: svgPt(BREAK_LINE_S, TRACK_OUT) },
  // relay exchange-zone limits (yellow, per lane), 400 mH ticks (green, on the lane
  // boundaries, drawn along the running line), and the curved 1500 m waterfall start
  relays: relayZoneLines().map((l) => ({ a: svgPt(l.s, l.o0), b: svgPt(l.s, l.o1) })),
  hurdles: hurdleTicks().map((t) => ({ a: svgPt(t.s - 0.9, t.o), b: svgPt(t.s + 0.9, t.o) })),
  waterfall: waterfallPoints()
    .map((p) => {
      const pt = svgPt(p.s, p.o)
      return `${pt.x},${pt.y}`
    })
    .join(' '),
}

const trackEl = ref<SVGPathElement | null>(null)
const pathLen = ref(0)
const lapLength = 400 // metres per virtual lap — one athletics-track lap
// A snapshot from a previous page means the tab closed/reloaded mid-walk: adopt it as
// the open session. If the belt reconnects still running, the running watcher rebases
// and the walk continues seamlessly; otherwise the next session boundary (Start, a
// workout pick, or the sweep below) logs it as a completed walk.
function restoreSnapshot() {
  let snap: SessionSnapshot | null = null
  try {
    snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null')
  } catch {
    /* corrupt — drop it */
  }
  if (!snap) {
    localStorage.removeItem(SNAPSHOT_KEY)
    return
  }
  sessionStart = new Date(snap.date)
  sessionName = snap.name
  carryDistance = snap.distance
  carryElapsed = snap.elapsed
  carryKcal = snap.kcal
  carrySteps = snap.steps
  hrSum = snap.hrSum
  hrCount = snap.hrCount
  hrLo = snap.hrLo
  hrHi = snap.hrHi
  rebaseWatermarks()
  // if the belt hasn't come back running within the auto-reconnect window, close it out
  setTimeout(() => {
    if (sessionStart && !state.running) finalizeSession()
  }, 30_000)
}

onMounted(() => {
  restoreSnapshot()
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
// All-time best 400 m lap (#72): drives the scenic ghost pace target.
const bestLapEver = ref<number | null>(Number(localStorage.getItem('walkfit.bestLap')) || null)
watch(bestLap, (b) => {
  if (b && (!bestLapEver.value || b < bestLapEver.value)) {
    bestLapEver.value = Math.round(b)
    localStorage.setItem('walkfit.bestLap', String(bestLapEver.value))
  }
})
// per-walk weather seed (#72): fixed per mount, deterministic in the scene
const weatherSeed = Date.now() % 100000
// time-of-day override for the 3D view (Settings → Display)
const scenicTime = ref(localStorage.getItem('walkfit.scenic.time') || 'auto')
watch(scenicTime, (v) => localStorage.setItem('walkfit.scenic.time', v))

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
// dashboard-layout widgets (#103)
const dashToday = computed(() => {
  const t = dailyTotals(sessions.value, 1)[0]!
  return [
    {
      label: 'Calories',
      color: '#2ed573',
      pct: Math.min(100, (t.kcal / goals.kcal) * 100),
      text: `${Math.round(t.kcal)} / ${goals.kcal}`,
    },
    {
      label: 'Steps',
      color: '#6ab0ff',
      pct: Math.min(100, (t.steps / goals.steps) * 100),
      text: `${t.steps} / ${goals.steps}`,
    },
    {
      label: 'Time',
      color: '#f5a623',
      pct: Math.min(100, (t.duration / 60 / goals.minutes) * 100),
      text: `${Math.round(t.duration / 60)} / ${goals.minutes} min`,
    },
  ]
})
const dashRecent = computed(() => [...sessions.value].reverse().slice(0, 4))
const statisticsOpen = ref(false)
// Daily activity goals for the rings (#43); edits in Settings persist via the watcher.
const goals = reactive(loadGoals())
watch(goals, () => saveGoals({ ...goals }))

let sessionStart: Date | null = null
let sessionName = 'Free walk'
let hrSum = 0
let hrCount = 0
let hrLo = 0 // session bpm low/high for the daily HR range chart (#43)
let hrHi = 0
// Watermarks (#55): the treadmill counters are cumulative since connect/reset, so a
// session owns the DELTA since it began — not the raw counters. This is what stops a
// second walk from re-logging the first one's distance (Start without Reset), and it
// neutralizes the belt's deceleration bounce after Stop (running briefly flips back on
// while the belt coasts; that phantom "session" is a few metres of delta and falls to
// the 50 m filter instead of re-logging the whole walk).
let baseDistance = 0
let baseElapsed = 0
let baseKcal = 0
let baseSteps = 0
// Carried in from a restored in-progress snapshot (#66): a reload mid-walk loses the
// client-side counters, so the pre-reload totals ride along and finalize adds them.
let carryDistance = 0
let carryElapsed = 0
let carryKcal = 0
let carrySteps = 0
const SNAPSHOT_KEY = 'walkfit.session.inprogress'
interface SessionSnapshot {
  date: string
  name: string
  distance: number
  elapsed: number
  kcal: number
  steps: number
  hrSum: number
  hrCount: number
  hrLo: number
  hrHi: number
}
function sessionTotals() {
  return {
    distance: carryDistance + Math.max(0, state.distance - baseDistance),
    elapsed: carryElapsed + Math.max(0, state.elapsed - baseElapsed),
    kcal: carryKcal + Math.max(0, liveKcal.value - baseKcal),
    steps: carrySteps + Math.max(0, state.steps - baseSteps),
  }
}
let lastSnapshotDistance = -Infinity
function writeSnapshot() {
  if (!sessionStart) return
  const t = sessionTotals()
  const snap: SessionSnapshot = {
    date: sessionStart.toISOString(),
    name: sessionName,
    ...t,
    hrSum,
    hrCount,
    hrLo,
    hrHi,
  }
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
  lastSnapshotDistance = t.distance
}
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
function beginSession() {
  sessionStart = new Date()
  sessionName =
    active.value?.name || (hrTarget.value ? `${hrTarget.value.name} HR workout` : 'Free walk')
  hrSum = 0
  hrCount = 0
  hrLo = 0
  hrHi = 0
  rebaseWatermarks()
  carryDistance = 0
  carryElapsed = 0
  carryKcal = 0
  carrySteps = 0
  lastSnapshotDistance = -Infinity
  goalAnnounced = 0
}
function rebaseWatermarks() {
  baseDistance = state.distance
  baseElapsed = state.elapsed
  baseKcal = liveKcal.value
  baseSteps = state.steps
}
// Log the session-so-far if it covered enough ground, and close it either way. Called
// on the running true→false edge, and by workout starts so an in-progress free walk is
// logged instead of silently wiped by their resetStats().
function finalizeSession() {
  if (!sessionStart) return
  const t = sessionTotals()
  const distance = Math.round(t.distance)
  if (distance >= MIN_SESSION_DISTANCE) {
    const session: Session = {
      date: sessionStart.toISOString(),
      distance,
      duration: Math.round(t.elapsed),
      kcal: Math.round(t.kcal),
      // belt's own pedometer count (0 if FW never reported one)
      steps: Math.round(t.steps),
      avgHr: hrCount ? Math.round(hrSum / hrCount) : null,
      ...(hrCount ? { hrMin: hrLo, hrMax: hrHi } : {}),
    }
    sessions.value = addSession(session)
    if (strava.state.connected) {
      if (stravaAutoUpload.value) {
        // fire-and-forget (#70): success shows a toast; failure falls back to the prompt
        const name = sessionName
        strava
          .uploadSession(session, name)
          .then(() => showToast('Uploaded to Strava ✓'))
          .catch(() => {
            stravaPrompt.value = { session, name }
          })
      } else {
        stravaPrompt.value = { session, name: sessionName }
      }
    }
  }
  sessionStart = null
  localStorage.removeItem(SNAPSHOT_KEY)
}
const pausedWalk = ref(false)
watch(
  () => state.running,
  (running, was) => {
    if (running && !was) {
      pausedWalk.value = false
      // a restored (or paused) session stays open: rebase against the fresh counters
      // and keep accumulating instead of starting a new session (#66)
      if (sessionStart) rebaseWatermarks()
      else beginSession()
    } else if (!running && was) {
      if (pausedWalk.value) {
        // paused, not finished: bank the progress so the resume continues from here,
        // and rebase so the live delta restarts at zero (no double counting)
        const t = sessionTotals()
        carryDistance = t.distance
        carryElapsed = t.elapsed
        carryKcal = t.kcal
        carrySteps = t.steps
        rebaseWatermarks()
        writeSnapshot()
      } else {
        finalizeSession()
      }
    }
  },
)
// Counters were reset mid-session (Reset button, workout start): rebase the watermarks
// so the continuing session isn't undercounted against stale-high bases. Steps rebase
// separately — the belt's own counter also restarts when the belt starts a new workout.
watch(
  () => state.distance,
  (d) => {
    if (d < baseDistance) {
      baseDistance = 0
      baseElapsed = 0
      baseKcal = 0
    }
    // persist the in-progress session roughly every 10 m — a reload/tab close mid-walk
    // then loses at most a few metres instead of the whole session (#66)
    if (sessionStart && sessionTotals().distance - lastSnapshotDistance >= 10) writeSnapshot()
  },
)
watch(
  () => state.steps,
  (s) => {
    if (s < baseSteps) baseSteps = 0
  },
)

// --- weight log (issue #16) ---
const weightLog = ref<WeightEntry[]>(loadWeightLog())
// Manual weigh-in from the statistics sheet (which owns the input; App owns the log).
function handleWeighIn(kg: number) {
  weightLog.value = addWeighIn({ date: new Date().toISOString(), kg, source: 'manual' })
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
  if (weightKg.value < 30 || weightKg.value > 250) return
  // Day-keyed (#63): corrective edits in the same day overwrite one entry instead of
  // polluting the weight trend with a burst of same-day points (the merge keys manual
  // entries on source+date, so an identical date string replaces).
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  weightLog.value = addWeighIn({ date: d.toISOString(), kg: weightKg.value, source: 'manual' })
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

// --- Strava upload prompt ---
const stravaPrompt = ref<{ session: Session; name: string } | null>(null) // set while the post-walk popup is open
// Auto-upload finished sessions instead of prompting (#70) — Settings toggle.
const stravaAutoUpload = ref(localStorage.getItem('walkfit.strava.autoUpload') === '1')
watch(stravaAutoUpload, (v) => localStorage.setItem('walkfit.strava.autoUpload', v ? '1' : '0'))
// tiny transient toast (auto-upload confirmation)
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 4000)
}
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
// user-built plans (#68) — rendered by the picker alongside the presets
const customWorkouts = ref<Workout[]>(loadCustomWorkouts())
function saveCustom(w: Workout) {
  customWorkouts.value = saveCustomWorkout(w)
}
function deleteCustom(id: string) {
  customWorkouts.value = deleteCustomWorkout(id)
}
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

// Free walk from the header Start button (#55): starting fresh from stopped ends any
// lingering unlogged segment and zeroes the counters, so consecutive walks can't
// accumulate into one another. Starting while already running just re-sends start.
// A paused walk resumes instead — Start doubles as Resume (#66).
async function startWalk() {
  if (!state.running && !pausedWalk.value) {
    finalizeSession()
    resetStats()
  }
  pausedWalk.value = false
  await start()
}

// Pause without ending the session (#66): the belt stops but the walk stays open —
// Start resumes it, Stop finalizes it. (FTMS 08 02; device-experimental, see
// treadmill.ts — worst case the belt ignores it and nothing changes.)
async function pauseWalk() {
  pausedWalk.value = true
  await pause()
}

// Stop always finishes the session — including from paused, where there's no
// running→false edge left to fire the finalize watcher.
async function stopWalk() {
  const wasPaused = pausedWalk.value
  pausedWalk.value = false
  await stop()
  if (wasPaused) finalizeSession()
}

async function startWorkout(t: Workout) {
  finalizeSession() // log an in-progress free walk (≥50 m) instead of wiping it (#55)
  active.value = t
  hrTarget.value = null // mutually exclusive with an HR workout
  resetStats()
  if (state.running) beginSession() // belt already moving — the new session starts now
  menuOpen.value = false
  setSpeed(t.segments[0].speed) // sets target for the start sequence
  if (state.connected) await start()
}
function endWorkout() {
  active.value = null
  stopWalk()
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
// immersive workout ribbon (#103): per-segment mini profile bar. Height maps the
// segment speed onto 6-24px; the current segment shows elapsed progress as a fill.
function immSegStyle(sg: { speed: number; start: number; end: number }, i: number) {
  const h = 6 + ((sg.speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 18
  const style: Record<string, string> = {
    flexGrow: String(sg.end - sg.start),
    height: `${h.toFixed(1)}px`,
  }
  if (i === curSegIndex.value) {
    const pct = Math.min(100, ((state.elapsed - sg.start) / (sg.end - sg.start)) * 100)
    style.background = `linear-gradient(90deg, var(--accent) ${pct}%, #2a5a3d ${pct}%)`
  }
  return style
}

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
  <div
    class="app"
    :class="[`layout-${layout}`, { 'hud-hidden': hudHidden, 'hud-big': bigNumbers }]"
    @pointerdown="wakeHud"
    @pointermove="wakeHud"
  >
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
      <!-- quick 2D/3D flip overlaid on the visual; the same toggle lives in Settings -->
      <div class="view-flip">
        <button :class="{ on: viewMode === 'track' }" @click="viewMode = 'track'">2D</button>
        <button
          :class="{ on: viewMode === 'scenic' }"
          :disabled="!scenicSupported"
          :title="scenicSupported ? undefined : 'Needs WebGL'"
          @click="viewMode = 'scenic'"
        >
          3D
        </button>
      </div>
      <svg v-if="viewMode === 'track'" viewBox="0 0 400 260" class="track">
        <!-- top-down render of the same 400 m track model the 3D view walks (scenic.ts):
             six lanes, common finish line, staggered starts -->

        <path class="track-band" :d="track2d.band" :stroke-width="track2d.bandW" />
        <path v-for="(d, i) in track2d.laneLines" :key="`lane-${i}`" class="track-lane" :d="d" />
        <line
          class="startline"
          :x1="track2d.finish.a.x"
          :y1="track2d.finish.a.y"
          :x2="track2d.finish.b.x"
          :y2="track2d.finish.b.y"
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
        <line
          class="breakline"
          :x1="track2d.breakLine.a.x"
          :y1="track2d.breakLine.a.y"
          :x2="track2d.breakLine.b.x"
          :y2="track2d.breakLine.b.y"
        />
        <line
          v-for="(r, i) in track2d.relays"
          :key="`relay-${i}`"
          class="relay-line"
          :x1="r.a.x"
          :y1="r.a.y"
          :x2="r.b.x"
          :y2="r.b.y"
        />
        <line
          v-for="(h, i) in track2d.hurdles"
          :key="`hurdle-${i}`"
          class="hurdle-tick"
          :x1="h.a.x"
          :y1="h.a.y"
          :x2="h.b.x"
          :y2="h.b.y"
        />
        <polyline class="waterfall" :points="track2d.waterfall" />
        <text
          v-for="n in track2d.laneNums"
          :key="`num-${n.lane}`"
          class="lane-num"
          :x="n.x"
          :y="n.y"
        >
          {{ n.lane }}
        </text>
        <!-- invisible guide path: the lane-1 centreline the marker + progress follow -->
        <path ref="trackEl" class="track-line" :d="track2d.lane1" />
        <path
          class="track-progress"
          :d="track2d.lane1"
          :stroke-width="track2d.laneW - 1.6"
          :stroke-dasharray="pathLen"
          :stroke-dashoffset="dashOffset"
        />
        <g :transform="`translate(${marker.x},${marker.y})`" class="runner">
          <circle class="halo" r="12" />
          <circle class="body" r="7" />
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
          :elapsed="state.elapsed"
          :best-lap="bestLapEver"
          :weather-seed="weatherSeed"
          :time-of-day="scenicTime as never"
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
      <button class="btn go" :disabled="!state.connected" @click="startWalk">
        {{ pausedWalk ? '▶ Resume' : '▶ Start' }}
      </button>
      <button
        v-if="state.running"
        class="btn ghost"
        :disabled="!state.connected"
        @click="pauseWalk"
      >
        ❚❚ Pause
      </button>
      <button class="btn halt" :disabled="!state.connected" @click="stopWalk">■ Stop</button>
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
      <!-- free-walk goal (#68): tap to set/clear; announces halfway + reached -->
      <div class="goal-row">
        <span class="goal-label">🎯 Goal</span>
        <button
          v-for="g in GOAL_PRESETS"
          :key="g.label"
          class="goal-chip"
          :class="{ on: walkGoal === g }"
          @click="toggleGoal(g)"
        >
          {{ g.label }}
        </button>
      </div>
      <div v-if="walkGoal" class="goal-progress">
        <div class="goal-bar">
          <div class="goal-fill" :style="{ width: goalProgress * 100 + '%' }"></div>
        </div>
        <span class="goal-pct">{{
          goalProgress >= 1 ? '✓ reached' : Math.round(goalProgress * 100) + '%'
        }}</span>
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
            target {{ hrTargetRange(hrTarget, maxHr).lo }}–{{ hrTargetRange(hrTarget, maxHr).hi }}
            bpm · now
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

    <!-- immersive-only workout ribbon (#103): the chart-wrap is hidden fullscreen,
         so mid-workout state (segments / HR target) gets a compact always-visible strip -->
    <div v-if="layout === 'immersive' && (active || hrTarget)" class="imm-workout">
      <template v-if="active">
        <div class="imm-segs">
          <div
            v-for="(sg, i) in activeTl!.segs"
            :key="i"
            class="imm-seg"
            :class="{ done: i < curSegIndex, cur: i === curSegIndex }"
            :style="immSegStyle(sg, i)"
          ></div>
        </div>
        <div class="imm-meta">
          <span class="imm-name">
            {{ active.name }} · seg {{ curSegIndex + 1 }}/{{ activeTl!.segs.length
            }}<template v-if="curSeg"> · {{ curSeg.speed.toFixed(1) }} km/h</template>
          </span>
          <span class="imm-time">next {{ mmss(timeToNext) }} · {{ mmss(remaining) }} left</span>
          <button class="btn halt sm" @click="endWorkout">End</button>
        </div>
      </template>
      <template v-else>
        <div class="imm-meta">
          <span class="imm-name">
            HR · {{ hrTarget!.name }} · {{ hrTargetRange(hrTarget!, maxHr).lo }}–{{
              hrTargetRange(hrTarget!, maxHr).hi
            }}
            bpm
          </span>
          <span class="imm-time">
            now {{ hr.state.bpm || '–' }} bpm · {{ state.targetSpeed.toFixed(1) }} km/h
          </span>
          <button class="btn halt sm" @click="endHrWorkout">End</button>
        </div>
      </template>
    </div>

    <!-- dashboard-only widgets (#103): today vs goals + recent walks -->
    <section v-if="layout === 'dashboard'" class="dash-widget card-widget">
      <h3>Today</h3>
      <div v-for="m in dashToday" :key="m.label" class="dw-row">
        <span class="dw-label">{{ m.label }}</span>
        <div class="dw-bar">
          <div class="dw-fill" :style="{ width: m.pct + '%', background: m.color }"></div>
        </div>
        <span class="dw-val">{{ m.text }}</span>
      </div>
    </section>
    <section v-if="layout === 'dashboard'" class="dash-widget card-widget">
      <h3>Recent walks</h3>
      <div v-for="w in dashRecent" :key="w.date" class="dw-walk">
        <span>{{ new Date(w.date).toLocaleDateString(undefined, { weekday: 'short' }) }}</span>
        <span class="mutv">{{ (w.distance / 1000).toFixed(2) }} km</span>
        <span class="mutv">{{ mmss(w.duration) }}</span>
        <span class="mutv">~{{ Math.round(w.kcal) }} kcal</span>
      </div>
      <p v-if="!dashRecent.length" class="hint">No walks yet.</p>
    </section>

    <p v-if="hr.state.error" class="warn">Heart rate: {{ hr.state.error }}</p>

    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>

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
          :hr-connected="hr.state.connected"
          :custom-workouts="customWorkouts"
          :start-tab="workoutTab"
          @save-custom="saveCustom"
          @delete-custom="deleteCustom"
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
      <StatisticsSheet
        :sessions="sessions"
        :weight-log="weightLog"
        :goals="goals"
        :weight-kg="weightKg"
        :goal-weight="goalWeight"
        @close="statisticsOpen = false"
        @weigh-in="handleWeighIn"
        @delete-session="(date: string) => (sessions = removeSession(date))"
      />
    </div>

    <!-- onboarding wizard -->
    <div v-if="wizardOpen" class="overlay wizard-overlay">
      <div class="wizard">
        <div class="wiz-head">
          <div class="wiz-dots">
            <span v-for="n in 3" :key="n" :class="{ on: wizardStep >= n }"></span>
          </div>
          <button
            class="x"
            aria-label="Skip setup"
            @click="((wizardOpen = false), markSetupDone())"
          >
            ✕
          </button>
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
            :hr-connected="hr.state.connected"
            :custom-workouts="customWorkouts"
            :closable="false"
            @save-custom="saveCustom"
            @delete-custom="deleteCustom"
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
      <SettingsSheet
        v-model:max-hr="maxHr"
        v-model:weight-kg="weightKg"
        v-model:audio-on="audioOn"
        v-model:debug-on="debugOn"
        v-model:view-mode="viewMode"
        v-model:layout="layout"
        v-model:big-numbers="bigNumbers"
        v-model:goal-kcal="goals.kcal"
        v-model:goal-steps="goals.steps"
        v-model:goal-minutes="goals.minutes"
        v-model:scenic-time="scenicTime"
        v-model:goal-weight="goalWeight"
        v-model:strava-auto-upload="stravaAutoUpload"
        :tm="{ state, connect, disconnect, forget: forgetTreadmill }"
        :hr="hr"
        :strava="strava"
        :providers="healthProviders"
        :scenic-supported="scenicSupported"
        @close="settingsOpen = false"
        @weight-changed="weightSettingChanged"
        @sync-provider="syncHealth"
        @imported="reloadApp"
      />
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
  position: relative; /* anchors the overlaid 2D/3D flip */
}
.view-flip {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  gap: 2px;
  background: rgba(10, 12, 16, 0.72);
  border: 1px solid #232833;
  border-radius: 999px;
  padding: 2px;
}
.view-flip button {
  background: none;
  border: 0;
  color: #8a93a3;
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
}
.view-flip button.on {
  background: var(--accent);
  color: #05210f;
}
.view-flip button:disabled {
  opacity: 0.4;
  cursor: default;
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
  stroke: rgba(255, 255, 255, 0.3);
  stroke-width: 0.8;
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
  /* stroke-width bound in the template: one exaggerated lane minus a margin */
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
.breakline {
  stroke: #3ba55d;
  stroke-width: 1.2;
  stroke-dasharray: 2.5 2;
}
.relay-line {
  stroke: rgba(216, 182, 56, 0.8);
  stroke-width: 0.8;
}
.hurdle-tick {
  stroke: rgba(46, 125, 79, 0.8);
  stroke-width: 0.7;
}
.waterfall {
  fill: none;
  stroke: rgba(240, 244, 249, 0.85);
  stroke-width: 0.9;
}
.lane-num {
  fill: rgba(240, 244, 249, 0.85);
  font-size: 6px;
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
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
.detail-actions {
  display: flex;
  gap: 10px;
}
.detail-actions .btn.ghost {
  flex: 0 0 auto;
}
.goal-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.goal-label {
  font-size: 12px;
  color: #8a93a3;
  margin-right: 2px;
}
.goal-chip {
  background: #1b1f27;
  border: 1px solid #232833;
  color: #cbd3df;
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
  cursor: pointer;
}
.goal-chip.on {
  background: var(--accent);
  border-color: transparent;
  color: #05210f;
  font-weight: 700;
}
.goal-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.goal-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #1b1f27;
  overflow: hidden;
}
.goal-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.3s;
}
.goal-pct {
  font-size: 12px;
  color: #8a93a3;
  font-variant-numeric: tabular-nums;
  min-width: 62px;
  text-align: right;
}
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: #1a2420;
  border: 1px solid var(--accent);
  color: #e8ecf2;
  border-radius: 999px;
  padding: 9px 18px;
  font-size: 13.5px;
  z-index: 40;
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.25s,
    transform 0.25s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
/* --- experimental layouts (#103): behind the walkfit.layout switcher --- */

/* IMMERSIVE: the visual fills the viewport; header stats become a floating HUD and
   the controls a bottom pill; everything fades while walking untouched. */
.app.layout-immersive {
  max-width: none;
  padding: 0;
}
@media (min-width: 900px) {
  .app.layout-immersive {
    display: block; /* cancel the desktop grid */
  }
}
.app.layout-immersive > .track-wrap {
  position: fixed;
  inset: 0;
  margin: 0;
  z-index: 1;
}
.app.layout-immersive .scenic3d,
.app.layout-immersive .track {
  height: 100vh;
  aspect-ratio: auto;
  border-radius: 0;
}
.app.layout-immersive > header {
  position: fixed;
  top: 10px;
  left: 12px;
  right: 12px;
  z-index: 10;
  margin: 0;
  transition: opacity 0.4s;
}
.app.layout-immersive .stat-strip {
  order: 0;
  flex-basis: auto;
  flex: 1;
  justify-content: center;
  margin: 0 10px;
}
.app.layout-immersive .sstat {
  flex: 0 1 110px;
  background: rgba(10, 12, 16, 0.62);
  backdrop-filter: blur(6px);
}
.app.layout-immersive > .warn {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  max-width: 90vw;
}
.app.layout-immersive > .action-row,
.app.layout-immersive > .controls {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  margin: 0;
  background: rgba(10, 12, 16, 0.62);
  backdrop-filter: blur(6px);
  border: 1px solid #232833;
  border-radius: 18px;
  padding: 10px 14px;
  transition: opacity 0.4s;
}
.app.layout-immersive > .controls {
  bottom: 104px;
  width: min(520px, 92vw);
}
/* the header row is the HUD now: the brand gets its own translucent chip so it
   stays readable over the sky; the fullscreen badges drop below the header bar */
.app.layout-immersive > header .brand {
  background: rgba(10, 12, 16, 0.62);
  backdrop-filter: blur(6px);
  border: 1px solid #232833;
  border-radius: 12px;
  padding: 4px 12px;
}
.app.layout-immersive .view-flip {
  top: 64px;
  right: 12px;
}
.app.layout-immersive .scene-badge3d {
  top: 64px;
  left: 12px;
}
.app.layout-immersive > .action-row {
  bottom: 20px;
}
.app.layout-immersive > .controls .goal-row,
.app.layout-immersive > .chart-wrap,
.app.layout-immersive > .dash-widget {
  display: none;
}
/* fade the controls while walking untouched; the top bar and lap badge stay */
.app.layout-immersive.hud-hidden > .action-row,
.app.layout-immersive.hud-hidden > .controls {
  opacity: 0;
  pointer-events: none;
}
/* workout ribbon: compact segment profile + status, never fades (it IS the
   mid-walk information); sits above the controls pill */
.imm-workout {
  display: none;
}
.app.layout-immersive > .imm-workout {
  display: block;
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  /* the speed controls hide during any workout, so the ribbon takes their slot */
  bottom: 104px;
  z-index: 10;
  width: min(560px, 94vw);
  background: rgba(10, 12, 16, 0.62);
  backdrop-filter: blur(6px);
  border: 1px solid #232833;
  border-radius: 14px;
  padding: 10px 14px;
}
.app.layout-immersive.hud-big > .imm-workout {
  bottom: 130px;
}
.imm-segs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 24px;
  margin-bottom: 8px;
}
.imm-seg {
  flex-basis: 0;
  border-radius: 2px 2px 0 0;
  background: #2a3140;
  min-width: 3px;
}
.imm-seg.done {
  background: #2a5a3d;
}
.imm-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.imm-name {
  color: #e8ecf3;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.imm-time {
  color: #8a93a3;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* kiosk fold-in: big numbers for treadmill-distance reading */
.app.layout-immersive.hud-big .sstat .sv {
  font-size: 30px;
}
.app.layout-immersive.hud-big .sstat .sk {
  font-size: 11px;
}
.app.layout-immersive.hud-big > .action-row .btn {
  font-size: 22px;
  padding: 18px 30px;
}
.app.layout-immersive.hud-big > .controls .target {
  font-size: 28px;
}
/* the bigger buttons need more clearance below the speed pill */
.app.layout-immersive.hud-big > .controls {
  bottom: 130px;
}
.app.layout-immersive.hud-big > .warn {
  top: 96px;
}

/* DASHBOARD: desktop widget grid — visual left, chart/controls + today + recent right */
.app.layout-dashboard > .dash-widget {
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 14px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.app.layout-dashboard > .dash-widget h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #8a93a3;
  margin-bottom: 10px;
}
.dw-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 7px 0;
}
.dw-label {
  width: 62px;
  font-size: 13px;
  color: #cbd3df;
}
.dw-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #1b1f27;
  overflow: hidden;
}
.dw-fill {
  height: 100%;
  border-radius: 3px;
}
.dw-val {
  font-size: 12px;
  color: #8a93a3;
  font-variant-numeric: tabular-nums;
  min-width: 86px;
  text-align: right;
}
.dw-walk {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  padding: 6px 0;
  border-bottom: 1px solid #232833;
}
.dw-walk:last-of-type {
  border-bottom: 0;
}
.mutv {
  color: #8a93a3;
  font-variant-numeric: tabular-nums;
}
@media (min-width: 900px) {
  .app.layout-dashboard {
    max-width: 1320px;
    grid-template-columns: 2fr 1fr;
  }
  .app.layout-dashboard > .track-wrap {
    grid-row: span 5;
  }
  .app.layout-dashboard > .dash-widget {
    grid-column: 2;
    align-self: start;
    margin-bottom: 14px;
  }
}
</style>
