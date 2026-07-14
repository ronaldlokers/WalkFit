import { describe, it, expect } from 'vitest'
import {
  worldHash,
  trackPoint,
  LAP_M,
  STRAIGHT_M,
  BEND_R,
  LANE_W,
  TRACK_IN,
  TRACK_OUT,
  SCENERY_CLEAR_M,
  surroundings,
  distanceSigns,
  laneStaggers,
  laneMeasurementO,
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
  weatherFor,
  WEATHER_FOG,
  TIME_PHASES,
  isNight,
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
      expect(n.o).toBeCloseTo(TRACK_IN + (n.lane - 0.5) * LANE_W, 10) // lane centre (paint)
      expect(n.s).toBe(LANE_NUMBER_S)
    }
  })

  it('measurement lines follow the official convention (#54)', () => {
    expect(TRACK_IN).toBeCloseTo(-0.3, 10) // kerb 0.30 m inside the lane-1 line
    expect(laneMeasurementO(1)).toBe(0)
    // lanes 2+: 0.20 m out from their inner lane line
    expect(laneMeasurementO(2)).toBeCloseTo(-0.3 + LANE_W + 0.2, 10)
    expect(laneMeasurementO(6)).toBeCloseTo(-0.3 + 5 * LANE_W + 0.2, 10)
  })

  it('break line sits at the 200 m point (end of the first bend)', () => {
    expect(BREAK_LINE_S).toBeCloseTo(200, 10)
  })

  it('laneDistanceToS: identity in lane 1, and every lane finishes its 400 m at the line', () => {
    for (const d of [0, 45, 100, 250, 399]) expect(laneDistanceToS(0, d)).toBeCloseTo(d, 8)
    for (let k = 1; k <= 6; k++) {
      expect(laneDistanceToS(laneMeasurementO(k), 400) % 400).toBeCloseTo(0, 6)
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
    expect(onLine(TRACK_IN)).toBe(10) // inner edge: lane 1 only
    expect(onLine(TRACK_IN + 6 * LANE_W)).toBe(10) // outer edge: lane 6 only
    expect(onLine(TRACK_IN + LANE_W)).toBe(20) // lane1/lane2 shared line
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

  it('staggers match the published World Athletics tables (#54)', () => {
    const staggers = laneStaggers()
    expect(staggers.map((st) => st.lane)).toEqual([2, 3, 4, 5, 6])
    // official one-lap staggers for 1.22 m lanes, measured at 0.20 m from the inner
    // line: 2π·((k−1)·1.22 − 0.10) — the numbers painted on real tracks
    const published = [7.04, 14.7, 22.37, 30.03, 37.7]
    for (const [i, st] of staggers.entries()) {
      expect(st.s).toBeCloseTo(2 * Math.PI * laneMeasurementO(st.lane), 10)
      expect(st.s).toBeCloseTo(published[i]!, 1)
      // walking the lane's 400 m from its stagger ends exactly on the finish line
      expect(laneDistanceToS(laneMeasurementO(st.lane), 400) % 400).toBeCloseTo(0, 6)
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

describe('ambience (#72)', () => {
  it('weather is deterministic per seed and covers all variants', () => {
    expect(weatherFor(1)).toBe(weatherFor(1))
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(weatherFor(i))
    expect([...seen].sort()).toEqual(['clear', 'mist', 'overcast'])
  })

  it('overcast and mist dim the sun and pull the sky toward gray', () => {
    const clear = skyAt(0.45, 'clear')
    const overcast = skyAt(0.45, 'overcast')
    const mist = skyAt(0.45, 'mist')
    expect(overcast.sunIntensity).toBeLessThan(clear.sunIntensity)
    expect(mist.sunIntensity).toBeLessThan(clear.sunIntensity)
    expect(WEATHER_FOG.mist.far).toBeLessThan(WEATHER_FOG.clear.far)
  })

  it('fixed time-of-day phases sit inside sensible bands', () => {
    expect(isNight(TIME_PHASES.night)).toBe(true)
    expect(isNight(TIME_PHASES.day)).toBe(false)
    expect(isNight(TIME_PHASES.dawn)).toBe(false)
    expect(TIME_PHASES.sunset).toBeCloseTo(0.75, 5)
  })
})
