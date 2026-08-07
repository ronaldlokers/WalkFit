// Other people on the 3D track, plus the cadence model the avatar and (in a later slice)
// the camera bob run on. Pure and three.js-free on purpose: Scenic3D.vue can never be
// unit-tested because jsdom has no WebGL, and App.vue imports from here directly, so a
// three import would drag three.js into the main bundle chunk.
//
// Pacer positions are ANALYTIC functions of elapsed time — no accumulated state — so the
// same second always produces the same scene, across reloads and in tests, without having
// to simulate time forward.
import { worldHash, LAP_M } from './scenic'

export type PacerKind = 'walker' | 'jogger' | 'runner' | 'intervals'

export interface Pacer {
  lane: number // 2..6 — never lane 1, which is where the walker is
  d: number // metres travelled along that lane's own line
  speed: number // km/h, instantaneous
  kind: PacerKind
  seed: number // 0..1, stable per pacer — drives kit colour
}

// Lane 1 is the walker's. Pacers use the outer lanes so a fast one overtaking cannot
// clip through the camera.
export const PACER_LANES = [2, 3, 4, 5, 6]

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
    // Spread starts around the lap so a lane's pacers begin well apart; the +i term
    // keeps two pacers landing in the same lane from starting on top of each other.
    const start = ((i * LAP_M) / KINDS.length + seed * 40) % LAP_M
    const offset = i * 0.37 // km/h, so same-lane pacers separate rather than travel merged
    const speed = k.kind === 'intervals' ? intervalSpeed(t) : k.speed + offset
    const d =
      k.kind === 'intervals' ? start + intervalDistance(t) : start + mps(k.speed + offset) * t
    out.push({ lane: PACER_LANES[i % PACER_LANES.length]!, d, speed, kind: k.kind, seed })
  }
  return out
}
