import { describe, it, expect } from 'vitest'
import {
  worldHash,
  trackPoint,
  LAP_M,
  STRAIGHT_M,
  BEND_R,
  LANE_W,
  TRACK_OUT,
  SCENERY_CLEAR_M,
  surroundings,
  distanceSigns,
  laneStaggers,
  laneNumbers,
  LANE_NUMBER_S,
  BREAK_LINE_S,
  relayZoneLines,
  hurdleTicks,
  waterfallPoints,
  laneDistanceToS,
  WATERFALL_S,
  dayPhase,
  skyAt,
  DAY_LENGTH_M,
} from './scenic'

describe('worldHash', () => {
  it('is deterministic and in [0,1)', () => {
    for (const s of [0, 1, 42, 99991]) {
      const v = worldHash(s)
      expect(v).toBe(worldHash(s))
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(worldHash(1)).not.toBe(worldHash(2))
  })
})

describe('trackPoint (400 m loop)', () => {
  it('wraps every lap: same point at s and s + LAP_M (and negative s)', () => {
    for (const s of [0, 13.7, STRAIGHT_M + 5, 399.9]) {
      const a = trackPoint(s)
      const b = trackPoint(s + LAP_M)
      expect(b.x).toBeCloseTo(a.x, 10)
      expect(b.z).toBeCloseTo(a.z, 10)
    }
    expect(trackPoint(-10).x).toBeCloseTo(trackPoint(LAP_M - 10).x, 10)
  })

  it('the lane-1 walking line measures exactly 400 m (numeric integration)', () => {
    const N = 40000
    let len = 0
    let prev = trackPoint(0)
    for (let i = 1; i <= N; i++) {
      const p = trackPoint((i / N) * LAP_M)
      len += Math.hypot(p.x - prev.x, p.z - prev.z)
      prev = p
    }
    expect(len).toBeCloseTo(LAP_M, 1)
  })

  it('straights are straight and bends sit at the bend radius', () => {
    // home straight: constant x = BEND_R, heading -z
    for (const s of [0, 20, STRAIGHT_M - 1]) {
      const p = trackPoint(s)
      expect(p.x).toBeCloseTo(BEND_R, 10)
      expect(p.tx).toBeCloseTo(0, 10)
      expect(p.tz).toBeCloseTo(-1, 10)
    }
    // mid-bend point is BEND_R from the bend centre (0, -STRAIGHT_M/2)
    const mid = trackPoint(STRAIGHT_M + (Math.PI * BEND_R) / 2)
    expect(Math.hypot(mid.x, mid.z + STRAIGHT_M / 2)).toBeCloseTo(BEND_R, 8)
  })

  it('tangent is always unit length and continuous across segment joins', () => {
    for (let s = 0; s < LAP_M; s += 0.5) {
      const p = trackPoint(s)
      expect(Math.hypot(p.tx, p.tz)).toBeCloseTo(1, 8)
    }
    for (const joint of [0, STRAIGHT_M, STRAIGHT_M + Math.PI * BEND_R, LAP_M - 0.0001]) {
      const a = trackPoint(joint - 0.01)
      const b = trackPoint(joint + 0.01)
      expect(Math.hypot(a.tx - b.tx, a.tz - b.tz)).toBeLessThan(0.01)
    }
  })

  it('lateral offset moves outward: larger o is farther from the loop centre', () => {
    for (const s of [10, 120, 250, 380]) {
      const inner = trackPoint(s, 0)
      const outer = trackPoint(s, 5)
      // compare distance from the nearest bend centre / spine
      expect(Math.hypot(outer.x, outer.z) + 0.001).toBeGreaterThan(Math.hypot(inner.x, inner.z))
    }
  })
})

describe('surroundings', () => {
  it('is deterministic', () => {
    expect(surroundings()).toEqual(surroundings())
  })

  it('keeps all scenery clear of the track band', () => {
    for (const p of surroundings()) {
      if (p.type === 'flood') expect(p.o).toBeGreaterThan(TRACK_OUT)
      else expect(p.o).toBeGreaterThanOrEqual(TRACK_OUT + SCENERY_CLEAR_M)
    }
  })

  it('places four floodlights evenly around the loop', () => {
    const floods = surroundings().filter((p) => p.type === 'flood')
    expect(floods.map((f) => f.s)).toEqual([50, 150, 250, 350])
  })
})

describe('track markings', () => {
  it('one painted number per lane, centred on each lane, just past the finish', () => {
    const nums = laneNumbers()
    expect(nums.map((n) => n.lane)).toEqual([1, 2, 3, 4, 5, 6])
    for (const n of nums) {
      expect(n.o).toBeCloseTo((n.lane - 1) * LANE_W, 10) // lane centreline
      expect(n.s).toBe(LANE_NUMBER_S)
    }
  })

  it('break line sits at the 200 m point (end of the first bend)', () => {
    expect(BREAK_LINE_S).toBeCloseTo(200, 10)
  })

  it('laneDistanceToS: identity in lane 1, and every lane finishes its 400 m at the line', () => {
    for (const d of [0, 45, 100, 250, 399]) expect(laneDistanceToS(0, d)).toBeCloseTo(d, 8)
    for (let k = 0; k < 6; k++) {
      expect(laneDistanceToS(k * LANE_W, 400) % 400).toBeCloseTo(0, 6)
    }
  })

  it('relay zones: per-lane exact positions, fanning forward on the bends', () => {
    const lines = relayZoneLines()
    expect(lines.length).toBe(6 * 3 * 2)
    // lane 1 limits are the plain arc positions
    const lane1 = lines.filter((l) => l.o0 < 0).map((l) => l.s)
    expect(lane1.map((s) => Math.round(s * 100) / 100)).toEqual([80, 110, 180, 210, 280, 310])
    // outer lanes' first-zone entry (80 lane-metres in) sits past the bend start, so
    // its lane-1 arc position is beyond 80 — the marks fan forward like the staggers
    const lane6entry = lines.filter((l) => l.o1 > 6.5).map((l) => l.s)[0]!
    expect(lane6entry).toBeGreaterThan(80)
  })

  it('400 mH: 10 flights per lane measured along that lane, ticks on both lane lines', () => {
    const ticks = hurdleTicks()
    expect(ticks.length).toBe(6 * 10 * 2)
    // lane 1: first flight exactly at 45 m, last at 360 m
    const lane1S = [...new Set(ticks.filter((t) => t.o < 0).map((t) => t.s))]
    expect(lane1S[0]).toBeCloseTo(45, 8)
    expect(lane1S[9]).toBeCloseTo(360, 8)
    // edge lines carry one lane's marks; interior lines are shared, so they carry the
    // marks of BOTH adjacent lanes (at that lane's own positions) — like a real track
    const onLine = (o: number) => ticks.filter((t) => Math.abs(t.o - o) < 1e-9).length
    expect(onLine(-LANE_W / 2)).toBe(10) // inner edge: lane 1 only
    expect(onLine(-LANE_W / 2 + 6 * LANE_W)).toBe(10) // outer edge: lane 6 only
    expect(onLine(LANE_W / 2)).toBe(20) // lane1/lane2 shared line
  })

  it('waterfall start: the tangent path from every point measures exactly 300 m home', () => {
    const R = BEND_R
    for (const p of waterfallPoints(9)) {
      if (p.o <= 0) {
        expect(p.s).toBeCloseTo(WATERFALL_S, 8)
        continue
      }
      // reconstruct the runner's path: tangent chord to the lane-1 circle, remaining
      // bend arc, then bend exit → finish (200 m) — must equal 300 m
      const r = R + p.o
      const alpha = (p.s - STRAIGHT_M) / R
      const tangent = Math.sqrt(r * r - R * R)
      const phi = Math.acos(R / r)
      const arc = R * (Math.PI - alpha - phi)
      expect(tangent + arc + 200).toBeCloseTo(300, 8)
      expect(alpha).toBeGreaterThan(0) // still on the first bend
    }
    // monotone forward bow
    const pts = waterfallPoints()
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.s).toBeGreaterThanOrEqual(pts[i - 1]!.s)
  })

  it('distance signs at 100/200/300 m', () => {
    expect(distanceSigns()).toEqual([
      { s: 100, label: '100 m' },
      { s: 200, label: '200 m' },
      { s: 300, label: '300 m' },
    ])
  })

  it('staggers make every lane lap exactly 400 m to the common finish', () => {
    const staggers = laneStaggers()
    expect(staggers.map((st) => st.lane)).toEqual([2, 3, 4, 5, 6])
    for (const st of staggers) {
      const k = st.lane - 1
      const centre = (st.o0 + st.o1) / 2
      expect(centre).toBeCloseTo(k * LANE_W, 10) // lane centreline offset
      // lane lap = 400 + 2π·o(centre); stagger equals the surplus, so lap-to-finish = 400
      expect(st.s).toBeCloseTo(2 * Math.PI * centre, 10)
      // and every stagger sits on the home straight (constant-s strip is perpendicular)
      expect(st.s).toBeLessThan(STRAIGHT_M)
    }
  })
})

describe('day/night', () => {
  it('phase starts at dawn (0) and wraps after DAY_LENGTH_M', () => {
    expect(dayPhase(0)).toBe(0)
    expect(dayPhase(DAY_LENGTH_M / 2)).toBe(0.5)
    expect(dayPhase(DAY_LENGTH_M)).toBe(0)
  })

  it('skyAt lerps between keyframes and matches endpoints across the wrap', () => {
    const dawn = skyAt(0)
    const wrapped = skyAt(0.999999)
    expect(wrapped.sky).toBeCloseTo(dawn.sky, -2)
    const day = skyAt(0.45)
    const night = skyAt(0.87)
    expect(day.sunIntensity).toBeGreaterThan(night.sunIntensity)
    expect(day.ambient).toBeGreaterThan(night.ambient)
  })
})
