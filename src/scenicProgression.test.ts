import { describe, expect, it } from 'vitest'
import {
  dailyMission,
  initialProgression,
  levelForXp,
  recordCompletedWalk,
  weeklyMission,
} from './scenicProgression'

describe('scenic progression', () => {
  it('derives stable levels and date-keyed missions', () => {
    expect(levelForXp(0)).toBe(1)
    expect(levelForXp(100)).toBe(2)
    expect(dailyMission('2026-08-10')).toEqual(dailyMission('2026-08-10'))
    expect(weeklyMission('2026-08-10').id).toBe(weeklyMission('2026-08-12').id)
  })

  it('awards safe activity progress, streak, route badge, and cosmetic unlocks', () => {
    const state = recordCompletedWalk(initialProgression(), {
      dateKey: '2026-08-10',
      distanceM: 800,
      activeMinutes: 30,
      workoutCompleted: true,
      routeId: 'stadium-park',
      routeDistanceM: 800,
    })
    expect(state.xp).toBeGreaterThan(100)
    expect(state.level).toBeGreaterThanOrEqual(2)
    expect(state.routeBadges).toContain('stadium-park')
    expect(state.personalBestsM['stadium-park']).toBe(800)
    expect(state.cosmeticUnlocks).toContain('coral')
    const next = recordCompletedWalk(state, {
      dateKey: '2026-08-11',
      distanceM: 100,
      activeMinutes: 5,
    })
    expect(next.streakDays).toBe(2)
  })
})
