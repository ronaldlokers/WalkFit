<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick, watch, defineAsyncComponent } from 'vue'
import { useTreadmill, NO_WEBBT_ERROR, SPEED_MIN, SPEED_MAX, SPEED_STEP } from './treadmill'
import { useHeartRate, NO_WEBBT_HR_ERROR } from './heartrate'
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
import { loadStatistics, addSession, removeSession, loadGoals, saveGoals } from './statistics'
import type { Session } from './statistics'
import { mmss } from './format'
import { t, localeTag } from './i18n'
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
import Logo from './Logo.vue'
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
    // match the UI language so cues get a Dutch voice when available (#26); browsers
    // fall back to another voice if no matching one is installed
    u.lang = localeTag()
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
const HR_ZONES = computed(() => [
  { z: 1, name: t('zone.warmup'), color: '#6ab0ff', hi: 60 },
  { z: 2, name: t('zone.fatburn'), color: '#2ed573', hi: 70 },
  { z: 3, name: t('zone.cardio'), color: '#f5a623', hi: 80 },
  { z: 4, name: t('zone.hard'), color: '#ff7f50', hi: 90 },
  { z: 5, name: t('zone.max'), color: '#ff4757', hi: Infinity },
])
const hrZone = computed(() => {
  const bpm = hr.state.bpm
  if (!bpm) return { z: 0, name: '—', color: '#8a93a3' }
  const p = (bpm / maxHr.value) * 100
  return HR_ZONES.value.find((zn) => p < zn.hi) || HR_ZONES.value[HR_ZONES.value.length - 1]
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
const HR_TARGETS = computed<HrTarget[]>(() => [
  { id: 'light', name: t('target.light'), color: '#6ab0ff', loPct: 47.5, hiPct: 60 },
  { id: 'fatburn', name: t('zone.fatburn'), color: '#2ed573', loPct: 60, hiPct: 70 },
  { id: 'cardio', name: t('zone.cardio'), color: '#f5a623', loPct: 70, hiPct: 80 },
  { id: 'hard', name: t('zone.hard'), color: '#ff7f50', loPct: 80, hiPct: 90 },
])
const HR_NUDGE_STEP = 0.3 // km/h per adjustment
const HR_ADJUST_INTERVAL = 20 // seconds between nudges (issue #18 calls for 15–30s)
const hrTarget = ref<HrTarget | null>(null) // active HR_TARGETS entry while the autopilot is steering speed
// The stored object carries its pick-time locale; look the name up live by id so a
// language switch mid-workout re-renders it (#130).
const hrTargetName = computed(() =>
  hrTarget.value
    ? (HR_TARGETS.value.find((x) => x.id === hrTarget.value!.id)?.name ?? hrTarget.value.name)
    : '',
)
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
  const tot = sessionTotals()
  return Math.min(1, (g.type === 'distance' ? tot.distance : tot.elapsed) / g.value)
})
watch(goalProgress, (p) => {
  if (!walkGoal.value || !state.running) return
  if (p >= 1 && goalAnnounced < 2) {
    goalAnnounced = 2
    beep(1320, 300)
    speak(t('speech.goalReached'))
  } else if (p >= 0.5 && goalAnnounced < 1) {
    goalAnnounced = 1
    speak(t('speech.halfway'))
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
// --- immersive layout (#103): the visual fills the viewport, HUD floats over it ---
// Kiosk concept folded in as a big-numbers option.
const bigNumbers = ref(localStorage.getItem('walkfit.layout.big') === '1')
watch(bigNumbers, (v) => localStorage.setItem('walkfit.layout.big', v ? '1' : '0'))
// Immersive HUD fades after 5 s untouched while walking; any interaction wakes it.
const hudHidden = ref(false)
let hudTimer: ReturnType<typeof setTimeout> | null = null
function wakeHud() {
  hudHidden.value = false
  if (hudTimer) clearTimeout(hudTimer)
  hudTimer = setTimeout(() => {
    if (state.running) hudHidden.value = true
  }, 5000)
}
// (re)arm the fade when a walk starts; show the HUD while stopped
watch(
  () => state.running,
  (running) => {
    if (running) wakeHud()
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
    if (sessionStart && !state.running && !pausedWalk.value) finalizeSession()
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
  const tot = sessionTotals()
  const snap: SessionSnapshot = {
    date: sessionStart.toISOString(),
    name: sessionName,
    ...tot,
    hrSum,
    hrCount,
    hrLo,
    hrHi,
  }
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
  lastSnapshotDistance = tot.distance
}
// Range: track every reading so brief peaks/dips aren't missed.
watch(
  () => hr.state.bpm,
  (bpm) => {
    if (state.running && bpm > 0) {
      if (!hrLo || bpm < hrLo) hrLo = bpm
      if (bpm > hrHi) hrHi = bpm
    }
  },
)
// Average: sample on the ~1 Hz elapsed tick, NOT on bpm change — a change-triggered
// watcher weights volatile periods (20 min steady at 115 was ONE sample) (#132).
watch(
  () => state.elapsed,
  () => {
    const bpm = hr.state.bpm
    if (state.running && bpm > 0) {
      hrSum += bpm
      hrCount += 1
    }
  },
)
function beginSession() {
  pausedWalk.value = false // a genuinely new session is never paused (#128)
  sessionStart = new Date()
  sessionName =
    active.value?.name ||
    (hrTarget.value ? t('session.hrWorkout', { name: hrTarget.value.name }) : t('session.freeWalk'))
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
  const tot = sessionTotals()
  const distance = Math.round(tot.distance)
  if (distance >= MIN_SESSION_DISTANCE) {
    const session: Session = {
      date: sessionStart.toISOString(),
      distance,
      duration: Math.round(tot.elapsed),
      kcal: Math.round(tot.kcal),
      // belt's own pedometer count (0 if FW never reported one)
      steps: Math.round(tot.steps),
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
          .then(() => showToast(t('strava.uploaded')))
          .catch(() => {
            offerStravaPrompt({ session, name })
          })
      } else {
        offerStravaPrompt({ session, name: sessionName })
      }
    }
  }
  sessionStart = null
  localStorage.removeItem(SNAPSHOT_KEY)
}
// --- screen wake lock (#19): keep the display on while the belt runs ---
// Chromium-only is fine (Web Bluetooth already requires it). The UA auto-releases
// the lock when the tab hides; re-acquire on return if the walk is still going.
let wakeLock: WakeLockSentinel | null = null
// The walk can end while a request is still in flight (the deceleration bounce makes
// a brief running=true realistic) — releasing before the await resolves would leak
// the sentinel and keep the screen awake forever. Track intent and re-check it after
// the await (#133).
let wakeLockWanted = false
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return
  wakeLockWanted = true
  try {
    const sentinel = await navigator.wakeLock.request('screen')
    if (wakeLockWanted && !wakeLock) wakeLock = sentinel
    else sentinel.release().catch(() => {})
  } catch {
    // low battery or platform refusal — walking works fine without it
  }
}
function releaseWakeLock() {
  wakeLockWanted = false
  wakeLock?.release().catch(() => {})
  wakeLock = null
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) acquireWakeLock()
})
watch(
  () => state.running,
  (running) => {
    if (running) acquireWakeLock()
    else releaseWakeLock()
  },
)

