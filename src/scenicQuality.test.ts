import { describe, it, expect } from 'vitest'
import { tierFromFrames, resolveTier, PROBE_FRAMES, TIER_BUDGET } from './scenicQuality'

describe('tierFromFrames', () => {
  it('picks high for consistently fast frames', () => {
    expect(tierFromFrames(Array(PROBE_FRAMES).fill(8))).toBe('high')
  })

  it('picks low for consistently slow frames', () => {
    expect(tierFromFrames(Array(PROBE_FRAMES).fill(40))).toBe('low')
  })

  it('uses the median, so leading shader-compile spikes do not force low', () => {
    // the first handful of frames are always slow: shader compilation, texture upload
    const frames = [2000, 900, 700, 400, ...Array(PROBE_FRAMES - 4).fill(8)]
    expect(tierFromFrames(frames)).toBe('high')
  })

  it('falls back to low when there is not enough data to judge', () => {
    expect(tierFromFrames([])).toBe('low')
    expect(tierFromFrames([8, 8])).toBe('low')
  })

  it('needs at least half a probe of samples before it will judge', () => {
    const fast = (n: number) => Array(n).fill(8)
    // one sample short of the cutoff: not enough data, stay conservative
    expect(tierFromFrames(fast(PROBE_FRAMES / 2 - 1))).toBe('low')
    // exactly at the cutoff: enough to judge, and these frames are fast
    expect(tierFromFrames(fast(PROBE_FRAMES / 2))).toBe('high')
  })
})

describe('resolveTier', () => {
  it('honours an explicit setting over the probe', () => {
    expect(resolveTier('low', 'high')).toBe('low')
    expect(resolveTier('high', 'low')).toBe('high')
  })

  it('falls through to the probe on auto', () => {
    expect(resolveTier('auto', 'high')).toBe('high')
    expect(resolveTier('auto', 'low')).toBe('low')
  })
})

describe('TIER_BUDGET', () => {
  it('high is at least as generous as low on every axis', () => {
    expect(TIER_BUDGET.high.textureSize).toBeGreaterThan(TIER_BUDGET.low.textureSize)
    expect(TIER_BUDGET.high.pacers).toBeGreaterThan(TIER_BUDGET.low.pacers)
    expect(TIER_BUDGET.high.stars).toBeGreaterThan(TIER_BUDGET.low.stars)
    expect(TIER_BUDGET.high.shadowMap).toBe(true)
    expect(TIER_BUDGET.low.shadowMap).toBe(false)
  })
})
