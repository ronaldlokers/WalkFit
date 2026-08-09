// Adaptive quality for the 3D scenic walk. The same app runs on a phone propped on the
// treadmill and on a desktop, so the renderer probes its own frame time for the first
// PROBE_FRAMES frames and picks a tier from the median — the mean would be dragged by
// the shader-compilation spikes that always sit at the front of the sample.
//
// Pure and DOM-free so it can be unit-tested; Scenic3D.vue owns the sampling.

export type Tier = 'low' | 'high' | 'ultra'
export type QualitySetting = 'auto' | 'low' | 'high' | 'ultra'

export const PROBE_FRAMES = 60
// median frame time at or below this counts as "this machine can afford the trimmings"
export const HIGH_TIER_MS = 20 // ≈ 50 fps

export interface TierBudget {
  textureSize: number
  pacers: number // slice 3
  stars: number
  clouds: boolean
  /** Shadow map resolution, or 0 for none (the blob-shadow discs stand in instead). */
  shadowMapSize: number
  /** Half-width of the shadow box in metres. Smaller box + same map = sharper contact. */
  shadowBoxM: number
  /** Derived normal maps on the surface materials. */
  normalMaps: boolean
  /** Contact darkening baked into the static world's vertex colours. */
  contactShading: boolean
  /** Instanced grass tufts along the track edge. */
  tufts: number
  /** Bloom + colour grading. Desktop only — a fullscreen pass at DPR 3 is what a phone
   * cannot afford, and it is the first thing to cost frames rather than watts. */
  post: boolean
}

export const TIER_BUDGET: Record<Tier, TierBudget> = {
  low: {
    textureSize: 512,
    pacers: 3,
    stars: 200,
    clouds: false,
    shadowMapSize: 0,
    shadowBoxM: 60,
    normalMaps: false,
    contactShading: false,
    tufts: 0,
    post: false,
  },
  high: {
    textureSize: 1024,
    pacers: 8,
    stars: 800,
    clouds: true,
    shadowMapSize: 2048,
    shadowBoxM: 60,
    normalMaps: true,
    contactShading: true,
    tufts: 900,
    post: false,
  },
  ultra: {
    textureSize: 1024,
    pacers: 8,
    stars: 1200,
    clouds: true,
    // 4096 over a 80 m box is 51 texels/m, against 17 at high — that ratio is what puts a
    // crisp edge on contact shadows instead of a soft smear. A tighter box does the same
    // job as a second cascade here, without CSM having to rewrite every material.
    shadowMapSize: 4096,
    shadowBoxM: 40,
    normalMaps: true,
    contactShading: true,
    tufts: 2200,
    post: true,
  },
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
