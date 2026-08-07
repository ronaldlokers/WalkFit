import { describe, it, expect } from 'vitest'
import {
  pacers,
  PACER_LANES,
  PACER_LATERAL_M,
  INTERVAL_PERIOD_M,
  INTERVAL_FAST_KMH,
  INTERVAL_SLOW_KMH,
  DEFAULT_STRIDE_M,
  MIN_STRIDE_M,
  MAX_STRIDE_M,
  strideLength,
  stepPhase,
  cadenceHz,
  paceGap,
} from './scenicLife'
import { TRACK_IN, LANE_W } from './scenic'
import { TIER_BUDGET } from './scenicQuality'

const LAP = 400 // scenic.ts LAP_M, restated so the test does not depend on the module it checks

describe('pacers', () => {
  it('is deterministic: same inputs give deep-equal results', () => {
    expect(pacers(37.5, 8)).toEqual(pacers(37.5, 8))
  })

  it('honours the requested count and keeps every lane in the allowed set', () => {
    for (const n of [0, 1, 3, 8]) {
      const list = pacers(12, n)
      expect(list).toHaveLength(n)
      for (const p of list) expect(PACER_LANES).toContain(p.lane)
    }
  })

  it('every pacer advances as time moves forward', () => {
    const a = pacers(0, 8)
    const b = pacers(30, 8)
    a.forEach((p, i) => expect(b[i]!.d).toBeGreaterThan(p.d))
  })

  it('distance advances at the pacer own speed over a short window', () => {
    const dt = 10
    const a = pacers(100, 8)
    const b = pacers(100 + dt, 8)
    a.forEach((p, i) => {
      if (p.kind === 'intervals') return // its speed varies within the window
      const expected = ((p.speed * 1000) / 3600) * dt
      expect(b[i]!.d - p.d).toBeCloseTo(expected, 3)
    })
  })

  it('at t=0, same-lane pacers start at least 8 m apart with different speeds', () => {
    const list = pacers(0, 8)
    for (const lane of PACER_LANES) {
      const inLane = list.filter((p) => p.lane === lane)
      for (let i = 0; i < inLane.length; i++) {
        for (let j = i + 1; j < inLane.length; j++) {
          const gap = Math.abs(inLane[i]!.d - inLane[j]!.d)
          const wrapped = Math.min(gap, LAP - gap)
          expect(`lane ${lane} gap ${wrapped.toFixed(1)}`).toBe(
            wrapped >= 8 ? `lane ${lane} gap ${wrapped.toFixed(1)}` : `lane ${lane} gap >= 8`,
          )
          expect(inLane[i]!.speed).not.toBeCloseTo(inLane[j]!.speed, 3)
        }
      }
    }
  })

  it('same-lane pacers stay on opposite sides of the lane, so overtakes never intersect', () => {
    // Different speeds mean the faster WILL lap the slower — the lane-3 pair closes to
    // within 8 m by about t = 65 s. Sampling only t = 0 hid this. What has to hold is that
    // when they do meet, they are laterally apart.
    for (let t = 0; t <= 400; t += 5) {
      const byLane = new Map<number, { d: number; drawO: number }[]>()
      for (const p of pacers(t, 8)) {
        const arr = byLane.get(p.lane) ?? []
        arr.push({ d: p.d, drawO: p.drawO })
        byLane.set(p.lane, arr)
      }
      for (const [lane, list] of byLane) {
        for (let a = 0; a < list.length; a++) {
          for (let b = a + 1; b < list.length; b++) {
            const sep = Math.abs(list[a]!.drawO - list[b]!.drawO)
            expect(`t=${t} lane ${lane} lateral ${sep.toFixed(2)}`).toBe(
              sep >= PACER_LATERAL_M
                ? `t=${t} lane ${lane} lateral ${sep.toFixed(2)}`
                : `t=${t} lane ${lane} lateral >= ${PACER_LATERAL_M}`,
            )
          }
        }
      }
    }
  })

  it('every pacer is drawn inside its own lane markings', () => {
    // laneMeasurementO is 0.2 m in from the lane's inner edge, NOT the centre — offsetting
    // from it put row-0 pacers 0.1 m into the neighbouring lane.
    for (const p of pacers(0, 8)) {
      const inner = TRACK_IN + (p.lane - 1) * LANE_W
      const outer = TRACK_IN + p.lane * LANE_W
      expect(
        `lane ${p.lane} drawO ${p.drawO.toFixed(3)} in [${inner.toFixed(3)}, ${outer.toFixed(3)}]`,
      ).toBe(
        p.drawO > inner && p.drawO < outer
          ? `lane ${p.lane} drawO ${p.drawO.toFixed(3)} in [${inner.toFixed(3)}, ${outer.toFixed(3)}]`
          : `lane ${p.lane} drawO inside its lane`,
      )
    }
  })

  it('the pacer budget never exceeds what the two-sided lane scheme can separate', () => {
    // drawO alternates by row parity, so a third pacer in a lane lands back on row 0's side.
    // If you raise this budget, give lateral offsets more than two positions first.
    expect(TIER_BUDGET.high.pacers).toBeLessThanOrEqual(PACER_LANES.length * 2)
  })

  it('interval pacers hit exactly their fast and slow speeds within each cycle', () => {
    // sample a whole cycle at a fine step and confirm both plateaus are reached
    const seen = new Set<number>()
    for (let t = 0; t < 600; t += 0.25) {
      for (const p of pacers(t, 8)) {
        if (p.kind === 'intervals') seen.add(Math.round(p.speed * 100))
      }
    }
    expect(seen.has(Math.round(INTERVAL_FAST_KMH * 100))).toBe(true)
    expect(seen.has(Math.round(INTERVAL_SLOW_KMH * 100))).toBe(true)
    // and never anything outside the two plateaus — this is a square cycle, not a ramp
    for (const v of seen) {
      expect(`speed ${v}`).toBe(
        v === Math.round(INTERVAL_FAST_KMH * 100) || v === Math.round(INTERVAL_SLOW_KMH * 100)
          ? `speed ${v}`
          : `speed fast-or-slow`,
      )
    }
  })

  it('interval distance is analytic: a full cycle covers exactly INTERVAL_PERIOD_M', () => {
    const p0 = pacers(0, 8).find((p) => p.kind === 'intervals')!
    // seconds for one full cycle: half the period at fast, half at slow
    const half = INTERVAL_PERIOD_M / 2
    const cycleSecs =
      half / ((INTERVAL_FAST_KMH * 1000) / 3600) + half / ((INTERVAL_SLOW_KMH * 1000) / 3600)
    const p1 = pacers(cycleSecs, 8).find((p) => p.kind === 'intervals')!
    expect(p1.d - p0.d).toBeCloseTo(INTERVAL_PERIOD_M, 3)
  })
})

