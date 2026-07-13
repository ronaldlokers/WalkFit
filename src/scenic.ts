// Pure, framework-free world model for the 3D scenic walk (#51): a 400 m athletics
// track walked first-person from lane 1. No three.js here — this module answers "where
// is the walker at distance s, and what surrounds the track", so it stays unit-testable;
// the Scenic3D component only turns the answers into meshes. Everything is deterministic
// (same distance → same view, across re-renders and reloads).

// Cheap deterministic pseudo-random in [0,1) — the same sine trick the 2D scenic used.
export function worldHash(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

// --- 400 m track geometry ---
// Standard stadium shape: two straights + two semicircular bends, sized so the lane-1
// walking line measures exactly 400 m (IAAF straights, bend radius derived from that).
export const LAP_M = 400
export const STRAIGHT_M = 84.39
export const BEND_R = (LAP_M - 2 * STRAIGHT_M) / (2 * Math.PI) // ≈ 36.8 m
export const LANE_W = 1.22
export const LANES = 6
// track band, as lateral offsets from the lane-1 walking line (positive = outward,
// away from the infield): inner edge half a lane in, outer edge LANES out.
export const TRACK_IN = -LANE_W / 2
export const TRACK_OUT = TRACK_IN + LANES * LANE_W

export interface TrackPoint {
  x: number
  z: number
  // unit tangent (direction of travel) — the camera looks along the loop
  tx: number
  tz: number
}

// Position on the loop at arc distance s (metres, wraps every LAP_M) and lateral
// offset o (metres from the lane-1 line, positive outward). Walking direction is
// counterclockwise seen from above — infield on the walker's left, like athletics.
export function trackPoint(s: number, o = 0): TrackPoint {
  s = ((s % LAP_M) + LAP_M) % LAP_M
  const R = BEND_R
  const half = STRAIGHT_M / 2
  const bendLen = Math.PI * R
  if (s < STRAIGHT_M) {
    // home straight: x = +R side, walking -z
    return { x: R + o, z: half - s, tx: 0, tz: -1 }
  }
  s -= STRAIGHT_M
  if (s < bendLen) {
    // first bend, centered (0, -half)
    const a = s / R
    return {
      x: (R + o) * Math.cos(a),
      z: -half - (R + o) * Math.sin(a),
      tx: -Math.sin(a),
      tz: -Math.cos(a),
    }
  }
  s -= bendLen
  if (s < STRAIGHT_M) {
    // back straight: x = -R side, walking +z
    return { x: -(R + o), z: -half + s, tx: 0, tz: 1 }
  }
  s -= STRAIGHT_M
  // second bend, centered (0, +half)
  const a = s / R
  return {
    x: -(R + o) * Math.cos(a),
    z: half + (R + o) * Math.sin(a),
    tx: Math.sin(a),
    tz: Math.cos(a),
  }
}

// --- surroundings ---
// Deterministic scenery outside the track: trees/bushes/rocks scattered around the
// perimeter, plus floodlight poles. Static — a loop world needs no streaming.
export type PropType = 'tree' | 'pine' | 'bush' | 'rock' | 'flood'
export interface Prop {
  type: PropType
  s: number // arc position along the loop
  o: number // lateral offset (positive = outside the track)
  scale: number
  seed: number
}

const SCENERY_TYPES: PropType[] = ['tree', 'tree', 'pine', 'bush', 'rock']
export const SCENERY_CLEAR_M = 4 // clearance beyond the track's outer edge

export function surroundings(): Prop[] {
  const props: Prop[] = []
  // greenery ring outside the track
  for (let i = 0; i < 48; i++) {
    const seed = i * 17
    const s = i * (LAP_M / 48) + worldHash(seed) * 6
    const o = TRACK_OUT + SCENERY_CLEAR_M + worldHash(seed + 1) * 26
    props.push({
      type: SCENERY_TYPES[Math.floor(worldHash(seed + 2) * SCENERY_TYPES.length)]!,
      s,
      o,
      scale: 0.8 + worldHash(seed + 3) * 0.7,
      seed: worldHash(seed + 4),
    })
  }
  // four floodlight masts, evenly spaced, just past the outer edge (lit at night)
  for (let i = 0; i < 4; i++) {
    props.push({ type: 'flood', s: 50 + i * 100, o: TRACK_OUT + 2.5, scale: 1, seed: i / 4 })
  }
  return props
}

// --- track markings ---
// Distance signposts beside the track every 100 m of the lap (the 400 m point is the
// finish line itself, so three signs).
export interface DistanceSign {
  s: number
  label: string
}
export function distanceSigns(): DistanceSign[] {
  return [100, 200, 300].map((m) => ({ s: m, label: `${m} m` }))
}

// Staggered start lines, one per lane beyond lane 1: lane k+1's centreline sits at
// radius R + k·LANE_W, so its lap is 2π·k·LANE_W longer than lane 1's 400 m. Placing
// its start mark that far past the common finish makes every lane's lap to the finish
// line measure exactly 400 m — the classic athletics stagger. All staggers land on the
// home straight (2π·5·LANE_W ≈ 38 m < STRAIGHT_M).
export interface LaneStagger {
  lane: number // 2..LANES
  s: number
  o0: number // lateral span of just that lane
  o1: number
}
export function laneStaggers(): LaneStagger[] {
  const out: LaneStagger[] = []
  for (let k = 1; k < LANES; k++) {
    out.push({
      lane: k + 1,
      s: 2 * Math.PI * k * LANE_W,
      o0: TRACK_IN + k * LANE_W,
      o1: TRACK_IN + (k + 1) * LANE_W,
    })
  }
  return out
}

// Painted lane numbers just past the finish line, one per lane, like a real track.
// Lane k's centreline sits at offset (k-1)·LANE_W (lane 1 = the walking line at 0).
export interface LaneNumber {
  lane: number
  s: number
  o: number
}
export const LANE_NUMBER_S = 3 // metres past the finish line
export function laneNumbers(): LaneNumber[] {
  return Array.from({ length: LANES }, (_, k) => ({
    lane: k + 1,
    s: LANE_NUMBER_S,
    o: k * LANE_W,
  }))
}

// The green break line at the end of the first bend (the 200 m point) — where middle-
// distance runners may break for the inside on a real track.
export const BREAK_LINE_S = STRAIGHT_M + Math.PI * BEND_R

// 4×100 relay exchange zones: 30 m (20 m in, 10 m out) around each 100 m mark, marked
// as a yellow line across each lane at both zone limits. (Real zones stagger per lane
// on the bends; uniform lane-1 arc positions are close enough at this fidelity.)
export interface LaneLineMark {
  s: number
  o0: number
  o1: number
}
export function relayZoneLines(): LaneLineMark[] {
  const out: LaneLineMark[] = []
  for (const centre of [100, 200, 300]) {
    for (const s of [centre - 20, centre + 10]) {
      for (let k = 0; k < LANES; k++) {
        out.push({ s, o0: TRACK_IN + k * LANE_W, o1: TRACK_IN + (k + 1) * LANE_W })
      }
    }
  }
  return out
}

// 400 m hurdles: 10 flights, first at 45 m then every 35 m — small green ticks on the
// lane boundaries (the paint scheme real tracks use for the 400 mH positions).
export interface TrackTick {
  s: number
  o: number
}
export function hurdleTicks(): TrackTick[] {
  const out: TrackTick[] = []
  for (let h = 0; h < 10; h++) {
    const s = 45 + h * 35
    for (let k = 0; k <= LANES; k++) out.push({ s, o: TRACK_IN + k * LANE_W })
  }
  return out
}

// 1500 m waterfall start: a curved line across all lanes at the 100 m arc point
// (3.75 laps to the finish), bowing forward toward the outer lanes so everyone covers
// an equal distance while cutting in. The bow is an approximation of the surveyed
// involute — enough to read as the classic waterfall.
export const WATERFALL_S = 100
export function waterfallPoints(samples = 25): TrackTick[] {
  const out: TrackTick[] = []
  for (let i = 0; i < samples; i++) {
    const o = TRACK_IN + (i / (samples - 1)) * (TRACK_OUT - TRACK_IN)
    const d = Math.max(0, o)
    out.push({ s: WATERFALL_S + 0.35 * d + 0.05 * d * d, o })
  }
  return out
}

// --- day/night from walked distance ---
// Every walk gets its own sky: phase 0 (session start) is dawn; a full cycle takes
// DAY_LENGTH_M, so a typical 2–3 km walk sees dawn → noon → golden hour → dusk.
export const DAY_LENGTH_M = 3200

export function dayPhase(z: number): number {
  return (Math.max(0, z) % DAY_LENGTH_M) / DAY_LENGTH_M
}

export interface SkyState {
  sky: number // upper sky color
  fog: number // horizon / fog color
  sunIntensity: number // directional light
  sunColor: number
  ambient: number // hemisphere intensity
}

interface SkyKey extends SkyState {
  at: number
}
// Keyframes around the cycle; lerped between. Dark-theme friendly: even "noon" stays
// muted so the app chrome around the canvas doesn't clash.
const SKY_KEYS: SkyKey[] = [
  { at: 0.0, sky: 0x3a2f45, fog: 0x6d5468, sunIntensity: 0.7, sunColor: 0xffb08a, ambient: 0.7 }, // dawn
  { at: 0.18, sky: 0x4a6a8a, fog: 0x7a8ea3, sunIntensity: 1.0, sunColor: 0xfff2dd, ambient: 0.9 }, // morning
  { at: 0.45, sky: 0x527099, fog: 0x8298ad, sunIntensity: 1.1, sunColor: 0xffffff, ambient: 1.0 }, // day
  { at: 0.62, sky: 0x4a5c80, fog: 0x8a7f8e, sunIntensity: 0.9, sunColor: 0xffe0b0, ambient: 0.85 }, // late
  { at: 0.75, sky: 0x51345a, fog: 0x8a5c62, sunIntensity: 0.6, sunColor: 0xff9a5c, ambient: 0.6 }, // sunset
  { at: 0.87, sky: 0x1c1f33, fog: 0x2c3046, sunIntensity: 0.2, sunColor: 0x9ab0ff, ambient: 0.35 }, // night
  { at: 1.0, sky: 0x3a2f45, fog: 0x6d5468, sunIntensity: 0.7, sunColor: 0xffb08a, ambient: 0.7 }, // wraps to dawn
]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff
  return (
    (Math.round(lerp(ar, br, t)) << 16) |
    (Math.round(lerp(ag, bg, t)) << 8) |
    Math.round(lerp(ab, bb, t))
  )
}

export function skyAt(phase: number): SkyState {
  let i = 0
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1]!.at <= phase) i++
  const a = SKY_KEYS[i]!
  const b = SKY_KEYS[i + 1]!
  const t = (phase - a.at) / (b.at - a.at)
  return {
    sky: lerpColor(a.sky, b.sky, t),
    fog: lerpColor(a.fog, b.fog, t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    sunColor: lerpColor(a.sunColor, b.sunColor, t),
    ambient: lerp(a.ambient, b.ambient, t),
  }
}
