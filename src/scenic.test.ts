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

  it('relay zones: a line per lane at both limits of the three 30 m zones', () => {
    const lines = relayZoneLines()
    expect(lines.length).toBe(3 * 2 * 6)
    expect([...new Set(lines.map((l) => l.s))].sort((a, b) => a - b)).toEqual([
      80, 110, 180, 210, 280, 310,
    ])
    for (const l of lines) expect(l.o1 - l.o0).toBeCloseTo(LANE_W, 10)
  })

  it('400 mH: ten flights from 45 m every 35 m, ticks on each lane boundary', () => {
    const ticks = hurdleTicks()
    const sVals = [...new Set(ticks.map((t) => t.s))]
    expect(sVals).toEqual([45, 80, 115, 150, 185, 220, 255, 290, 325, 360])
    expect(ticks.length).toBe(10 * 7)
  })

  it('waterfall start: flat at the inner edge, bowing monotonically forward outward', () => {
    const pts = waterfallPoints()
    expect(pts[0]!.s).toBeCloseTo(WATERFALL_S, 5)
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.s).toBeGreaterThanOrEqual(pts[i - 1]!.s)
      expect(pts[i]!.o).toBeGreaterThan(pts[i - 1]!.o)
    }
    expect(pts[pts.length - 1]!.s - WATERFALL_S).toBeLessThan(6) // gentle bow
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
