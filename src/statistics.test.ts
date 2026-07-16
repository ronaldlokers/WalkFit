import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadStatistics,
  addSession,
  removeSession,
  mergeSessions,
  weeklyTotals,
  currentStreak,
  dailyTotals,
  weekStart,
  loadGoals,
  saveGoals,
  DEFAULT_GOALS,
} from './statistics'

beforeEach(() => localStorage.clear())

describe('addSession / loadStatistics', () => {
  it('persists entries across loads', () => {
    addSession({
      date: '2026-01-05T08:00:00.000Z',
      distance: 1000,
      duration: 600,
      kcal: 50,
      avgHr: null,
    })
    expect(loadStatistics()).toEqual([
      { date: '2026-01-05T08:00:00.000Z', distance: 1000, duration: 600, kcal: 50, avgHr: null },
    ])
  })

  it('recovers from corrupt storage instead of throwing', () => {
    localStorage.setItem('walkfit.history', '{not json')
    expect(loadStatistics()).toEqual([])
  })
})

describe('weeklyTotals', () => {
  it('groups by ISO week, most recent first', () => {
    const sessions = [
      { date: '2026-01-05T08:00:00.000Z', distance: 1000, duration: 600, kcal: 50, avgHr: null }, // Mon wk2
      { date: '2026-01-06T08:00:00.000Z', distance: 2000, duration: 1200, kcal: 90, avgHr: null }, // Tue wk2
      { date: '2025-12-29T08:00:00.000Z', distance: 500, duration: 300, kcal: 20, avgHr: null }, // Mon wk1
    ]
    const totals = weeklyTotals(sessions)
    expect(totals).toEqual([
      { week: '2026-W02', sessions: 2, distance: 3000, duration: 1800, kcal: 140 },
      { week: '2026-W01', sessions: 1, distance: 500, duration: 300, kcal: 20 },
    ])
  })
})

