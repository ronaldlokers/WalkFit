// Where the club track's furniture sits. Pure and three.js-free, like its siblings:
// Scenic3D.vue turns these answers into meshes, and everything here is STATIC, so it all
// flows through the component's merge-by-material bake and costs a handful of draw calls.
//
// Scale is deliberately a club track, not a stadium bowl: one covered stand on the home
// straight, and open horizon on the other three sides so the day/night sky and the
// existing scenery ring stay visible.
import { TRACK_IN, TRACK_OUT, STRAIGHT_M, LAP_M, BEND_R, worldHash } from './scenic'

export type VenueType =
  | 'stand'
  | 'fence'
  | 'fencePost'
  | 'clubhouse'
  | 'flagpole'
  | 'pitch'
  | 'jumpPit'
  | 'jumpRunway'
  | 'highJump'
  | 'shotCircle'
  | 'skyline'

export interface VenuePart {
  type: VenueType
  s: number // arc position along the loop
  o: number // lateral offset; positive is outward, negative is into the infield
  scale: number
  seed: number
  span?: number // arc length, for parts swept along the track (stand, fence)
}

// The midpoint of the back straight, directly opposite the stand. Derived from the track
// geometry rather than hardcoded — an earlier slice shipped duplicated constants twice.
const BACK_STRAIGHT_MID = STRAIGHT_M + Math.PI * BEND_R + STRAIGHT_M / 2

// The home straight runs s = 0 to STRAIGHT_M. The stand covers it, inset a little at
// each end so it does not run into the bends.
export const STAND_S0 = 4
export const STAND_S1 = STRAIGHT_M - 4
export const STAND_O = TRACK_OUT + 6
// Fence sits outside the stand, with a gate cut on the far side of the loop.
export const FENCE_O = TRACK_OUT + 14
export const GATE_S0 = BACK_STRAIGHT_MID + 10
export const GATE_S1 = BACK_STRAIGHT_MID + 26
// Distant silhouette ring. Beyond the fog in mist, which is correct — it should fade.
export const SKYLINE_R = 400
// The ring itself sits just inside SKYLINE_R, so the constant stays a true "beyond
// everything else" boundary rather than exactly matching the ring's own placement.
const SKYLINE_INSET = 20

export function stadium(): VenuePart[] {
  const out: VenuePart[] = []
  const part = (type: VenueType, s: number, o: number, seed = 0, span?: number): void => {
    out.push({ type, s, o, scale: 1, seed, span })
  }

  // --- outside the track ---
  part('stand', STAND_S0, STAND_O, 0, STAND_S1 - STAND_S0)
  part('clubhouse', STAND_S0 + 20, STAND_O + 12)
  for (let i = 0; i < 3; i++) {
    part('flagpole', STAND_S0 + 14 + i * 3, STAND_O + 9, worldHash(i * 13 + 5))
  }
  part('fence', 0, FENCE_O, 0, LAP_M)
  // posts every 4 m, skipping the gate
  for (let s = 0; s < LAP_M; s += 4) {
    if (s >= GATE_S0 && s <= GATE_S1) continue
    part('fencePost', s, FENCE_O, worldHash(s))
  }
  part('skyline', 0, SKYLINE_R - SKYLINE_INSET)

  // --- infield furniture, all inside the kerb ---
  part('pitch', 0, TRACK_IN - 22)
  part('jumpRunway', STAND_S0 + 30, TRACK_IN - 4)
  part('jumpPit', STAND_S0 + 30, TRACK_IN - 12)
  part('highJump', BACK_STRAIGHT_MID - 20, TRACK_IN - 8)
  part('shotCircle', BACK_STRAIGHT_MID + 6, TRACK_IN - 6)

  return out
}
