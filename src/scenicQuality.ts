// Adaptive quality for the 3D scenic walk. The same app runs on a phone propped on the
// treadmill and on a desktop, so the renderer probes its own frame time for the first
// PROBE_FRAMES frames and picks a tier from the median — the mean would be dragged by
// the shader-compilation spikes that always sit at the front of the sample.
//
// Pure and DOM-free so it can be unit-tested; Scenic3D.vue owns the sampling.

export type Tier = 'low' | 'high'
export type QualitySetting = 'auto' | 'low' | 'high'

export const PROBE_FRAMES = 60
// median frame time at or below this counts as "this machine can afford the trimmings"
export const HIGH_TIER_MS = 20 // ≈ 50 fps

export interface TierBudget {
  textureSize: number
  pacers: number // slice 3
  stars: number
  clouds: boolean
  shadowMap: boolean
}

export const TIER_BUDGET: Record<Tier, TierBudget> = {
  low: { textureSize: 256, pacers: 3, stars: 200, clouds: false, shadowMap: false },
  high: { textureSize: 1024, pacers: 8, stars: 800, clouds: true, shadowMap: true },
}

export function tierFromFrames(frameMs: number[]): Tier {
  // too few samples to judge: stay where we started rather than guessing upward
  if (frameMs.length < PROBE_FRAMES / 2) return 'low'
  const sorted = [...frameMs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  return median <= HIGH_TIER_MS ? 'high' : 'low'
}

export function resolveTier(setting: QualitySetting, probed: Tier): Tier {
  return setting === 'auto' ? probed : setting
}
