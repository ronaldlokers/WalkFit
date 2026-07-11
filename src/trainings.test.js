import { describe, it, expect } from 'vitest'
import { trainings, trainingStats, timeline } from './trainings.js'

describe('trainings data', () => {
  it('every training ends with the fixed 1:45 @ 1.0 km/h cooldown', () => {
    for (const t of trainings) {
      const last = t.segments[t.segments.length - 1]
      expect(last).toEqual({ speed: 1.0, minutes: 1.75 })
    }
  })
})

describe('timeline', () => {
  it('produces contiguous segment boundaries in seconds and a total', () => {
    const t = {
      segments: [
        { speed: 2.5, minutes: 3 },
        { speed: 4.5, minutes: 2 },
      ],
    }
    const { segs, total } = timeline(t)
    expect(segs).toEqual([
      { speed: 2.5, start: 0, end: 180 },
      { speed: 4.5, start: 180, end: 300 },
    ])
    expect(total).toBe(300)
  })
})

describe('trainingStats', () => {
  const t = { segments: [{ speed: 3.0, minutes: 20 }] }

  it('sums duration and integrates distance from speed x time', () => {
    const s = trainingStats(t)
    expect(s.minutes).toBe(20)
    expect(s.distanceKm).toBeCloseTo(1.0, 5) // 3 km/h * (20/60) h
  })

  it('scales the calorie estimate with body weight', () => {
    const light = trainingStats(t, 60).kcal
    const heavy = trainingStats(t, 90).kcal
    expect(heavy).toBeGreaterThan(light)
    expect(heavy / light).toBeCloseTo(1.5, 1) // linear in weight
  })

  it('includes the cooldown in a real preset total', () => {
    const fatburn = trainings.find((t) => t.id === 'fatburn30')
    // 3 + 24 + 3 warm/work/cool + 1.75 cooldown
    expect(trainingStats(fatburn).minutes).toBeCloseTo(31.75, 5)
  })
})
