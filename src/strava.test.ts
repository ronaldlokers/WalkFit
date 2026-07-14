import { describe, it, expect } from 'vitest'
import { localWallTime } from './strava'

describe('localWallTime (#59)', () => {
  it('formats local wall time with no zone designator', () => {
    expect(localWallTime('2026-07-13T19:00:00.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    )
  })

  it('round-trips to the same instant when re-parsed as local time', () => {
    // TZ-independent: parsing the zone-less string as local must land on the original
    // epoch — exactly the property Strava's start_date_local relies on.
    for (const iso of [
      '2026-07-13T19:00:00.000Z',
      '2026-01-05T23:30:00.000Z', // winter (different DST offset)
      '2026-06-30T00:15:00.000Z', // near midnight — date rolls across zones
    ]) {
      const local = localWallTime(iso)
      expect(new Date(local).getTime()).toBe(new Date(iso).getTime())
    }
  })
})
