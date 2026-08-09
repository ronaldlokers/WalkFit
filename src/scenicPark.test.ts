import { describe, expect, it } from 'vitest'
import { scenicParkPlacements } from './scenicPark'
import { TRACK_OUT } from './scenic'

describe('scenicParkPlacements', () => {
  it('returns a stable, copy-on-read authored list', () => {
    const first = scenicParkPlacements()
    const second = scenicParkPlacements()
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    first[0].scale = 99
    expect(scenicParkPlacements()[0].scale).toBeLessThan(10)
  })

  it('keeps each external asset uniquely placed and outside the track edge', () => {
    const placements = scenicParkPlacements()
    expect(new Set(placements.map((placement) => placement.assetId)).size).toBe(placements.length)
    for (const placement of placements) {
      expect(placement.o).toBeGreaterThan(TRACK_OUT + 7)
      expect(placement.scale).toBeGreaterThan(0)
      expect(Number.isFinite(placement.rotation)).toBe(true)
    }
  })
})
