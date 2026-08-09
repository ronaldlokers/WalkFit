import { describe, expect, it } from 'vitest'
import { sessionCardMetrics } from './shareCard'

describe('sessionCardMetrics', () => {
  it('derives display metrics from the corrected session totals', () => {
    expect(
      sessionCardMetrics({
        date: '2026-08-09T08:00:00.000Z',
        distance: 1500,
        duration: 1200,
        kcal: 71.6,
        avgHr: null,
      }),
    ).toEqual({ distanceKm: 1.5, durationMin: 20, kcal: 72, avgSpeedKmh: 4.5 })
  })

  it('does not produce an infinite speed for a zero-duration imported session', () => {
    const metrics = sessionCardMetrics({
      date: '2026-08-09T08:00:00.000Z',
      distance: 0,
      duration: 0,
      kcal: 0,
      avgHr: null,
    })
    expect(metrics.avgSpeedKmh).toBe(0)
  })
})
