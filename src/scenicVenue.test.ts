import { describe, it, expect } from 'vitest'
import { stadium, STAND_O, FENCE_O, GATE_S0, GATE_S1, SKYLINE_R } from './scenicVenue'
import { TRACK_IN, TRACK_OUT, LAP_M } from './scenic'

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

  it('puts every infield part inside the inner kerb', () => {
    const infield = stadium().filter((p) => p.o < TRACK_IN)
    expect(infield.length).toBeGreaterThan(0)
    for (const p of infield) {
      expect(`${p.type} at o=${p.o.toFixed(2)}`).toBe(
        p.o < TRACK_IN ? `${p.type} at o=${p.o.toFixed(2)}` : `${p.type} must be inside the kerb`,
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
