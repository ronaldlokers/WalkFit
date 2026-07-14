import { describe, it, expect, beforeEach } from 'vitest'
import { exportData, importData } from './backup'
import { loadStatistics } from './statistics'
import { loadWeightLog } from './weight'

beforeEach(() => localStorage.clear())

const session = (date: string, distance = 1000) => ({
  date,
  distance,
  duration: 600,
  kcal: 50,
  avgHr: null,
})

describe('exportData (#69)', () => {
  it('exports walkfit.* keys, excluding tokens and the mid-walk snapshot by default', () => {
    localStorage.setItem('walkfit.history', JSON.stringify([session('2026-07-13T08:00:00.000Z')]))
    localStorage.setItem('walkfit.strava', '{"accessToken":"secret"}')
    localStorage.setItem('walkfit.withings', '{"accessToken":"secret"}')
    localStorage.setItem('walkfit.session.inprogress', '{"distance":100}')
    localStorage.setItem('unrelated.key', 'nope')
    const parsed = JSON.parse(exportData())
    expect(parsed.app).toBe('walkfit')
    expect(Object.keys(parsed.data)).toEqual(['walkfit.history'])
  })

  it('includes tokens only when asked', () => {
    localStorage.setItem('walkfit.strava', '{"accessToken":"secret"}')
    expect(JSON.parse(exportData(true)).data['walkfit.strava']).toContain('secret')
  })
})

describe('importData (#69)', () => {
  it('merges sessions and weigh-ins without duplicating, overwrites the rest', () => {
    localStorage.setItem('walkfit.history', JSON.stringify([session('2026-07-13T08:00:00.000Z')]))
    localStorage.setItem(
      'walkfit.weight.log',
      JSON.stringify([{ date: '2026-07-10T07:00:00.000Z', kg: 84, source: 'manual' }]),
    )
    localStorage.setItem('walkfit.goals', '{"kcal":500,"steps":8000,"minutes":30}')

    const backup = JSON.stringify({
      app: 'walkfit',
      version: 1,
      data: {
        'walkfit.history': JSON.stringify([
          session('2026-07-13T08:00:00.000Z', 999), // duplicate date: existing wins
          session('2026-07-12T08:00:00.000Z', 800), // new: merged in
        ]),
        'walkfit.weight.log': JSON.stringify([
          { date: '2026-07-10T07:00:00.000Z', kg: 84, source: 'manual' },
          { date: '2026-07-11T07:00:00.000Z', kg: 83.5, source: 'manual' },
        ]),
        'walkfit.goals': '{"kcal":600,"steps":9000,"minutes":45}',
        'walkfit.session.inprogress': '{"distance":1}', // transient: ignored
      },
    })
    const applied = importData(backup)
    expect(applied).toBe(3)
    const sessions = loadStatistics()
    expect(sessions.map((s) => s.distance)).toEqual([800, 1000]) // sorted, original kept
    expect(loadWeightLog()).toHaveLength(2)
    expect(localStorage.getItem('walkfit.goals')).toContain('600')
    expect(localStorage.getItem('walkfit.session.inprogress')).toBeNull()
  })

  it('rejects files that are not WalkFit backups', () => {
    expect(() => importData('{"foo":1}')).toThrow(/not a walkfit backup/i)
    expect(() => importData('garbage')).toThrow(/not a valid json/i)
  })
})
