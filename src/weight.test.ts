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
