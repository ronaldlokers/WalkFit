// Other people on the 3D track, plus the cadence model the avatar and (in a later slice)
// the camera bob run on. Pure and three.js-free on purpose: Scenic3D.vue can never be
// unit-tested because jsdom has no WebGL, and App.vue imports from here directly, so a
// three import would drag three.js into the main bundle chunk.
//
// Pacer positions are ANALYTIC functions of elapsed time — no accumulated state — so the
// same second always produces the same scene, across reloads and in tests, without having
// to simulate time forward.
import { worldHash, LAP_M, TRACK_IN, LANE_W, BEND_R } from './scenic'

export type PacerKind = 'walker' | 'jogger' | 'runner' | 'intervals'
export interface Pacer {
  lane: number // 2..6 — never lane 1, which is where the walker is
  d: number // metres travelled along that lane's own line
  speed: number // km/h, instantaneous
  kind: PacerKind
  seed: number // 0..1, stable per pacer — drives kit colour
  drawO: number // absolute lateral offset to DRAW at, in metres from the lane-1 line.
  // Arc distance is still measured along laneMeasurementO(lane); this only moves the
  // body sideways within its lane.
}

// Lane 1 is the walker's. Pacers use the outer lanes so a fast one overtaking cannot
// clip through the camera.
export const PACER_LANES = [2, 3, 4, 5, 6]

// Two pacers share a lane once count exceeds PACER_LANES.length, and their differing
// speeds mean the faster laps the slower within about a minute. Putting them on opposite
// sides of the lane CENTRE turns that from two meshes intersecting into an overtake.
// Offsets are from the centre, not from laneMeasurementO — that line sits 0.2 m in from
// the lane's inner edge, so measuring from it puts one side 0.1 m out of the lane.
// A lane is LANE_W (1.22 m) wide, so +/-0.3 m from centre leaves 0.31 m clearance a side.
export const PACER_LATERAL_M = 0.3

// Interval pacers run a square cycle: INTERVAL_PERIOD_M / 2 fast, then the same distance
// slow. A square cycle keeps the position closed-form — see distanceAt below.
export const INTERVAL_PERIOD_M = 200
export const INTERVAL_FAST_KMH = 14
export const INTERVAL_SLOW_KMH = 6

const KINDS: { kind: PacerKind; speed: number }[] = [
  { kind: 'walker', speed: 4.5 },
  { kind: 'jogger', speed: 8 },
  { kind: 'runner', speed: 11 },
  { kind: 'intervals', speed: INTERVAL_FAST_KMH },
  { kind: 'walker', speed: 5.5 },
  { kind: 'jogger', speed: 9 },
  { kind: 'runner', speed: 12.5 },
  { kind: 'walker', speed: 4 },
]

const mps = (kmh: number) => (kmh * 1000) / 3600

// One full fast+slow cycle, in seconds.
const CYCLE_SECS =
  INTERVAL_PERIOD_M / 2 / mps(INTERVAL_FAST_KMH) + INTERVAL_PERIOD_M / 2 / mps(INTERVAL_SLOW_KMH)
const FAST_SECS = INTERVAL_PERIOD_M / 2 / mps(INTERVAL_FAST_KMH)

// Closed-form distance for an interval pacer at time t: whole cycles are exact multiples
// of INTERVAL_PERIOD_M, and the remainder is one plateau or the other.
function intervalDistance(t: number): number {
  const cycles = Math.floor(t / CYCLE_SECS)
  const rem = t - cycles * CYCLE_SECS
  const base = cycles * INTERVAL_PERIOD_M
  return rem <= FAST_SECS
    ? base + rem * mps(INTERVAL_FAST_KMH)
    : base + INTERVAL_PERIOD_M / 2 + (rem - FAST_SECS) * mps(INTERVAL_SLOW_KMH)
}

function intervalSpeed(t: number): number {
  const rem = t - Math.floor(t / CYCLE_SECS) * CYCLE_SECS
  return rem <= FAST_SECS ? INTERVAL_FAST_KMH : INTERVAL_SLOW_KMH
}

export function pacers(t: number, count: number): Pacer[] {
  const out: Pacer[] = []
  for (let i = 0; i < count; i++) {
    const k = KINDS[i % KINDS.length]!
    const seed = worldHash(i * 31 + 7)
    // Spread starts evenly around the lap (i * LAP_M / KINDS.length), jittered by the
    // per-pacer seed so pacers landing in the same lane don't start on top of each other.
    const start = ((i * LAP_M) / KINDS.length + seed * 40) % LAP_M
    const offset = i * 0.37 // km/h, so same-lane pacers separate rather than travel merged
    const speed = k.kind === 'intervals' ? intervalSpeed(t) : k.speed + offset
    const d =
      k.kind === 'intervals' ? start + intervalDistance(t) : start + mps(k.speed + offset) * t
    // Same-lane pacers WILL lap each other eventually since their speeds differ — put
    // them on opposite sides of the lane so that reads as an overtake, not a collision.
    const lane = PACER_LANES[i % PACER_LANES.length]!
    const row = Math.floor(i / PACER_LANES.length)
    const centreO = TRACK_IN + (lane - 0.5) * LANE_W
    const drawO = centreO + (row % 2 === 0 ? -PACER_LATERAL_M : PACER_LATERAL_M)
    out.push({ lane, d, speed, kind: k.kind, seed, drawO })
  }
  return out
}

