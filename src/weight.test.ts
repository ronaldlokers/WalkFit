import { describe, it, expect, beforeEach } from 'vitest'
import { loadWeightLog, addWeighIn, mergeWeighIns } from './weight'

beforeEach(() => localStorage.clear())

describe('addWeighIn / loadWeightLog', () => {
  it('persists entries across loads', () => {
    addWeighIn({ date: '2026-07-01T07:00:00.000Z', kg: 82.4, source: 'manual' })
    expect(loadWeightLog()).toEqual([
      { date: '2026-07-01T07:00:00.000Z', kg: 82.4, source: 'manual' },
    ])
  })

  it('recovers from corrupt storage instead of throwing', () => {
    localStorage.setItem('walkfit.weight.log', '{not json')
    expect(loadWeightLog()).toEqual([])
  })

  it('keeps the log date-sorted regardless of insertion order', () => {
    addWeighIn({ date: '2026-07-03T07:00:00.000Z', kg: 82.0, source: 'manual' })
    addWeighIn({ date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'manual' })
    addWeighIn({ date: '2026-07-02T07:00:00.000Z', kg: 82.3, source: 'manual' })
    expect(loadWeightLog().map((e) => e.kg)).toEqual([82.6, 82.3, 82.0])
  })
})

describe('mergeWeighIns', () => {
  it('is idempotent on source+date — re-syncing the same batch adds nothing', () => {
    const batch = [
      { date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings' },
      { date: '2026-07-02T07:00:00.000Z', kg: 82.3, source: 'withings' },
    ]
    mergeWeighIns(batch)
    const again = mergeWeighIns(batch)
    expect(again).toHaveLength(2)
  })

  it('a same-key entry overwrites (provider corrected a reading)', () => {
    mergeWeighIns([{ date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings' }])
    mergeWeighIns([{ date: '2026-07-01T07:00:00.000Z', kg: 82.1, source: 'withings' }])
    expect(loadWeightLog()).toEqual([
      { date: '2026-07-01T07:00:00.000Z', kg: 82.1, source: 'withings' },
    ])
  })

  it('same instant from different sources stays two entries', () => {
    mergeWeighIns([
      { date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings' },
      { date: '2026-07-01T07:00:00.000Z', kg: 82.5, source: 'manual' },
    ])
    expect(loadWeightLog()).toHaveLength(2)
  })
})

describe('grpid keying (#57)', () => {
  it('a timestamp correction with the same grpid replaces instead of duplicating', () => {
    mergeWeighIns([{ date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings', grpid: 9 }])
    // user corrects the reading's time in the Withings app -> same grpid, new date
    mergeWeighIns([{ date: '2026-07-01T08:30:00.000Z', kg: 82.6, source: 'withings', grpid: 9 }])
    expect(loadWeightLog()).toEqual([
      { date: '2026-07-01T08:30:00.000Z', kg: 82.6, source: 'withings', grpid: 9 },
    ])
  })

  it('adopts a grpid onto a legacy same-date entry instead of duplicating', () => {
    mergeWeighIns([{ date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings' }]) // pre-grpid
    mergeWeighIns([{ date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings', grpid: 9 }])
    expect(loadWeightLog()).toEqual([
      { date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings', grpid: 9 },
    ])
  })

  it('distinct grpids at the same instant stay two entries', () => {
    mergeWeighIns([
      { date: '2026-07-01T07:00:00.000Z', kg: 82.6, source: 'withings', grpid: 1 },
      { date: '2026-07-01T07:00:00.000Z', kg: 90.1, source: 'withings', grpid: 2 },
    ])
    expect(loadWeightLog()).toHaveLength(2)
  })
})

describe('body-composition fields (#42)', () => {
  it('merge preserves and overwrites fatPct/muscleKg with the entry', () => {
    mergeWeighIns([{ date: '2026-07-13T07:00:00.000Z', kg: 82.4, source: 'withings', grpid: 9 }])
    const [e] = mergeWeighIns([
      {
        date: '2026-07-13T07:00:00.000Z',
        kg: 82.4,
        source: 'withings',
        grpid: 9,
        fatPct: 24.5,
        muscleKg: 55.3,
      },
    ])
    expect(e).toMatchObject({ kg: 82.4, fatPct: 24.5, muscleKg: 55.3 })
    expect(loadWeightLog()).toHaveLength(1)
  })
})
