import { describe, it, expect, beforeEach } from 'vitest'
import {
  workouts,
  workoutStats,
  timeline,
  loadCustomWorkouts,
  saveCustomWorkout,
  deleteCustomWorkout,
} from './workouts'

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
    const fatburn = workouts.find((w) => w.id === 'fatburn30')!
    // 3 + 24 + 3 warm/work/cool + 1.75 cooldown
    expect(workoutStats(fatburn).minutes).toBeCloseTo(31.75, 5)
  })
})

describe('custom workouts (#68)', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a custom workout and replaces by id', () => {
    saveCustomWorkout({
      id: 'custom-1',
      name: 'Lunch loop',
      focus: '',
      segments: [
        { speed: 3, minutes: 10 },
        { speed: 5, minutes: 5 },
      ],
    })
    expect(loadCustomWorkouts()).toHaveLength(1)
    saveCustomWorkout({
      id: 'custom-1',
      name: 'Lunch loop v2',
      focus: '',
      segments: [{ speed: 4, minutes: 20 }],
    })
    const list = loadCustomWorkouts()
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('Lunch loop v2')
  })

  it('clamps segments to the device speed range and sane minutes', () => {
    saveCustomWorkout({
      id: 'custom-2',
      name: 'Wild',
      focus: '',
      segments: [
        { speed: 99, minutes: 999 },
        { speed: 0.2, minutes: 0 },
      ],
    })
    expect(loadCustomWorkouts()[0]!.segments).toEqual([
      { speed: 6, minutes: 120 },
      { speed: 1, minutes: 1 },
    ])
  })

  it('drops corrupt entries instead of throwing', () => {
    localStorage.setItem(
      'walkfit.workouts.custom',
      '[{"nope":1},{"id":"x","name":"ok","segments":[{"speed":3,"minutes":5}]}]',
    )
    const list = loadCustomWorkouts()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('x')
  })

  it('deletes by id', () => {
    saveCustomWorkout({ id: 'a', name: 'A', focus: '', segments: [{ speed: 3, minutes: 5 }] })
    saveCustomWorkout({ id: 'b', name: 'B', focus: '', segments: [{ speed: 3, minutes: 5 }] })
    expect(deleteCustomWorkout('a').map((w) => w.id)).toEqual(['b'])
  })
})

describe('custom workout corruption (#136)', () => {
  beforeEach(() => localStorage.clear())

  it('a null segment drops that workout without nuking the rest', () => {
    localStorage.setItem(
      'walkfit.workouts.custom',
      JSON.stringify([
        { id: 'custom-ok', name: 'Good', focus: '', segments: [{ speed: 3, minutes: 10 }] },
        { id: 'custom-bad', name: 'Bad', focus: '', segments: [null] },
      ]),
    )
    const loaded = loadCustomWorkouts()
    expect(loaded.map((w) => w.id)).toEqual(['custom-ok'])
    // and a subsequent save keeps the surviving plan instead of persisting []
    saveCustomWorkout({
      id: 'custom-new',
      name: 'New',
      focus: '',
      segments: [{ speed: 4, minutes: 5 }],
    })
    expect(loadCustomWorkouts().map((w) => w.id)).toEqual(['custom-ok', 'custom-new'])
  })
})
