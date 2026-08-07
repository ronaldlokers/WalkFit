import { describe, it, expect } from 'vitest'
import {
  pacers,
  PACER_LANES,
  INTERVAL_PERIOD_M,
  INTERVAL_FAST_KMH,
  INTERVAL_SLOW_KMH,
} from './scenicLife'

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

  it('same-lane pacers start apart and travel at different speeds, so they never merge', () => {
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
