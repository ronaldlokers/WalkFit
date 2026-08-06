import { describe, it, expect } from 'vitest'
import { ribbonArrays, stripArrays } from './scenicMeshes'
import { trackPoint, LAP_M, TRACK_IN, TRACK_OUT } from './scenic'

const BREAK_S = 120 // an arbitrary arc position on the first bend, for the strip cases

describe('ribbonArrays', () => {
  it('closes the loop: the last ring coincides with the first', () => {
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10)
    const n = r.position.length / 3
    for (let k = 0; k < 6; k++) {
      expect(r.position[k]).toBeCloseTo(r.position[(n - 2) * 3 + k]!, 6)
    }
  })

  it('emits two vertices per sample and a quad per gap', () => {
    const step = 2
    const rings = Math.ceil(LAP_M / step) + 1
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10, step)
    expect(r.position.length / 3).toBe(rings * 2)
    expect(r.uv.length / 2).toBe(rings * 2)
    expect(r.index.length).toBe((rings - 1) * 6)
  })

  it('advances u at the requested metres-per-repeat and spans v across the width', () => {
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10)
    // first ring: u = 0 on both edges, v = 0 then 1
    expect(r.uv[0]).toBeCloseTo(0, 6)
    expect(r.uv[1]).toBeCloseTo(0, 6)
    expect(r.uv[3]).toBeCloseTo(1, 6)
    // the ring at s = 20 m is two repeats along at 10 m per repeat
    const ringAt20 = 10 // s = i * 2 m, so i = 10
    expect(r.uv[ringAt20 * 4]).toBeCloseTo(2, 6)
  })

  it('places vertices on the track at the requested lateral offsets and height', () => {
    const y = 0.06
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, y, 10)
    const a = trackPoint(0, TRACK_IN)
    expect(r.position[0]).toBeCloseTo(a.x, 6)
    expect(r.position[1]).toBeCloseTo(y, 6)
    expect(r.position[2]).toBeCloseTo(a.z, 6)
  })

  it('every index is in range', () => {
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10)
    const n = r.position.length / 3
    for (const i of r.index) expect(i).toBeGreaterThanOrEqual(0)
    for (const i of r.index) expect(i).toBeLessThan(n)
  })
})

describe('stripArrays', () => {
  it('spans exactly the requested lateral offsets and arc width', () => {
    const s = BREAK_S
    const r = stripArrays(s, 0.5, 0.07, TRACK_IN, TRACK_OUT)
    expect(r.position.length / 3).toBe(4)
    expect(r.index.length).toBe(6)
    const a0 = trackPoint(s, TRACK_IN)
    const b1 = trackPoint(s + 0.5, TRACK_OUT)
    expect(r.position[0]).toBeCloseTo(a0.x, 6)
    expect(r.position[9]).toBeCloseTo(b1.x, 6)
  })

  it('carries a full 0..1 uv quad', () => {
    const r = stripArrays(0, 0.5, 0.07, TRACK_IN, TRACK_OUT)
    expect([...r.uv]).toEqual([0, 0, 0, 1, 1, 0, 1, 1])
  })
})
