import { describe, it, expect } from 'vitest'
import { workouts, workoutStats, timeline } from './workouts.js'

describe('workouts data', () => {
  it('every workout ends with the fixed 1:45 @ 1.0 km/h cooldown', () => {
    for (const w of workouts) {
      const last = w.segments[w.segments.length - 1]
      expect(last).toEqual({ speed: 1.0, minutes: 1.75 })
    }
  })
})

describe('timeline', () => {
  it('produces contiguous segment boundaries in seconds and a total', () => {
    const w = {
      segments: [
        { speed: 2.5, minutes: 3 },
        { speed: 4.5, minutes: 2 },
      ],
    }
    const { segs, total } = timeline(w)
    expect(segs).toEqual([
      { speed: 2.5, start: 0, end: 180 },
      { speed: 4.5, start: 180, end: 300 },
    ])
    expect(total).toBe(300)
  })
})

describe('workoutStats', () => {
  const w = { segments: [{ speed: 3.0, minutes: 20 }] }

  it('sums duration and integrates distance from speed x time', () => {
    const s = workoutStats(w)
    expect(s.minutes).toBe(20)
    expect(s.distanceKm).toBeCloseTo(1.0, 5) // 3 km/h * (20/60) h
  })

  it('scales the calorie estimate with body weight', () => {
    const light = workoutStats(w, 60).kcal
    const heavy = workoutStats(w, 90).kcal
    expect(heavy).toBeGreaterThan(light)
    expect(heavy / light).toBeCloseTo(1.5, 1) // linear in weight
  })

  it('includes the cooldown in a real preset total', () => {
    const fatburn = workouts.find((w) => w.id === 'fatburn30')
    // 3 + 24 + 3 warm/work/cool + 1.75 cooldown
    expect(workoutStats(fatburn).minutes).toBeCloseTo(31.75, 5)
  })
})
