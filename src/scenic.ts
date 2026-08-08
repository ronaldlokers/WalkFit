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

// Render distances the scenic view is built around. Here rather than in Scenic3D.vue so the
// pure modules can assert against them — the skyline once sat outside both and rendered zero
// pixels for an entire task.
export const DOME_R = 260
export const FOG_FAR = 230
export const CAMERA_FAR = FOG_FAR + 60

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
// Official World Athletics measurement convention (#54): lane 1 is measured 0.30 m
// out from the kerb, lanes 2+ at 0.20 m from their inner lane line. o = 0 is the
// lane-1 measurement line (the walking line), so the kerb sits at o = −0.30 and the
// BEND_R above (≈36.80 m) is exactly the official measurement-line radius
// (36.50 m kerb + 0.30 m).
export const KERB_INSET = 0.3 // lane-1 measurement line → kerb
export const LANE_MEAS_INSET = 0.2 // lanes 2+ measurement line → inner lane line
export const TRACK_IN = -KERB_INSET // track inner edge = the kerb line
export const TRACK_OUT = TRACK_IN + LANES * LANE_W

// Lane k's measurement line as a lateral offset. This is what staggers, relay zones,
// hurdle marks and the waterfall are surveyed along on a real track.
export function laneMeasurementO(lane: number): number {
  return lane === 1 ? 0 : TRACK_IN + (lane - 1) * LANE_W + LANE_MEAS_INSET
}

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

// --- curvature (slice 4: camera lean) ---
export const BEND_LEN_M = Math.PI * BEND_R

// Signed curvature of the lane-1 line at arc distance s: 0 on the straights, 1/BEND_R on
// the bends. POSITIVE MEANS TURNING LEFT — and both bends are left turns, because the loop
// is walked counterclockwise with the infield on the left. The bend CENTRES sit on
// opposite sides of the world origin, which makes it tempting to give them opposite signs;
// relative to the direction of travel they curve the same way, and a camera that took its
// roll from a flipping sign would lean out of one bend.
export function curvatureAt(s: number): number {
  const w = ((s % LAP_M) + LAP_M) % LAP_M
  if (w < STRAIGHT_M) return 0
  if (w < STRAIGHT_M + BEND_LEN_M) return 1 / BEND_R
  if (w < 2 * STRAIGHT_M + BEND_LEN_M) return 0
  return 1 / BEND_R
}

// A real track has no transition spiral: curvature steps by a full 1/R at the tangent
// point, and a camera roll driven off curvatureAt alone snaps over in a single frame.
// Blend across the nearest segment boundary instead. Analytic (no state), so it stays as
// deterministic and testable as everything else here.
export const CURVATURE_EASE_M = 6

export function curvatureEased(s: number, ease = CURVATURE_EASE_M): number {
  const w = ((s % LAP_M) + LAP_M) % LAP_M
  // LAP_M is included so the finish-line wrap eases like any other boundary
  const bounds = [0, STRAIGHT_M, STRAIGHT_M + BEND_LEN_M, 2 * STRAIGHT_M + BEND_LEN_M, LAP_M]
  let nearest = Infinity
  let at = 0
  for (const b of bounds) {
    if (Math.abs(w - b) < Math.abs(nearest)) {
      nearest = w - b
      at = b
    }
  }
  if (Math.abs(nearest) >= ease / 2) return curvatureAt(w)
  // every segment is far longer than `ease`, so ±ease lands squarely in the neighbours
  const before = curvatureAt(at - ease)
  const after = curvatureAt(at + ease)
  const u = nearest / ease + 0.5 // 0 at the window's leading edge, 1 at its trailing edge
  return before + (after - before) * (u * u * (3 - 2 * u)) // smoothstep
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

// Staggered start lines, one per lane beyond lane 1: lane k's measurement line sits
// at radius R + laneMeasurementO(k), so its lap is 2π·laneMeasurementO(k) longer than
// lane 1's 400 m. Placing its start mark that far past the common finish makes every
// lane's lap to the finish line measure exactly 400 m — and with the official
// measurement insets the values match published tables (lane 2 ≈ 7.04 m, not the
// naive centreline 7.67 m). All staggers land on the home straight.
export interface LaneStagger {
  lane: number // 2..LANES
  s: number
  o0: number // lateral span of just that lane
  o1: number
}
export function laneStaggers(): LaneStagger[] {
  const out: LaneStagger[] = []
  for (let k = 2; k <= LANES; k++) {
    out.push({
      lane: k,
      s: 2 * Math.PI * laneMeasurementO(k),
      o0: TRACK_IN + (k - 1) * LANE_W,
      o1: TRACK_IN + k * LANE_W,
    })
  }
  return out
}

// Painted lane numbers just past the finish line, one per lane, like a real track.
// The digits are paint, not measurement — they stay centred in each lane.
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
    o: TRACK_IN + (k + 0.5) * LANE_W,
  }))
}

