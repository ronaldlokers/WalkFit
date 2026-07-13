import { describe, it, expect, beforeEach } from 'vitest'
import { loadHistory, addSession, weeklyTotals, currentStreak } from './history'

beforeEach(() => localStorage.clear())

describe('addSession / loadHistory', () => {
  it('persists entries across loads', () => {
    addSession({
      date: '2026-01-05T08:00:00.000Z',
      distance: 1000,
      duration: 600,
      kcal: 50,
      avgHr: null,
    })
    expect(loadHistory()).toEqual([
      { date: '2026-01-05T08:00:00.000Z', distance: 1000, duration: 600, kcal: 50, avgHr: null },
    ])
  })

  it('recovers from corrupt storage instead of throwing', () => {
    localStorage.setItem('walkfit.history', '{not json')
    expect(loadHistory()).toEqual([])
  })
})

describe('weeklyTotals', () => {
  it('groups by ISO week, most recent first', () => {
    const history = [
      { date: '2026-01-05T08:00:00.000Z', distance: 1000, duration: 600, kcal: 50, avgHr: null }, // Mon wk2
      { date: '2026-01-06T08:00:00.000Z', distance: 2000, duration: 1200, kcal: 90, avgHr: null }, // Tue wk2
      { date: '2025-12-29T08:00:00.000Z', distance: 500, duration: 300, kcal: 20, avgHr: null }, // Mon wk1
    ]
    const totals = weeklyTotals(history)
    expect(totals).toEqual([
      { week: '2026-W02', sessions: 2, distance: 3000, duration: 1800, kcal: 140 },
      { week: '2026-W01', sessions: 1, distance: 500, duration: 300, kcal: 20 },
    ])
  })
})

describe('currentStreak', () => {
  it('counts consecutive days ending today', () => {
    const now = new Date('2026-01-07T12:00:00.000Z')
    const history = [
      { date: '2026-01-07T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
      { date: '2026-01-06T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
      { date: '2026-01-05T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
    ]
    expect(currentStreak(history, now)).toBe(3)
  })

  it('still counts the streak if today has no walk yet but yesterday did', () => {
    const now = new Date('2026-01-07T07:00:00.000Z')
    const history = [
      { date: '2026-01-06T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
    ]
    expect(currentStreak(history, now)).toBe(1)
  })

  it('breaks once a full day is missed', () => {
    const now = new Date('2026-01-07T12:00:00.000Z')
    const history = [
      { date: '2026-01-04T08:00:00.000Z', distance: 1, duration: 1, kcal: 1, avgHr: null },
    ]
    expect(currentStreak(history, now)).toBe(0)
  })

  it('returns 0 for empty history', () => {
    expect(currentStreak([])).toBe(0)
  })
})
