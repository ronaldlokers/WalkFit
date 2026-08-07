// Where the club track's furniture sits. Pure and three.js-free, like its siblings:
// Scenic3D.vue turns these answers into meshes, and everything here is STATIC, so it all
// flows through the component's merge-by-material bake and costs a handful of draw calls.
//
// Scale is deliberately a club track, not a stadium bowl: one covered stand on the home
// straight, and open horizon on the other three sides so the day/night sky and the
// existing scenery ring stay visible.
//
// Convention for elongated parts (pitch, jumpRunway, jumpPit, highJump, ...): `s` is the
// CENTRE of the part, and its long axis follows the track's local tangent at that point
// (i.e. runs along the straight, not across it). Task 3's renderer relies on this — a
// part laid across the track instead of along it pokes through the kerb onto the track.
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

// Footprint of each sized part, as [widthAcrossTrack, lengthAlongTrack] in metres. The
// renderer builds meshes to these and scenicVenue.test.ts checks them against the kerb —
// one table, so a resize cannot pass the test while changing what is drawn.
export const PART_SIZES: Partial<Record<VenueType, [number, number]>> = {
  pitch: [40, 64],
  jumpRunway: [1.3, 30],
  jumpPit: [3, 8],
  highJump: [10, 8],
  shotCircle: [2.14, 2.14],
  // across-track depth x along-track span. The depth is what must clear the fence line.
  stand: [9.2, 76.39],
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
export const FENCE_O = TRACK_OUT + 18 // 2.8 m clear of the stand's roof edge at 22.22
export const GATE_S0 = BACK_STRAIGHT_MID + 10
export const GATE_S1 = BACK_STRAIGHT_MID + 26
// Radius of the skyline backdrop. It FOLLOWS THE CAMERA rather than sitting at the world
// origin, so this is its distance from the walker, not from the infield: the camera wanders
// up to 56 m off-centre, and any world-anchored radius that clears the sky dome on one side
// pokes through it on the other. Must stay inside the dome (260) and the far plane (290).
export const SKYLINE_R = 240

export function stadium(): VenuePart[] {
  const out: VenuePart[] = []
  const part = (type: VenueType, s: number, o: number, seed = 0, span?: number): void => {
    out.push({ type, s, o, scale: 1, seed, span })
  }

  // --- outside the track ---
  part('stand', STAND_S0, STAND_O, 0, STAND_S1 - STAND_S0)
  part('fence', 0, FENCE_O, 0, LAP_M)
  // clubhouse and flagpoles sit beyond the fence (a clubhouse on the car-park side of the
  // perimeter is right for a club track anyway), separated in `s` so they do not
  // interpenetrate — the clubhouse used to swallow the stand's back wall and one
  // flagpole used to pass through its roof.
  part('clubhouse', 24, FENCE_O + 9)
  for (let i = 0; i < 3; i++) {
    part('flagpole', 40 + i * 3, FENCE_O + 5, worldHash(i * 13 + 5))
  }
  // posts every 4 m, skipping the gate
  for (let s = 0; s < LAP_M; s += 4) {
    if (s >= GATE_S0 && s <= GATE_S1) continue
    part('fencePost', s, FENCE_O, worldHash(s))
  }
  part('skyline', 0, SKYLINE_R)

  // --- infield furniture, all inside the kerb ---
  // Centred on the infield's true middle: trackPoint(STRAIGHT_M / 2, TRACK_IN - 36.5)
  // lands at world (0, 0). A 64 x 40 m pitch then spans +/-32 in z against a 42.2 m
  // straight half-length, and +/-20 in x against a 36.5 m kerb half-width — fits with
  // margin. Placed anywhere near a bend it pokes through the kerb onto the track.
  part('pitch', STRAIGHT_M / 2, TRACK_IN - 36.5)
  // Runway and pit run ALONG the straight, pit at the far end — a 30 m run-up laid
  // radially would cross the running lanes. Both at the same depth into the infield.
  part('jumpRunway', 20, TRACK_IN - 6)
  part('jumpPit', 39, TRACK_IN - 6)
  part('highJump', BACK_STRAIGHT_MID - 20, TRACK_IN - 8)
  part('shotCircle', BACK_STRAIGHT_MID + 6, TRACK_IN - 6)

  return out
}