// The green break line at the end of the first bend (the 200 m point) — where middle-
// distance runners may break for the inside on a real track.
export const BREAK_LINE_S = STRAIGHT_M + Math.PI * BEND_R

// Convert a distance walked along lane k's own line (centreline offset o) into the
// lane-1 arc parameter s. d = 0 is that lane's staggered 400 m start (2π·o past the
// finish), straights advance 1:1, and bend arcs scale by R/(R+o) — the exact geometry
// real tracks are surveyed with, so per-lane marks land where they do in the real
// world (fanning forward on the bends).
export function laneDistanceToS(o: number, d: number): number {
  const bendFactor = (BEND_R + o) / BEND_R // lane-metres per lane-1 arc metre on bends
  let s = 2 * Math.PI * o // the lane's staggered start
  let left = d
  const segments = [
    { end: STRAIGHT_M, factor: 1 },
    { end: STRAIGHT_M + Math.PI * BEND_R, factor: bendFactor },
    { end: 2 * STRAIGHT_M + Math.PI * BEND_R, factor: 1 },
    { end: LAP_M, factor: bendFactor },
  ]
  while (left > 1e-9) {
    const sMod = s % LAP_M
    const seg = segments.find((g) => sMod < g.end - 1e-9) ?? segments[0]!
    const laneLen = (seg.end - sMod) * seg.factor
    if (left <= laneLen) {
      s += left / seg.factor
      break
    }
    left -= laneLen
    s += seg.end - sMod
  }
  return s % LAP_M
}

// 4×100 relay exchange zones: 30 m (20 m in, 10 m out) around each leg's 100 m point,
// marked as a yellow line across each lane at both zone limits. Positions are measured
// along each lane's own line from its staggered start — exact, like a real survey.
export interface LaneLineMark {
  s: number
  o0: number
  o1: number
}
export function relayZoneLines(): LaneLineMark[] {
  const out: LaneLineMark[] = []
  for (let k = 1; k <= LANES; k++) {
    const oMeas = laneMeasurementO(k)
    for (const leg of [100, 200, 300]) {
      for (const d of [leg - 20, leg + 10]) {
        out.push({
          s: laneDistanceToS(oMeas, d),
          o0: TRACK_IN + (k - 1) * LANE_W,
          o1: TRACK_IN + k * LANE_W,
        })
      }
    }
  }
  return out
}

// 400 m hurdles: 10 flights per lane, the first 45 m from that lane's staggered start
// then every 35 m, measured along the lane's own line — small green ticks on both
// boundary lines of each lane, the paint scheme real tracks use.
export interface TrackTick {
  s: number
  o: number
}
export function hurdleTicks(): TrackTick[] {
  const out: TrackTick[] = []
  for (let k = 1; k <= LANES; k++) {
    const oMeas = laneMeasurementO(k)
    for (let h = 0; h < 10; h++) {
      const s = laneDistanceToS(oMeas, 45 + h * 35)
      out.push({ s, o: TRACK_IN + (k - 1) * LANE_W }, { s, o: TRACK_IN + k * LANE_W })
    }
  }
  return out
}

// 1500 m waterfall start at the 100 m arc point (300 m to the finish along lane 1).
// The exact equal-distance curve: a runner starting at lateral offset o runs the
// tangent line to the lane-1 circle, then follows it home — the start point is
// advanced along the bend so that tangent + remaining arc + 200 m (bend exit to
// finish) equals 300 m. This is the tangent-path construction real curved start
// lines are surveyed from.
export const WATERFALL_S = 100
export function waterfallPoints(samples = 25): TrackTick[] {
  const out: TrackTick[] = []
  const R = BEND_R
  for (let i = 0; i < samples; i++) {
    const o = TRACK_IN + (i / (samples - 1)) * (TRACK_OUT - TRACK_IN)
    if (o <= 0) {
      // at or inside the measurement line the start is the plain 100 m point
      out.push({ s: WATERFALL_S, o })
      continue
    }
    const r = R + o
    const tangent = Math.sqrt(r * r - R * R)
    const phi = Math.acos(R / r) // bend angle consumed by the tangent chord
    const alpha = Math.PI - (100 - tangent) / R - phi // start angle into the first bend
    out.push({ s: STRAIGHT_M + alpha * R, o })
  }
  return out
}
