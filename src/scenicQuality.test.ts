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
  it('never gets less generous as the tier climbs', () => {
    const order = ['low', 'high', 'ultra'] as const
    for (let i = 1; i < order.length; i++) {
      const lo = TIER_BUDGET[order[i - 1]!]
      const hi = TIER_BUDGET[order[i]!]
      for (const k of ['textureSize', 'pacers', 'stars', 'shadowMapSize', 'tufts'] as const) {
        expect(`${order[i]}.${k}`).toBe(
          hi[k] >= lo[k] ? `${order[i]}.${k}` : `${order[i]}.${k} regressed`,
        )
      }
      for (const k of ['clouds', 'normalMaps', 'contactShading', 'post'] as const) {
        expect(`${order[i]}.${k}`).toBe(
          hi[k] || !lo[k] ? `${order[i]}.${k}` : `${order[i]}.${k} regressed`,
        )
      }
    }
  })

  it('only the cheap tier falls back to blob shadows', () => {
    expect(TIER_BUDGET.low.shadowMapSize).toBe(0)
    expect(TIER_BUDGET.high.shadowMapSize).toBeGreaterThan(0)
  })

  it('ultra spends its shadow budget on texels per metre, not just map size', () => {
    const density = (t: 'high' | 'ultra') =>
      TIER_BUDGET[t].shadowMapSize / (2 * TIER_BUDGET[t].shadowBoxM)
    expect(density('ultra')).toBeGreaterThan(density('high') * 2)
  })

  it('post-processing is desktop-only, so it must never reach the phone tiers', () => {
    expect(TIER_BUDGET.low.post).toBe(false)
    expect(TIER_BUDGET.high.post).toBe(false)
  })
})

describe('the ultra tier is opt-in only', () => {
  it('the probe never selects it', () => {
    // vsync clamps frame time at ~16.7 ms no matter how much headroom the GPU has, so a
    // frame-time probe cannot tell "fast enough for a fullscreen post chain" from "exactly
    // at 60 Hz". Auto therefore tops out at high; ultra comes from Settings or not at all.
    for (const frames of [Array(PROBE_FRAMES).fill(1), Array(PROBE_FRAMES).fill(8)]) {
      expect(tierFromFrames(frames)).toBe('high')
    }
  })

  it('but an explicit setting still gets it', () => {
    expect(resolveTier('ultra', 'low')).toBe('ultra')
  })
})