describe('currentStreak', () => {
  it('counts consecutive days ending today', () => {
    const now = new Date('2026-01-07T12:00:00.000Z')
    const sessions = [
      { date: '2026-01-07T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
      { date: '2026-01-06T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
      { date: '2026-01-05T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
    ]
    expect(currentStreak(sessions, now)).toBe(3)
  })

  it('still counts the streak if today has no walk yet but yesterday did', () => {
    const now = new Date('2026-01-07T07:00:00.000Z')
    const sessions = [
      { date: '2026-01-06T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
    ]
    expect(currentStreak(sessions, now)).toBe(1)
  })

  it('breaks once a full day is missed', () => {
    const now = new Date('2026-01-07T12:00:00.000Z')
    const sessions = [
      { date: '2026-01-04T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
    ]
    expect(currentStreak(sessions, now)).toBe(0)
  })

  it('returns 0 for empty statistics', () => {
    expect(currentStreak([])).toBe(0)
  })
})

describe('dailyTotals', () => {
  const base = { distance: 1000, duration: 600, kcal: 50 }
  it('zero-fills missing days, oldest first, ending today', () => {
    const now = new Date('2026-01-07T12:00:00')
    const days = dailyTotals(
      [
        { ...base, date: '2026-01-05T08:00:00', steps: 1200, avgHr: null },
        { ...base, date: '2026-01-07T09:00:00', steps: 800, avgHr: null },
      ],
      3,
      now,
    )
    expect(days.map((d) => d.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07'])
    expect(days.map((d) => d.steps)).toEqual([1200, 0, 800])
    expect(days.map((d) => d.sessions)).toEqual([1, 0, 1])
    expect(days[1]).toMatchObject({ kcal: 0, duration: 0, hrMin: null, hrMax: null, hrAvg: null })
  })

  it('sums two sessions on the same day and spans their HR min/max', () => {
    const now = new Date('2026-01-07T12:00:00')
    const [day] = dailyTotals(
      [
        { ...base, date: '2026-01-07T08:00:00', steps: 1000, avgHr: 110, hrMin: 95, hrMax: 130 },
        { ...base, date: '2026-01-07T18:00:00', steps: 500, avgHr: 120, hrMin: 100, hrMax: 145 },
      ],
      1,
      now,
    )
    expect(day).toMatchObject({
      sessions: 2,
      steps: 1500,
      kcal: 100,
      duration: 1200,
      hrMin: 95,
      hrMax: 145,
      hrAvg: 115, // equal durations -> plain mean of 110/120
    })
  })

  it('handles pre-#43 sessions: no steps -> 0, avgHr stands in for the HR range', () => {
    const now = new Date('2026-01-07T12:00:00')
    const [day] = dailyTotals([{ ...base, date: '2026-01-07T08:00:00', avgHr: 105 }], 1, now)
    expect(day).toMatchObject({ steps: 0, hrMin: 105, hrMax: 105, hrAvg: 105 })
  })
})

describe('weekStart', () => {
  it('returns the Monday of the containing week at local midnight', () => {
    // 2026-07-15 is a Wednesday; its week starts Monday 2026-07-13
    const mon = weekStart(new Date('2026-07-15T17:30:00'))
    expect(mon.getFullYear()).toBe(2026)
    expect(mon.getMonth()).toBe(6)
    expect(mon.getDate()).toBe(13)
    expect(mon.getHours()).toBe(0)
  })

  it('Sunday belongs to the week that started the previous Monday', () => {
    expect(weekStart(new Date('2026-07-19T09:00:00')).getDate()).toBe(13)
  })

  it('Monday maps to itself', () => {
    expect(weekStart(new Date('2026-07-13T00:00:00')).getDate()).toBe(13)
  })
})

describe('goals', () => {
  it('defaults to 500 kcal / 8000 steps / 30 min', () => {
    expect(loadGoals()).toEqual(DEFAULT_GOALS)
  })

  it('round-trips saved goals', () => {
    saveGoals({ kcal: 600, steps: 10000, minutes: 45 })
    expect(loadGoals()).toEqual({ kcal: 600, steps: 10000, minutes: 45 })
  })

  it('falls back per-field on corrupt or non-positive values', () => {
    localStorage.setItem('walkfit.goals', '{"kcal":-5,"steps":"junk","minutes":45}')
    expect(loadGoals()).toEqual({ kcal: 500, steps: 8000, minutes: 45 })
    localStorage.setItem('walkfit.goals', '{not json')
    expect(loadGoals()).toEqual(DEFAULT_GOALS)
  })
})

describe('removeSession (#67)', () => {
  it('removes exactly the session with the given start date', () => {
    addSession({
      date: '2026-07-13T08:00:00.000Z',
      distance: 900,
      duration: 600,
      kcal: 40,
      avgHr: null,
    })
    addSession({
      date: '2026-07-14T08:00:00.000Z',
      distance: 1200,
      duration: 800,
      kcal: 55,
      avgHr: null,
    })
    const left = removeSession('2026-07-13T08:00:00.000Z')
    expect(left).toHaveLength(1)
    expect(loadStatistics()[0]!.date).toBe('2026-07-14T08:00:00.000Z')
  })

  it('is a no-op for an unknown date', () => {
    addSession({
      date: '2026-07-14T08:00:00.000Z',
      distance: 1200,
      duration: 800,
      kcal: 55,
      avgHr: null,
    })
    expect(removeSession('1999-01-01T00:00:00.000Z')).toHaveLength(1)
  })
})

describe('session sanitization (#137)', () => {
  it('drops entries with missing/garbage numerics instead of persisting NaN', () => {
    const merged = mergeSessions([
      { date: '2026-07-13T08:00:00.000Z' } as never, // no numerics at all
      { date: '2026-07-14T08:00:00.000Z', distance: 'junk', duration: 600 } as never,
      { date: '2026-07-15T08:00:00.000Z', distance: 800, duration: 600 } as never, // kcal absent -> 0
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ distance: 800, duration: 600, kcal: 0, avgHr: null })
    // nothing NaN reaches the reducers
    const [day] = dailyTotals(merged, 1, new Date('2026-07-15T12:00:00.000Z'))
    expect(Number.isNaN(day!.kcal)).toBe(false)
  })

  it('saveGoals coerces invalid fields so a transient empty input never persists', () => {
    saveGoals({ kcal: '' as never, steps: 9000, minutes: 45 })
    expect(loadGoals()).toEqual({ kcal: 500, steps: 9000, minutes: 45 })
  })
})

describe('mergeSessions (#69)', () => {
  it('unions by date with existing entries winning, sorted', () => {
    addSession({
      date: '2026-07-13T08:00:00.000Z',
      distance: 900,
      duration: 600,
      kcal: 40,
      avgHr: null,
    })
    const merged = mergeSessions([
      { date: '2026-07-13T08:00:00.000Z', distance: 111, duration: 1, kcal: 1, avgHr: null },
      { date: '2026-07-12T08:00:00.000Z', distance: 700, duration: 500, kcal: 30, avgHr: null },
    ])
    expect(merged.map((s) => s.distance)).toEqual([700, 900])
  })

  it('round-trips workout (#142) and series (#149) instead of dropping them', () => {
    const merged = mergeSessions([
      {
        date: '2026-07-13T08:00:00.000Z',
        distance: 900,
        duration: 600,
        kcal: 40,
        avgHr: null,
        workout: 'Fat Burn 30',
        series: [
          [10, 3, 110],
          [20, 3.2, 112],
        ],
      },
    ])
    expect(merged[0]!.workout).toBe('Fat Burn 30')
    expect(merged[0]!.series).toEqual([
      [10, 3, 110],
      [20, 3.2, 112],
    ])
  })

  it('drops malformed series points instead of poisoning the chart with them', () => {
    const merged = mergeSessions([
      {
        date: '2026-07-13T08:00:00.000Z',
        distance: 900,
        duration: 600,
        kcal: 40,
        avgHr: null,
        // @ts-expect-error -- deliberately malformed, simulating a corrupt import
        series: [[10, 3, 110], ['not', 'a', 'point'], [20]],
      },
    ])
    expect(merged[0]!.series).toEqual([[10, 3, 110]])
  })
})