describe('strideLength', () => {
  it('measures your real stride from the belt pedometer', () => {
    expect(strideLength(1000, 1400)).toBeCloseTo(0.714, 3)
  })

  it('falls back to the default when there is no pedometer data', () => {
    // pre-#43 device state, a sensor gap, or the very first tick of a session
    expect(strideLength(0, 0)).toBe(DEFAULT_STRIDE_M)
    expect(strideLength(500, 0)).toBe(DEFAULT_STRIDE_M)
  })

  it('clamps nonsense rather than letting the legs thrash', () => {
    expect(strideLength(1000, 2)).toBe(MAX_STRIDE_M) // 500 m per step
    expect(strideLength(1, 1000)).toBe(MIN_STRIDE_M) // 1 mm per step
  })
})

describe('stepPhase', () => {
  it('completes exactly one cycle per stride walked', () => {
    const s = 0.72
    expect(stepPhase(0, s)).toBeCloseTo(0, 6)
    expect(stepPhase(s * 0.5, s)).toBeCloseTo(0.5, 6)
    expect(stepPhase(s * 3, s)).toBeCloseTo(0, 6)
  })

  it('is continuous across the lap wrap', () => {
    // phase comes from total distance, so 400 m is not special — but guard it anyway,
    // because a naive implementation keyed off trackPoint's wrapped s would jump here
    const s = 0.72
    const a = stepPhase(399.999, s)
    const b = stepPhase(400.001, s)
    expect(Math.abs(b - a)).toBeLessThan(0.01)
  })

  it('always lands in [0, 1)', () => {
    for (const d of [0, 0.1, 12.34, 399.99, 1000.5]) {
      const p = stepPhase(d, 0.72)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })
})

describe('cadenceHz', () => {
  it('rises with speed and falls with a longer stride', () => {
    expect(cadenceHz(6, 0.72)).toBeGreaterThan(cadenceHz(3, 0.72))
    expect(cadenceHz(5, 0.9)).toBeLessThan(cadenceHz(5, 0.6))
  })

  it('gives a plausible walking cadence at a walking pace', () => {
    // 5 km/h at a 0.72 m stride is about 116 steps per minute
    expect(cadenceHz(5, 0.72) * 60).toBeCloseTo(115.7, 1)
  })

  it('is zero when stopped', () => {
    expect(cadenceHz(0, 0.72)).toBe(0)
  })
})

describe('paceGap', () => {
  it('is positive when the rabbit is ahead of you', () => {
    expect(paceGap(100, 130)).toBe(30)
  })

  it('is negative when you are ahead of the rabbit', () => {
    expect(paceGap(160, 130)).toBe(-30)
  })

  it('is zero when level', () => {
    expect(paceGap(250, 250)).toBe(0)
  })

  it('does not wrap at the lap boundary — it is a total-distance gap, not a lap position', () => {
    // you have run a full lap more than the rabbit; that is a 400 m lead, not level
    expect(paceGap(800, 400)).toBe(-400)
  })
})
