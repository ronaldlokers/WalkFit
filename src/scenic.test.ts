import { describe, it, expect } from 'vitest'
import {
  worldHash,
  pathX,
  pathHeading,
  biomeAt,
  BIOME_LENGTH_M,
  chunkProps,
  CHUNK_M,
  signpostsIn,
  dayPhase,
  skyAt,
  DAY_LENGTH_M,
} from './scenic'

describe('worldHash', () => {
  it('is deterministic and in [0,1)', () => {
    for (const s of [0, 1, 42, 99991]) {
      const v = worldHash(s)
      expect(v).toBe(worldHash(s))
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(worldHash(1)).not.toBe(worldHash(2))
  })
})

describe('path', () => {
  it('curves gently within a bounded lateral corridor', () => {
    for (let z = 0; z < 5000; z += 13) {
      expect(Math.abs(pathX(z))).toBeLessThanOrEqual(9) // 6 + 3 amplitude bound
      expect(Math.abs(pathHeading(z))).toBeLessThan(0.3) // never a sharp turn (~17°)
    }
  })
})

describe('biomeAt', () => {
  it('starts in the park and advances every BIOME_LENGTH_M, cycling', () => {
    expect(biomeAt(0).id).toBe('park')
    expect(biomeAt(BIOME_LENGTH_M).id).toBe('lakeside')
    expect(biomeAt(2 * BIOME_LENGTH_M).id).toBe('forest')
    expect(biomeAt(3 * BIOME_LENGTH_M).id).toBe('town')
    expect(biomeAt(4 * BIOME_LENGTH_M).id).toBe('hills')
    expect(biomeAt(5 * BIOME_LENGTH_M).id).toBe('park') // wraps
    expect(biomeAt(-5).id).toBe('park') // clamped, no negative index
  })
})

describe('chunkProps', () => {
  it('is deterministic per chunk', () => {
    expect(chunkProps(12)).toEqual(chunkProps(12))
    expect(chunkProps(3)).not.toEqual(chunkProps(4))
  })

  it('places props inside the chunk span, clear of the walkway', () => {
    for (const chunk of [0, 5, 40, 133]) {
      for (const p of chunkProps(chunk)) {
        expect(p.z).toBeGreaterThanOrEqual(chunk * CHUNK_M)
        expect(p.z).toBeLessThan((chunk + 1) * CHUNK_M)
        expect(Math.abs(p.x - pathX(p.z))).toBeGreaterThanOrEqual(5)
      }
    }
  })

  it('lakeside spawns everything on the +x shore (water occupies -x)', () => {
    const lakesideChunk = Math.ceil(BIOME_LENGTH_M / CHUNK_M) // first chunk fully inside
    for (const p of chunkProps(lakesideChunk)) {
      expect(p.x - pathX(p.z)).toBeGreaterThan(0)
    }
  })

  it('resolves biome per prop on chunks straddling a border', () => {
    const straddler = Math.floor(BIOME_LENGTH_M / CHUNK_M) // spans park → lakeside
    for (const p of chunkProps(straddler)) {
      // props past the border obey lakeside's right-side-only rule
      if (p.z >= BIOME_LENGTH_M) expect(p.x - pathX(p.z)).toBeGreaterThan(0)
    }
  })

  it('only spawns types from the chunk biome mix', () => {
    const forestChunk = Math.floor((2 * BIOME_LENGTH_M + 10) / CHUNK_M)
    const allowed = ['pine', 'tree', 'rock', 'bush']
    for (const p of chunkProps(forestChunk)) expect(allowed).toContain(p.type)
  })

  it('returns nothing behind the start line', () => {
    expect(chunkProps(-1)).toEqual([])
  })
})

describe('signpostsIn', () => {
  it('one per km inside the window', () => {
    expect(signpostsIn(0, 3500)).toEqual([
      { z: 1000, km: 1 },
      { z: 2000, km: 2 },
      { z: 3000, km: 3 },
    ])
    expect(signpostsIn(1500, 2500)).toEqual([{ z: 2000, km: 2 }])
    expect(signpostsIn(0, 900)).toEqual([])
  })
})

describe('day/night', () => {
  it('phase starts at dawn (0) and wraps after DAY_LENGTH_M', () => {
    expect(dayPhase(0)).toBe(0)
    expect(dayPhase(DAY_LENGTH_M / 2)).toBe(0.5)
    expect(dayPhase(DAY_LENGTH_M)).toBe(0)
  })

  it('skyAt lerps between keyframes and matches endpoints across the wrap', () => {
    const dawn = skyAt(0)
    const wrapped = skyAt(0.999999)
    expect(wrapped.sky).toBeCloseTo(dawn.sky, -2) // ~same color approaching the wrap
    const day = skyAt(0.45)
    const night = skyAt(0.87)
    expect(day.sunIntensity).toBeGreaterThan(night.sunIntensity)
    expect(day.ambient).toBeGreaterThan(night.ambient)
  })
})