const pausedWalk = ref(false)
watch(
  () => state.running,
  (running, was) => {
    if (running && !was) {
      // NOTE: pausedWalk is NOT cleared here. The belt's deceleration bounce fires a
      // phantom running=true right after Pause; clearing the flag on that edge turned
      // Pause into Stop (the following staleness stop finalized the session) (#128).
      // Only explicit user actions clear it: Start (resume), Stop, or a new session
      // beginning (beginSession below).
      // a restored (or paused) session stays open: rebase against the fresh counters
      // and keep accumulating instead of starting a new session (#66)
      if (sessionStart) rebaseWatermarks()
      else beginSession()
    } else if (!running && was) {
      if (pausedWalk.value) {
        // paused, not finished: bank the progress so the resume continues from here,
        // and rebase so the live delta restarts at zero (no double counting)
        const tot = sessionTotals()
        carryDistance = tot.distance
        carryElapsed = tot.elapsed
        carryKcal = tot.kcal
        carrySteps = tot.steps
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
const stravaPrompt = ref<{ session: Session; name: string } | null>(null)
// A second finished walk must not clobber a still-open prompt (#140): later prompts
// queue and surface when the current one is dismissed.
const stravaQueue: NonNullable<typeof stravaPrompt.value>[] = []
function offerStravaPrompt(p: NonNullable<typeof stravaPrompt.value>) {
  if (stravaPrompt.value) stravaQueue.push(p)
  else stravaPrompt.value = p
}
function dismissStravaPrompt() {
  stravaPrompt.value = stravaQueue.shift() ?? null
} // set while the post-walk popup is open
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
    dismissStravaPrompt()
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
const nextSeg = computed(() =>
  activeTl.value && curSegIndex.value >= 0
    ? (activeTl.value.segs[curSegIndex.value + 1] ?? null)
    : null,
)
// 0..1 progress through the current segment — drives the ribbon's countdown ring
const segProgress = computed(() => {
  const sg = curSeg.value
  if (!sg) return 0
  return Math.min(1, Math.max(0, (state.elapsed - sg.start) / (sg.end - sg.start)))
})
const remaining = computed(() =>
  activeTl.value ? Math.max(0, activeTl.value.total - state.elapsed) : 0,
)
const timeToNext = computed(() =>
  curSeg.value ? Math.max(0, curSeg.value.end - state.elapsed) : 0,
)

// Countdown beeps in the last 3 s of a segment, then announce the new speed at the
// switch. Elapsed ticks at ~1 Hz, so track the last-beeped second to fire each once.
// At 5 s a spoken heads-up names the upcoming change (#110) so a jump never surprises.
let lastCountdown = 0
let warnedSeg = -1
watch(
  () => Math.ceil(timeToNext.value),
  (s) => {
    if (!active.value || !state.running) return
    if (s === 5 && curSeg.value && nextSeg.value && warnedSeg !== curSegIndex.value) {
      warnedSeg = curSegIndex.value
      const delta = nextSeg.value.speed - curSeg.value.speed
      if (Math.abs(delta) >= 0.05) {
        speak(
          t(delta > 0 ? 'speech.speedUp' : 'speech.slowDown', {
            v: nextSeg.value.speed.toFixed(1),
          }),
        )
      }
    }
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
  speak(t('speech.speed', { v: activeTl.value!.segs[i].speed.toFixed(1) }))
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
  // fresh audio-cue state: without this, a plan ended during segment N leaves
  // warnedSeg pointing at N and the next plan's segment-N 5s warning is skipped (#131)
  warnedSeg = -1
  lastCountdown = 0
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
  const w = active.value
  active.value = null
  stop()
  if (w) {
    speak(t('speech.complete', { name: w.name }))
    alert(t('workout.completeAlert', { name: w.name, km: (state.distance / 1000).toFixed(2) }))
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

// Composable error strings are English sentinels (protocol layer is framework-free);
// map the known ones to translations, pass anything else through raw (#140).
const tmError = computed(() => (state.error === NO_WEBBT_ERROR ? t('warn.noWebBtTm') : state.error))
const hrError = computed(() =>
  hr.state.error === NO_WEBBT_HR_ERROR ? t('warn.noWebBtHr') : hr.state.error,
)

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
    class="app layout-immersive"
    :class="{ 'hud-hidden': hudHidden, 'hud-big': bigNumbers }"
    @pointerdown="wakeHud"
    @pointermove="wakeHud"
  >
    <header>
      <div class="brand">
        <h1><Logo /></h1>
      </div>
      <!-- live session stats (#46) — real zeros, faded while the belt is idle -->
      <div class="stat-strip" :class="{ idle: !state.running }">
        <div class="sstat">
          <span class="sv">{{ mmss(state.elapsed) }}</span>
          <span class="sk">{{ t('stat.time') }}</span>
        </div>
        <div class="sstat">
          <span class="sv">{{ fmtDist }}</span>
          <span class="sk">{{ t('stat.distance') }}</span>
        </div>
        <div class="sstat">
          <span class="sv">{{ liveKcal }}</span>
          <span class="sk">{{ t('stat.kcal') }}</span>
        </div>
        <div class="sstat">
          <span class="sv">{{ pace }}</span>
          <span class="sk">{{ t('stat.pace') }}</span>
        </div>
        <!-- the HR badge rides the pill row (align-items: stretch keeps heights equal) -->
        <button
          v-if="hr.state.connected"
          class="hr-badge"
          :class="{ on: !!hrTarget }"
          :title="hrTarget ? t('hr.tapChange') : t('hr.tapStart', { zone: hrZone.name })"
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
          <span class="hr-badge-content">
            <span class="sv">♥ {{ hr.state.bpm || '–' }}</span>
            <span
              v-if="hrZone.z"
              class="hr-zone-tag"
              :class="{ fatburn: hrZone.z === 2 }"
              :style="{ color: hrZone.color }"
              >Z{{ hrZone.z }} {{ hrZone.name }}</span
            >
          </span>
        </button>
      </div>
      <div class="head-actions">
        <button
          v-if="!state.connected"
          class="btn primary sm"
          :disabled="state.connecting"
          @click="connect"
        >
          {{ state.connecting ? t('header.connecting') : t('header.connect') }}
        </button>
        <!-- anchor wrapper: the dropdown panel positions itself relative to this,
             directly under the ☰ button, instead of guessing header height in CSS -->
        <div class="menu-anchor">
          <button class="cog" :aria-label="t('menu.label')" @click="moreMenuOpen = true">☰</button>

          <!-- click-outside-to-close backdrop, invisible, full-screen, below the panel -->
          <div v-if="moreMenuOpen" class="menu-backdrop" @click="moreMenuOpen = false"></div>
          <div v-if="moreMenuOpen" class="menu-panel">
            <button class="menu-item" @click="menuOpenWorkouts">{{ t('menu.workout') }}</button>
            <button class="menu-item" @click="menuOpenStatistics">
              {{ t('menu.statistics') }}
            </button>
            <button v-if="state.connected" class="menu-item" @click="menuDisconnect">
              {{ t('menu.disconnect') }}
            </button>
            <button class="menu-item" @click="menuOpenSettings">{{ t('menu.settings') }}</button>
          </div>
        </div>
      </div>
    </header>

    <p v-if="!state.secure" class="warn">
      <b>{{ t('warn.insecureTitle') }}</b> {{ t('warn.insecure', { origin }) }}
    </p>
    <p v-else-if="!state.hasApi" class="warn">{{ t('warn.noApi') }}</p>
    <p v-if="state.error" class="warn">{{ tmError }}</p>

    <!-- virtual loop / scenic walk: the 2D ring floats as a centred card ('flat'),
         the 3D scenic walk fills the viewport -->
    <section class="track-wrap" :class="{ flat: viewMode === 'track' }">
      <!-- quick 2D/3D flip overlaid on the visual; the same toggle lives in Settings -->
      <div class="view-flip">
        <button :class="{ on: viewMode === 'track' }" @click="viewMode = 'track'">2D</button>
        <button
          :class="{ on: viewMode === 'scenic' }"
          :disabled="!scenicSupported"
          :title="scenicSupported ? undefined : t('settings.needsWebgl')"
          @click="viewMode = 'scenic'"
        >
          3D
        </button>
      </div>
      <svg v-if="viewMode === 'track'" viewBox="0 0 400 260" class="track">
        <!-- top-down render of the same 400 m track model the 3D view walks (scenic.ts):
             six lanes, common finish line, staggered starts -->

        <path class="track-glow" :d="track2d.band" :stroke-width="track2d.bandW + 16" />
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
          {{ laps === 1 ? t('track.lap') : t('track.laps') }} {{ t('track.suffix') }}
        </text>
        <text v-if="lastLap !== null" class="lap-times" x="200" y="174">
          {{ t('track.lastBest', { last: mmss(lastLap), best: mmss(bestLap!) }) }}
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
      </div>
    </section>

    <section class="action-row" :class="{ disabled: !state.connected }">
      <button class="btn go" :disabled="!state.connected" @click="startWalk">
        {{ pausedWalk ? t('actions.resume') : t('actions.start') }}
      </button>
      <button
        v-if="state.running"
        class="btn ghost"
        :disabled="!state.connected"
        @click="pauseWalk"
      >
        {{ t('actions.pause') }}
      </button>
      <button class="btn halt" :disabled="!state.connected" @click="stopWalk">
        {{ t('actions.stop') }}
      </button>
      <button class="btn ghost" @click="resetStats">{{ t('actions.reset') }}</button>
    </section>

    <section v-if="!active && !hrTarget" class="controls" :class="{ disabled: !state.connected }">
      <div class="speed-row">
        <button class="btn round" :disabled="!state.connected" @click="bump(-SPEED_STEP)">−</button>
        <div class="speed-set">
          <span class="target"
            >{{ speedInput.toFixed(1) }} <small>{{ t('controls.target') }}</small></span
          >
          <input
            v-model.number="speedInput"
            type="range"
            :min="SPEED_MIN"
            :max="SPEED_MAX"
            :step="SPEED_STEP"
            :disabled="!state.connected"
            :style="{
              '--slider-fill': ((speedInput - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100 + '%',
            }"
            @change="applySpeed"
          />
        </div>
        <button class="btn round" :disabled="!state.connected" @click="bump(SPEED_STEP)">+</button>
      </div>
      <!-- free-walk goal (#68): tap to set/clear; announces halfway + reached -->
      <div class="goal-row">
        <span class="goal-label">{{ t('goal.label') }}</span>
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
          goalProgress >= 1 ? t('goal.reached') : Math.round(goalProgress * 100) + '%'
        }}</span>
      </div>
    </section>

    <!-- workout banner + profile, OR free-walk speed chart -->
    <section v-if="active" class="chart-wrap">
      <div class="workout-banner">
        <div>
          <span class="workout-name">{{ active.name }}</span>
          <span v-if="curSeg" class="workout-seg">
            {{ t('workout.seg', { n: curSegIndex + 1, total: activeTl!.segs.length }) }} ·
            {{ t('workout.now') }} {{ curSeg.speed.toFixed(1) }} km/h ·
            {{ t('workout.nextIn', { t: mmss(timeToNext) }) }}
          </span>
        </div>
        <button class="btn halt sm" @click="endWorkout">{{ t('workout.end') }}</button>
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
        <span>{{ t('workout.left', { t: mmss(remaining) }) }}</span>
      </div>
    </section>

    <section v-else class="chart-wrap">
      <div v-if="hrTarget" class="workout-banner">
        <div>
          <span class="workout-name">{{ t('workout.hrTitle', { name: hrTargetName }) }}</span>
          <span class="workout-seg">
            {{
              t('workout.hrStatus', {
                lo: hrTargetRange(hrTarget, maxHr).lo,
                hi: hrTargetRange(hrTarget, maxHr).hi,
                bpm: hr.state.bpm || '–',
                speed: state.targetSpeed.toFixed(1),
              })
            }}
          </span>
        </div>
        <button class="btn halt sm" @click="endHrWorkout">{{ t('workout.end') }}</button>
      </div>
      <div v-else class="chart-head">
        <span class="chart-title">{{ t('chart.speedOverTime') }}</span>
        <span v-if="peakSpeed" class="chart-peak">{{
          t('chart.peak', { v: peakSpeed.toFixed(1) })
        }}</span>
      </div>
      <svg viewBox="0 0 320 120" class="chart">
        <g v-for="g in gridLines" :key="g.s">
          <line class="grid" x1="0" :y1="g.y" x2="320" :y2="g.y" />
          <text class="grid-label" x="3" :y="g.y - 3">{{ g.s }} km/h</text>
        </g>
        <path v-if="walkArea" class="area" :d="walkArea" />
        <polyline v-if="walkLine" class="actual" :points="walkLine" />
      </svg>
      <p v-if="state.history.length < 2" class="chart-empty">{{ t('chart.empty') }}</p>
    </section>

    <!-- immersive-only workout ribbon (#103): the chart-wrap is hidden fullscreen,
         so mid-workout state (segments / HR target) gets a compact always-visible strip -->
    <div v-if="active || hrTarget" class="imm-workout">
      <template v-if="active">
        <div class="imm-row">
          <!-- hero countdown: time left in the current segment, ring = segment progress -->
          <div class="imm-ring">
            <svg viewBox="0 0 72 72">
              <circle class="imm-ring-track" cx="36" cy="36" r="31" />
              <circle
                class="imm-ring-fill"
                cx="36"
                cy="36"
                r="31"
                :stroke-dasharray="`${(segProgress * 194.8).toFixed(1)} 194.8`"
              />
            </svg>
            <span class="imm-ring-val">{{ mmss(timeToNext) }}</span>
          </div>
          <div class="imm-mid">
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
                {{ active.name }} ·
                {{ t('workout.seg', { n: curSegIndex + 1, total: activeTl!.segs.length }) }}
              </span>
              <span class="imm-time">{{ t('workout.left', { t: mmss(remaining) }) }}</span>
            </div>
          </div>
          <!-- now → next speeds (#110): see the change coming before the belt moves -->
          <div class="imm-nownext">
            <div class="imm-now">
              <span class="imm-nn-k">{{ t('workout.now') }}</span>
              <span class="imm-nn-v">{{ curSeg?.speed.toFixed(1) ?? '–' }}</span>
            </div>
            <span class="imm-nn-arrow">›</span>
            <div class="imm-next">
              <span class="imm-nn-k">{{ t('workout.next') }}</span>
              <span class="imm-nn-v">{{ nextSeg ? nextSeg.speed.toFixed(1) : '✓' }}</span>
            </div>
          </div>
          <button class="btn halt sm" @click="endWorkout">{{ t('workout.end') }}</button>
        </div>
      </template>
      <template v-else>
        <div class="imm-meta">
          <span class="imm-name">
            HR · {{ hrTargetName }} · {{ hrTargetRange(hrTarget!, maxHr).lo }}–{{
              hrTargetRange(hrTarget!, maxHr).hi
            }}
            bpm
          </span>
          <span class="imm-time">
            {{ t('workout.now') }} {{ hr.state.bpm || '–' }} bpm ·
            {{ state.targetSpeed.toFixed(1) }} km/h
          </span>
          <button class="btn halt sm" @click="endHrWorkout">{{ t('workout.end') }}</button>
        </div>
      </template>
    </div>

    <p v-if="hr.state.error" class="warn">{{ t('warn.hrPrefix', { error: hrError }) }}</p>

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
    <div v-if="stravaPrompt" class="overlay" @click.self="dismissStravaPrompt">
      <div class="sheet strava-sheet">
        <div class="sheet-head">
          <h2>{{ t('strava.uploadTitle') }}</h2>
          <button class="x" @click="dismissStravaPrompt">✕</button>
        </div>
        <div class="detail-tiles">
          <div>
            <span class="v">{{ (stravaPrompt.session.distance / 1000).toFixed(2) }}</span>
            <span class="k">{{ t('strava.km') }}</span>
          </div>
          <div>
            <span class="v">{{ mmss(stravaPrompt.session.duration) }}</span>
            <span class="k">{{ t('strava.time') }}</span>
          </div>
          <div>
            <span class="v">{{
              (
                stravaPrompt.session.distance /
                1000 /
                (stravaPrompt.session.duration / 3600)
              ).toFixed(1)
            }}</span>
            <span class="k">{{ t('strava.avg') }}</span>
          </div>
        </div>
        <p v-if="strava.state.error" class="hint warn-note">{{ strava.state.error }}</p>
        <div class="detail-actions">
          <button class="btn ghost" :disabled="strava.state.uploading" @click="dismissStravaPrompt">
            {{ t('strava.skip') }}
          </button>
          <button class="btn go" :disabled="strava.state.uploading" @click="uploadToStrava">
            {{ strava.state.uploading ? t('strava.uploading') : t('strava.upload') }}
          </button>
        </div>
      </div>
    </div>

    <!-- session statistics — full-page dashboard (#115), no overlay chrome needed -->
    <div v-if="statisticsOpen">
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
            :aria-label="t('wizard.skipSetup')"
            @click="((wizardOpen = false), markSetupDone())"
          >
            ✕
          </button>
        </div>

        <!-- 1: treadmill -->
        <div v-if="wizardStep === 1" class="wiz-step">
          <div class="wiz-icon">🏃</div>
          <h2>{{ t('wizard.tmTitle') }}</h2>
          <p>{{ t('wizard.tmBody') }}</p>
          <button
            v-if="!state.connected"
            class="btn go wiz-cta"
            :disabled="state.connecting"
            @click="connect"
          >
            {{ state.connecting ? t('header.connecting') : t('wizard.tmConnect') }}
          </button>
          <p v-else class="wiz-ok">{{ t('wizard.connected', { name: state.deviceName }) }}</p>
          <p v-if="state.error" class="warn">{{ tmError }}</p>
          <div class="wiz-nav">
            <span></span>
            <button class="btn ghost" @click="wizardStep = 2">
              {{ state.connected ? t('wizard.next') : t('wizard.skip') }}
            </button>
          </div>
        </div>

        <!-- 2: heart rate -->
        <div v-else-if="wizardStep === 2" class="wiz-step">
          <div class="wiz-icon">❤️</div>
          <h2>{{ t('wizard.hrTitle') }}</h2>
          <p>{{ t('wizard.hrBody') }}</p>
          <button
            v-if="!hr.state.connected"
            class="btn go wiz-cta"
            :disabled="hr.state.connecting"
            @click="hr.connect"
          >
            {{ hr.state.connecting ? t('header.connecting') : t('wizard.hrConnect') }}
          </button>
          <p v-else class="wiz-ok">{{ t('wizard.connected', { name: hr.state.deviceName }) }}</p>
          <p v-if="hr.state.error" class="warn">{{ hrError }}</p>
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 1">{{ t('wizard.back') }}</button>
            <button class="btn ghost" @click="wizardStep = 3">
              {{ hr.state.connected ? t('wizard.next') : t('wizard.skip') }}
            </button>
          </div>
        </div>

        <!-- 3: mode -->
        <div v-else-if="wizardStep === 3" class="wiz-step">
          <div class="wiz-icon">🎯</div>
          <h2>{{ t('wizard.modeTitle') }}</h2>
          <div class="mode-grid">
            <button class="mode-card" @click="wizardWalk">
              <span class="mode-emoji">🚶</span>
              <span class="mode-name">{{ t('wizard.freeWalk') }}</span>
              <span class="mode-desc">{{ t('wizard.freeWalkDesc') }}</span>
            </button>
            <button class="mode-card" @click="wizardStep = 4">
              <span class="mode-emoji">📋</span>
              <span class="mode-name">{{ t('wizard.workout') }}</span>
              <span class="mode-desc">{{ t('wizard.workoutDesc') }}</span>
            </button>
          </div>
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 2">{{ t('wizard.back') }}</button>
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
            <button class="btn ghost" @click="wizardStep = 3">{{ t('wizard.back') }}</button>
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
  line-height: 1;
}
.head-actions {
  display: flex;
  gap: 8px;
}

.warn {
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(224, 40, 74, 0.35);
  color: #b02040;
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(10px);
  border-radius: 999px;
  padding: 2px;
  box-shadow: 0 4px 14px rgba(23, 50, 77, 0.12);
}
.view-flip button {
  background: none;
  border: 0;
  color: #7b8da1;
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
}
.view-flip button.on {
  background: var(--accent);
  color: #fff;
}
.view-flip button:disabled {
  opacity: 0.4;
  cursor: default;
}
.track {
  width: 100%;
  display: block;
}
/* the minimal mock ring: soft grey band on a white glow ring; the surveyed detail
   layers (lanes, staggers, relay/hurdle marks…) stay in the template but hidden —
   easy to re-enable later */
.track-band {
  fill: none;
  stroke: #dde2e8; /* width bound from the lane count so lanes stay true */
}
.track-glow {
  fill: none;
  stroke: rgba(255, 255, 255, 0.85);
}
.track-lane,
.stagger,
.breakline,
.relay-line,
.hurdle-tick,
.waterfall,
.lane-num,
.startline {
  display: none;
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
  stroke-width: 30; /* nearly fills the band (overrides the template's lane width) */
  stroke-linecap: round;
  transition: stroke-dashoffset 0.25s linear;
}
/* white knob with a blue ring, riding the progress head */
.runner .halo {
  fill: #fff;
  r: 15;
}
.runner .body {
  fill: #fff;
  stroke: var(--accent);
  stroke-width: 5;
  r: 10;
}
.runner {
  transition: transform 0.25s linear;
}
/* headline lap counter (sizes are viewBox units — the svg scales them up) */
.lap-num {
  text-anchor: middle;
  font-size: 58px;
  font-weight: 800;
  letter-spacing: -2px;
  fill: #17324d;
}
.lap-label {
  text-anchor: middle;
  font-size: 9px;
  font-weight: 600;
  fill: #5a789a;
  letter-spacing: 0.5px;
}
.lap-times {
  text-anchor: middle;
  font-size: 8px;
  font-weight: 600;
  fill: #5a789a;
  font-variant-numeric: tabular-nums;
}

/* --- 3D scenic (#51): canvas wrapper --- */
.scene3d-wrap {
  position: relative;
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
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.85);
  border-radius: 16px;
  backdrop-filter: blur(16px);
  box-shadow: 0 6px 18px rgba(23, 50, 77, 0.1);
  padding: 10px 20px;
  transition: opacity 0.35s;
}
.sv {
  font-size: 20px;
  font-weight: 700;
  color: #17324d;
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
  color: #7b8da1;
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  color: #17324d;
  border-radius: 10px;
  padding: 5px 11px;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
/* lives inside the stat strip — same frosted card as .sstat, stretched to its height */
.hr-badge {
  position: relative;
  overflow: hidden;
  flex: 1;
  min-width: 0;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.85);
  border-radius: 16px;
  backdrop-filter: blur(16px);
  box-shadow: 0 6px 18px rgba(23, 50, 77, 0.1);
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 800;
  font-family: inherit;
  cursor: pointer;
}
.hr-badge.on {
  border-color: var(--accent);
}
.hr-zone-tag {
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
/* the fat-burn zone is the one most walkers aim for — make hitting it obvious */
.hr-zone-tag.fatburn {
  text-shadow: 0 0 8px rgba(46, 213, 115, 0.8);
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
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.15;
}
.hr-badge-content .sv {
  color: inherit;
}
.controls.disabled {
  opacity: 0.55;
}
.speed-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
/* the mock's dock row: speed headline left, slider filling the rest */
.speed-set {
  flex: 1;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 18px;
}
.target {
  font-weight: 800;
  font-size: 36px;
  letter-spacing: -1px;
  color: #17324d;
  white-space: nowrap;
}
.target small {
  color: #7b8da1;
  font-weight: 600;
  font-size: 14px;
}
/* blue fill up to the value (--slider-fill bound in the template), grey rest,
   floating white knob. appearance:none on the INPUT is what lets the track/thumb
   pseudo-elements take styling at all. */
input[type='range'] {
  flex: 1;
  width: 100%;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  height: 26px;
}
input[type='range']::-webkit-slider-runnable-track {
  height: 10px;
  border-radius: 5px;
  background: linear-gradient(
    90deg,
    var(--accent) 0 var(--slider-fill, 0%),
    rgba(23, 50, 77, 0.12) var(--slider-fill, 0%)
  );
}
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 26px;
  height: 26px;
  margin-top: -8px;
  border-radius: 50%;
  background: #fff;
  border: 0;
  box-shadow: 0 3px 10px rgba(23, 50, 77, 0.3);
}
/* the mock's dock has no ± buttons */
.speed-row .btn.round {
  display: none;
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
  background: rgba(120, 160, 200, 0.25);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 20;
}
.wizard-overlay {
  align-items: center;
  background: rgba(174, 227, 255, 0.35);
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
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 1);
  backdrop-filter: blur(18px);
  border-radius: 14px;
  padding: 6px;
  min-width: 190px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 12px 28px rgba(23, 50, 77, 0.25);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  background: none;
  border: none;
  color: #17324d;
  padding: 11px 12px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.menu-item:hover {
  background: rgba(23, 50, 77, 0.06);
}
.wizard {
  width: 100%;
  max-width: 440px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.95);
  color: #17324d;
  backdrop-filter: blur(24px);
  box-shadow: 0 18px 50px rgba(23, 50, 77, 0.2);
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
  background: rgba(23, 50, 77, 0.15);
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
  color: #56718c;
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
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
  color: #5a789a;
}
.sheet {
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.95);
  color: #17324d;
  backdrop-filter: blur(24px);
  box-shadow: 0 18px 50px rgba(23, 50, 77, 0.2);
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
  background: transparent;
  padding: 10px 0;
}
.sheet-head h2 {
  font-size: 18px;
  font-weight: 800;
  flex: 1;
  text-align: center;
}
.x {
  background: rgba(255, 255, 255, 0.7);
  border: none;
  color: #17324d;
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  color: #17324d;
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
  cursor: pointer;
}
.goal-chip.on {
  background: var(--accent);
  border-color: transparent;
  color: #fff;
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
  background: rgba(23, 50, 77, 0.12);
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
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(12px);
  border: 1px solid var(--accent);
  color: #17324d;
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
/* --- immersive layout (#103): the visual fills the viewport; header stats float
   as a HUD and the controls as a bottom pill; the pills fade while walking untouched. */
.app.layout-immersive {
  max-width: none;
  padding: 0;
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
/* 2D ring ('flat'): a centred floating card on the sky instead of the full viewport;
   the 3D scenic walk keeps the fullscreen rules above */
.app.layout-immersive > .track-wrap.flat {
  inset: auto;
  left: 50%;
  top: 64px;
  transform: translateX(-50%);
  width: min(640px, 92vw);
  height: min(58vh, 460px);
}
.app.layout-immersive > .track-wrap.flat .track {
  height: 100%;
  width: 100%;
}
.app.layout-immersive .track-wrap.flat .view-flip {
  top: 0;
  right: 0;
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
/* mock header: brand left, stat pills gathered at the right edge */
.app.layout-immersive .stat-strip {
  order: 0;
  flex-basis: auto;
  flex: 1;
  justify-content: flex-end;
  margin: 0 10px;
}
.app.layout-immersive .sstat,
.app.layout-immersive .hr-badge {
  flex: 0 1 110px;
}
.app.layout-immersive > .warn {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  max-width: 90vw;
}
/* the dock: speed card and action row fuse into the mock's single floating card */
.app.layout-immersive > .action-row,
.app.layout-immersive > .controls {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  margin: 0;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.85);
  color: #17324d;
  transition: opacity 0.4s;
}
.app.layout-immersive > .controls {
  /* flush against the action-row's top edge: 20px inset + its ~73px height */
  bottom: 93px;
  width: min(600px, 94vw);
  border-radius: 24px 24px 0 0;
  border-bottom: 0;
  padding: 18px 22px 8px;
}
/* the header row is the HUD now; the fullscreen badges drop below the header bar */
.app.layout-immersive .view-flip {
  top: 64px;
  right: 12px;
}
.app.layout-immersive > .action-row {
  bottom: 20px;
  width: min(600px, 94vw);
  justify-content: stretch;
  border-radius: 0 0 24px 24px;
  border-top: 0;
  padding: 8px 22px 18px;
  box-shadow: 0 10px 28px rgba(23, 50, 77, 0.14);
}
.app.layout-immersive > .action-row .btn {
  flex: 1;
  padding: 14px 16px;
}
.app.layout-immersive > .action-row .btn.go {
  flex: 1.6;
  font-size: 16px;
}
/* the mock's dock: Start + Stop only (no pause/reset) */
.app.layout-immersive > .action-row .btn.ghost {
  display: none;
}
/* workouts hide the speed card — the action row then stands alone, fully rounded */
.app.layout-immersive:not(:has(> .controls)) > .action-row {
  border-radius: 24px;
  padding: 14px 22px;
}
.app.layout-immersive > .chart-wrap {
  display: none;
}
/* goal chips (#129) parked while the dock stays mock-faithful */
.app.layout-immersive > .controls .goal-row,
.app.layout-immersive > .controls .goal-progress {
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
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 10px 28px rgba(23, 50, 77, 0.14);
  color: #17324d;
  border-radius: 20px;
  padding: 10px 14px;
}
.app.layout-immersive.hud-big > .imm-workout {
  bottom: 130px;
}
.imm-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.imm-ring {
  position: relative;
  width: 72px;
  height: 72px;
  flex: none;
}
.imm-ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.imm-ring-track,
.imm-ring-fill {
  fill: none;
  stroke-width: 5;
  stroke-linecap: round;
}
.imm-ring-track {
  stroke: rgba(23, 50, 77, 0.12);
}
.imm-ring-fill {
  stroke: var(--accent);
  transition: stroke-dasharray 0.9s linear;
}
.imm-ring-val {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 17px;
  font-weight: 700;
  color: #17324d;
  font-variant-numeric: tabular-nums;
}
.imm-mid {
  flex: 1;
  min-width: 0;
}
.imm-nownext {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.imm-nn-k {
  display: block;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #7b8da1;
}
.imm-nn-v {
  font-size: 18px;
  font-weight: 700;
  color: #17324d;
  font-variant-numeric: tabular-nums;
}
.imm-next .imm-nn-v {
  color: var(--accent);
}
.imm-nn-arrow {
  color: #8a93a3;
  font-size: 18px;
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
  background: rgba(23, 50, 77, 0.15);
  min-width: 3px;
}
.imm-seg.done {
  background: rgba(10, 132, 255, 0.4);
}
.imm-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.imm-name {
  color: #17324d;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.imm-time {
  color: #7b8da1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* narrow screens (#113): the stat strip gets its own header row instead of
   fighting the badges; fullscreen overlays drop below the taller header */
@media (max-width: 700px) {
  .app.layout-immersive > header {
    flex-wrap: wrap;
  }
  .app.layout-immersive .stat-strip {
    order: 5;
    flex: 1 1 100%;
    margin: 6px 0 0;
  }
  .app.layout-immersive .sstat,
  .app.layout-immersive .hr-badge {
    flex: 1 1 0;
    padding: 4px 2px 3px;
  }
  .app.layout-immersive .sstat .sv {
    font-size: 13px;
  }
  .app.layout-immersive .sstat .sk {
    font-size: 8.5px;
  }
  .app.layout-immersive .view-flip {
    top: 118px;
  }
  .app.layout-immersive > .warn {
    top: 168px;
    width: 92vw;
  }
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
  font-size: 42px;
}
.app.layout-immersive.hud-big .imm-ring-val {
  font-size: 20px;
}
.app.layout-immersive.hud-big .imm-nn-v {
  font-size: 24px;
}
/* the bigger buttons need more clearance below the speed pill */
.app.layout-immersive.hud-big > .controls {
  bottom: 130px;
}
.app.layout-immersive.hud-big > .warn {
  top: 96px;
}
</style>
