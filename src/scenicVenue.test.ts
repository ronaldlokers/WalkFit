import { describe, it, expect } from 'vitest'
import {
  stadium,
  STAND_O,
  FENCE_O,
  GATE_S0,
  GATE_S1,
  SKYLINE_R,
  type VenueType,
} from './scenicVenue'
import { TRACK_IN, TRACK_OUT, LAP_M, BEND_R, STRAIGHT_M, trackPoint } from './scenic'

describe('stadium', () => {
  it('is deterministic', () => {
    expect(stadium()).toEqual(stadium())
  })

  it('never puts anything on the track', () => {
    // the track band is [TRACK_IN, TRACK_OUT]; infield furniture is inside TRACK_IN,
    // everything else is outside TRACK_OUT. Nothing may sit in the running lanes.
    for (const p of stadium()) {
      const onTrack = p.o > TRACK_IN && p.o < TRACK_OUT
      expect(`${p.type} at o=${p.o.toFixed(2)}`).toBe(
        onTrack ? `${p.type} must not sit on the track` : `${p.type} at o=${p.o.toFixed(2)}`,
      )
    }
  })

  it('keeps the grandstand clear of the track and inside the fence', () => {
    const stand = stadium().find((p) => p.type === 'stand')!
    expect(stand.o).toBeGreaterThan(TRACK_OUT)
    expect(STAND_O).toBeLessThan(FENCE_O)
  })

  it('every infield part fits inside the kerb, footprint included', () => {
    // The centre-only check this replaces was tautological. Infield parts are axis-aligned
    // — long axis along the track, width across it — so check those two extents directly.
    // A rotation-agnostic circular reach would be wrong here: the pitch's 37.7 m diagonal
    // exceeds the 36.5 m kerb half-width even though its 20 m half-width fits easily.
    //
    // `sizes` convention: [widthAcrossTrack, lengthAlongTrack] — Task 3's renderer must
    // build each mesh to match, e.g. the pitch as a 40 (x, across) x 64 (z, along) plane.
    const kerbR = BEND_R + TRACK_IN // 36.5 m — the inner boundary's half-width on a straight
    const halfLen = STRAIGHT_M / 2
    const sizes: Partial<Record<VenueType, [number, number]>> = {
      pitch: [40, 64],
      jumpRunway: [1.3, 30],
      jumpPit: [3, 8],
      highJump: [10, 8],
      shotCircle: [2.14, 2.14],
    }
    for (const p of stadium()) {
      const size = sizes[p.type]
      if (!size) continue
      const at = trackPoint(p.s, p.o)
      const [w, l] = size
      const across = Math.abs(at.x) + w / 2
      const along = Math.abs(at.z) + l / 2
      // `along <= halfLen` also keeps the part clear of the curved caps, which is what
      // makes the axis-aligned test valid in the first place.
      const fits = across <= kerbR && along <= halfLen
      expect(
        `${p.type}: across ${across.toFixed(1)}/${kerbR.toFixed(1)}, along ${along.toFixed(1)}/${halfLen.toFixed(1)}`,
      ).toBe(
        fits
          ? `${p.type}: across ${across.toFixed(1)}/${kerbR.toFixed(1)}, along ${along.toFixed(1)}/${halfLen.toFixed(1)}`
          : `${p.type}: must fit inside the kerb`,
      )
    }
  })

  it('opens the fence gate away from the grandstand', () => {
    // walking through a gate that is behind the stand would be invisible; more to the
    // point, a gate cut where the stand sits would clip through it
    const stand = stadium().find((p) => p.type === 'stand')!
    const standEnd = stand.s + stand.span!
    const overlaps = GATE_S0 < standEnd && GATE_S1 > stand.s
    expect(`gate ${GATE_S0}-${GATE_S1} vs stand ${stand.s}-${standEnd}`).toBe(
      overlaps
        ? 'gate must not overlap the stand'
        : `gate ${GATE_S0}-${GATE_S1} vs stand ${stand.s}-${standEnd}`,
    )
  })

  it('puts the skyline beyond everything else', () => {
    for (const p of stadium()) expect(SKYLINE_R).toBeGreaterThan(p.o)
  })

  it('gives every swept part a positive span that fits inside the lap', () => {
    for (const p of stadium()) {
      if (p.span === undefined) continue
      expect(p.span).toBeGreaterThan(0)
      expect(p.span).toBeLessThanOrEqual(LAP_M)
    }
  })
})
