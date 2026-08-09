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
import { TRACK_IN, TRACK_OUT, STRAIGHT_M, LAP_M, BEND_R, worldHash, type PropType } from './scenic'

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

// The home straight runs s = 0 to STRAIGHT_M. The stand covers it, inset a little at
// each end so it does not run into the bends.
export const STAND_S0 = 4
export const STAND_S1 = STRAIGHT_M - 4
export const STAND_O = TRACK_OUT + 6

// The grandstand's build dimensions live here, not in the renderer, because its across-track
// depth is what has to clear the fence — and a renderer-side literal is a dimension no test
// can see. PART_SIZES.stand is DERIVED from these, so changing the stand cannot silently
// invalidate the clearance test.
export const STAND_ROWS = 8
export const STAND_ROW_DEPTH = 1.1
export const STAND_ROW_RISE = 0.45
export const STAND_ROOF_W = STAND_ROWS * 1.2
export const STAND_DEPTH = STAND_ROWS * 0.55 + STAND_ROOF_W / 2 // roof edge, the outermost point

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
  stand: [STAND_DEPTH, STAND_S1 - STAND_S0],
}

// The midpoint of the back straight, directly opposite the stand. Derived from the track
// geometry rather than hardcoded — an earlier slice shipped duplicated constants twice.
const BACK_STRAIGHT_MID = STRAIGHT_M + Math.PI * BEND_R + STRAIGHT_M / 2

// Fence sits outside the stand, with a gate cut on the far side of the loop.
export const FENCE_O = TRACK_OUT + 18 // 2.8 m clear of the stand's roof edge at 22.22
export const GATE_S0 = BACK_STRAIGHT_MID + 10
export const GATE_S1 = BACK_STRAIGHT_MID + 26
// Scenery may not stand inside the perimeter — a tree in the terracing or a fence post
// through a trunk reads as broken. Props inside the fence are reflected outward rather than
// deleted, which keeps the ring's density instead of thinning it by half.
//
// Floodlight masts are exempt: surroundings() pins them just past the track's outer edge
// because they are functional lighting, and real floodlights stand INSIDE the fence beside
// the track. Reflecting them out among the trees puts them 35 m from where they belong.
export const SCENERY_MIN_O = FENCE_O + 2

export function venueClearO(type: PropType, o: number): number {
  if (type === 'flood') return o
  return o < SCENERY_MIN_O ? SCENERY_MIN_O + (SCENERY_MIN_O - o) : o
}

// Radius of the skyline backdrop. It FOLLOWS THE CAMERA rather than sitting at the world
// origin, so this is its distance from the walker, not from the infield: the camera wanders
// up to 56 m off-centre, and any world-anchored radius that clears the sky dome on one side
// pokes through it on the other. Must stay inside the sky dome and the camera's far plane —
// DOME_R and CAMERA_FAR, hoisted into scenic.ts so scenicVenue.test.ts can assert against
// them directly instead of duplicating the numbers here.
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

// Grass tufts along the two edges of the track, as instance placements. Deterministic from
// worldHash so the field is identical every mount and can be baked into one InstancedMesh.
//
// Near-field detail is the cue a bare ground plane cannot fake: at eye height the metre in
// front of you is most of the screen, and a flat texture there reads as painted lino no
// matter how good the texture is.
//
// Tufts must never land on the running surface — TRACK_IN..TRACK_OUT is where the walker
// and pacers actually run, and a blade of grass through the lane lines is worse than no
// grass at all. `scenicVenue.test.ts` pins it.
export interface Tuft {
  s: number
  o: number
  scale: number
  seed: number
}

// Bands the tufts may occupy. The inner one is only the unmown lip beside the kerb, NOT the
// infield: the infield is a maintained pitch with mowing stripes, and clumps of wild grass
// scattered across it read as neglect rather than detail.
export const TUFT_INNER: [number, number] = [TRACK_IN - 2.2, TRACK_IN - 0.7]
export const TUFT_OUTER: [number, number] = [TRACK_OUT + 0.6, FENCE_O - 1]

export function grassTufts(count: number): Tuft[] {
  const out: Tuft[] = []
  for (let i = 0; i < count; i++) {
    const h = i * 7
    const band = worldHash(h + 1201) < 0.45 ? TUFT_INNER : TUFT_OUTER
    // squared, so tufts crowd toward the track edge where they are actually seen rather
    // than spreading evenly across a band most of which is beyond the fog
    const t = worldHash(h + 1202) ** 2
    const o =
      band === TUFT_INNER ? band[1] - t * (band[1] - band[0]) : band[0] + t * (band[1] - band[0])
    out.push({
      s: worldHash(h + 1203) * LAP_M,
      o,
      scale: 0.7 + worldHash(h + 1204) * 0.8,
      seed: worldHash(h + 1205),
    })
  }
  return out
}