// --- cadence ---
// The belt reports its own step count (treadmill.ts records it from the fff1 running
// frame), so the avatar's cadence is MEASURED, not modelled: legs, arms and — in a later
// slice — the camera bob all move at the walker's real rate.

export const DEFAULT_STRIDE_M = 0.72
export const MIN_STRIDE_M = 0.4
export const MAX_STRIDE_M = 1.0

export function strideLength(distance: number, steps: number): number {
  // Number.isFinite, not a comparison: every comparison with NaN is false, so `steps <= 0`
  // lets NaN straight through and the caller ends up putting NaN into a rotation.
  if (!Number.isFinite(distance) || !Number.isFinite(steps) || steps <= 0 || distance <= 0) {
    return DEFAULT_STRIDE_M
  }
  const raw = distance / steps
  return Math.min(MAX_STRIDE_M, Math.max(MIN_STRIDE_M, raw))
}

// 0..1 through the current step, driven by walked distance rather than wall clock so it
// stays locked to the belt and is deterministic in tests.
export function stepPhase(distance: number, stride: number): number {
  const p = (distance / stride) % 1
  return p < 0 ? p + 1 : p
}

// stepPhase's period is one GAIT CYCLE — left foot to left foot — because limbs swing in
// antiphase, so one sine period covers two footfalls. strideLength returns the length of a
// single footfall. Feed one to the other and every limb animates at twice the real cadence.
export function gaitCycleM(stride: number): number {
  return stride * 2
}

// Signed limb position for the split-limb rigs. Keeping the gait-cycle conversion here
// prevents renderer-only code from feeding a one-footfall stride to stepPhase and silently
// doubling the animation cadence.
export function limbSwing(distance: number, stride: number): number {
  return Math.sin(stepPhase(distance, gaitCycleM(stride)) * Math.PI * 2)
}

export function cadenceHz(speedKmh: number, stride: number): number {
  return mps(speedKmh) / stride
}

// --- camera motion (slice 4) ---
// The camera used to glide on rails, and the component's comments called the fixed horizon
// a comfort choice. It was the right default when there was nothing else to look at; now
// there is. Phase comes from WALKED DISTANCE, not wall clock, so it stays locked to the
// belt, deterministic across reloads, and testable without a fake timer — the same choice
// dayPhase and stepPhase already make.
export const BOB_M = 0.03 // vertical, one dip per footfall
export const SWAY_M = 0.015 // lateral, one full swing per gait cycle (alternating feet)
export const ROLL_MAX_RAD = (1.2 * Math.PI) / 180
export const FOV_BASE_DEG = 60
export const FOV_MAX_DEG = 66
export const FOV_SPEED_LO = 1 // km/h, mirrors the belt's SPEED_MIN
export const FOV_SPEED_HI = 6 // km/h, mirrors the belt's SPEED_MAX
// Below this the projection matrix is not worth rebuilding — nobody can see it.
export const FOV_EPSILON_DEG = 0.05

export interface CameraMotion {
  dy: number // metres, vertical bob
  dx: number // metres, lateral sway — a trackPoint() offset, so positive is outward
  roll: number // radians, positive = head tilted left = leaning into a left-hand bend
  fov: number // degrees
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function cameraMotion(
  distance: number,
  stride: number,
  speed: number,
  curvature: number, // signed 1/R at the current arc position, 0 on the straights
  enabled: boolean,
): CameraMotion {
  if (!enabled) return { dy: 0, dx: 0, roll: 0, fov: FOV_BASE_DEG }
  // Same reasoning as strideLength: a NaN reaching camera.position blanks the scene, and
  // `stride <= 0` cannot catch NaN because every comparison with NaN is false.
  const still = Number.isFinite(speed) ? speed : 0
  const fov =
    FOV_BASE_DEG +
    (FOV_MAX_DEG - FOV_BASE_DEG) *
      clamp((still - FOV_SPEED_LO) / (FOV_SPEED_HI - FOV_SPEED_LO), 0, 1)
  if (!Number.isFinite(distance) || !Number.isFinite(stride) || stride <= 0) {
    return { dy: 0, dx: 0, roll: 0, fov }
  }
  // One gait cycle = two footfalls (see gaitCycleM), so the once-per-foot bob runs at
  // TWICE this frequency and the alternating-feet sway at exactly it. Swap those and every
  // motion doubles — the slice-3 bug that survived eight review rounds, because a
  // screenshot cannot show frequency.
  const gait = stepPhase(distance, gaitCycleM(stride)) * Math.PI * 2
  const dy = BOB_M * Math.cos(2 * gait) // lowest at the footfall, highest mid-step
  const dx = SWAY_M * Math.sin(gait)
  const lean = Number.isFinite(curvature) ? clamp(curvature * BEND_R, -1, 1) : 0
  return { dy, dx, roll: ROLL_MAX_RAD * lean, fov }
}

// Signed metres between you and the rabbit, positive when it is ahead. Deliberately NOT
// wrapped to the lap: lapping the rabbit is a 400 m lead, not a dead heat.
export function paceGap(yourDistance: number, rabbitDistance: number): number {
  return rabbitDistance - yourDistance
}
