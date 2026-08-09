import { describe, it, expect } from 'vitest'
import {
  stadium,
  STAND_O,
  FENCE_O,
  GATE_S0,
  GATE_S1,
  SKYLINE_R,
  grassTufts,
  TUFT_INNER,
  TUFT_OUTER,
  PART_SIZES,
  SCENERY_MIN_O,
  venueClearO,
} from './scenicVenue'
import {
  TRACK_IN,
  TRACK_OUT,
  LAP_M,
  BEND_R,
  STRAIGHT_M,
  trackPoint,
  surroundings,
  DOME_R,
  CAMERA_FAR,
} from './scenic'

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
    // `PART_SIZES` convention: [widthAcrossTrack, lengthAlongTrack] — Task 3's renderer
    // builds each mesh to match, e.g. the pitch as a 40 (x, across) x 64 (z, along) plane.
    const kerbR = BEND_R + TRACK_IN // 36.5 m — the inner boundary's half-width on a straight
    const halfLen = STRAIGHT_M / 2
    for (const p of stadium()) {
      const size = PART_SIZES[p.type]
      // PART_SIZES now also carries the grandstand's footprint (Task 3, for the
      // fence-clearance test below) — the stand sits outside the track by design, so it
      // is not "infield" and must not be checked against the kerb.
      if (!size || p.o >= TRACK_IN) continue
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

  it('keeps the skyline inside the dome and the far plane', () => {
    // Outside either one it renders nothing at all — which is exactly what it did until a
    // whole-branch review caught it. SKYLINE_R is a camera-relative distance, so comparing
    // it against parts' lateral offsets (as the old test did) proves nothing.
    expect(SKYLINE_R).toBeLessThan(DOME_R)
    expect(SKYLINE_R).toBeLessThan(CAMERA_FAR)
  })

  it('the grandstand clears the fence line, roof included', () => {
    // The stand's depth is a renderer-side dimension no other test could see, and it
    // overhung the fence by 1.2 m — the netting ran underneath the terracing.
    // PART_SIZES.stand[0] IS the roof edge (see STAND_DEPTH in scenicVenue.ts), so adding
    // another overhang on top double-counts it.
    const [depth] = PART_SIZES.stand!
    const standOuter = STAND_O + depth
    expect(`stand reaches ${standOuter.toFixed(2)}, fence at ${FENCE_O.toFixed(2)}`).toBe(
      standOuter < FENCE_O
        ? `stand reaches ${standOuter.toFixed(2)}, fence at ${FENCE_O.toFixed(2)}`
        : 'stand must sit inside the fence',
    )
  })

  it('gives every swept part a positive span that fits inside the lap', () => {
    for (const p of stadium()) {
      if (p.span === undefined) continue
      expect(p.span).toBeGreaterThan(0)
      expect(p.span).toBeLessThanOrEqual(LAP_M)
    }
  })

  it('keeps every scenery prop outside the perimeter fence', () => {
    // 23 of 48 props used to sit inside the fence, five of them inside the grandstand
    // itself — one tree came through the roof. Floodlight masts are excluded here: they are
    // functional lighting deliberately pinned just past the track's outer edge, inside where
    // this fence-clearance rule applies — see the dedicated exemption test below.
    for (const p of surroundings()) {
      if (p.type === 'flood') continue
      const o = venueClearO(p.type, p.o)
      expect(`${p.type} at o=${o.toFixed(2)}`).toBe(
        o >= SCENERY_MIN_O ? `${p.type} at o=${o.toFixed(2)}` : `${p.type} must clear the fence`,
      )
    }
  })

  it('leaves props that were already outside the fence where they were', () => {
    // the reflection must not disturb the ring's outer half
    expect(venueClearO('tree', SCENERY_MIN_O + 5)).toBe(SCENERY_MIN_O + 5)
    expect(venueClearO('tree', SCENERY_MIN_O)).toBe(SCENERY_MIN_O)
  })

  it('leaves the floodlight masts where surroundings() put them', () => {
    // They are functional track lighting, not decoration — real floodlights stand inside
    // the fence beside the track. A blanket relocation once threw them 35 m out among the
    // trees, where they lit nothing.
    for (const p of surroundings()) {
      if (p.type !== 'flood') continue
      expect(`flood at o=${venueClearO(p.type, p.o).toFixed(2)}`).toBe(
        `flood at o=${p.o.toFixed(2)}`,
      )
    }
  })
})

describe('grass tufts', () => {
  it('never puts a tuft on the running surface', () => {
    // the same rule the venue parts obey: TRACK_IN..TRACK_OUT is where people run
    for (const t of grassTufts(3000)) {
      const onTrack = t.o > TRACK_IN && t.o < TRACK_OUT
      expect(`${t.o.toFixed(2)} on track: ${onTrack}`).toBe(`${t.o.toFixed(2)} on track: false`)
    }
  })

  it('stays inside the perimeter fence and off the kerb', () => {
    for (const t of grassTufts(2000)) {
      expect(t.o).toBeLessThan(FENCE_O)
      expect(t.o).toBeGreaterThan(TUFT_INNER[0] - 0.001)
    }
  })

  it('is deterministic, so the instanced field is identical every mount', () => {
    expect(grassTufts(50)).toEqual(grassTufts(50))
  })

  it('crowds toward the track edge rather than spreading evenly', () => {
    // the far half of each band is mostly beyond the fog; an even spread spends most of
    // the instance budget where nothing can be seen
    const outer = grassTufts(2000).filter((t) => t.o > TRACK_OUT)
    const mid = (TUFT_OUTER[0] + TUFT_OUTER[1]) / 2
    const near = outer.filter((t) => t.o < mid).length
    expect(near).toBeGreaterThan(outer.length * 0.6)
  })
})
