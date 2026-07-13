// Pure, framework-free world model for the 3D scenic walk (#51). No three.js here:
// this module answers "what exists at metre z" so it stays unit-testable, and the
// Scenic3D component only turns the answers into meshes. Everything derives from the
// walked distance through a deterministic hash — metre N always looks the same across
// re-renders, reloads, and re-walks (same property the old 2D bucket system had).

// Cheap deterministic pseudo-random in [0,1) — the same sine trick the 2D scenic used.
export function worldHash(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

// --- path ---
// The walkway curves gently: two overlapping sine waves in the lateral (x) axis as a
// function of forward metres (z). Amplitudes/periods chosen for calm, wide S-curves —
// comfort first, this is a treadmill companion, not a racing game.
export function pathX(z: number): number {
  return 6 * Math.sin(z / 90) + 3 * Math.sin(z / 37)
}
// Path heading (radians, 0 = straight ahead) from the analytic derivative of pathX.
export function pathHeading(z: number): number {
  const dxdz = (6 / 90) * Math.cos(z / 90) + (3 / 37) * Math.cos(z / 37)
  return Math.atan(dxdz)
}

// --- biomes ---
export type BiomeId = 'park' | 'lakeside' | 'forest' | 'town' | 'hills'
export interface Biome {
  id: BiomeId
  ground: number // ground plane color (hex)
  path: number // walkway color
  propsPerChunk: number
  // relative weights for prop types spawned in this biome
  mix: Partial<Record<PropType, number>>
  water: boolean // lakeside: water plane on the -x side of the path, props on the shore side
}

export const BIOME_LENGTH_M = 500

const BIOMES: Biome[] = [
  {
    id: 'park',
    ground: 0x2f4a2b,
    path: 0x3a3f4a,
    propsPerChunk: 7,
    mix: { tree: 5, bush: 3, lamp: 1 },
    water: false,
  },
  {
    id: 'lakeside',
    ground: 0x35503c,
    path: 0x3a3f4a,
    propsPerChunk: 5,
    mix: { reed: 4, tree: 2, rock: 2 },
    water: true,
  },
  {
    id: 'forest',
    ground: 0x24361f,
    path: 0x38352e,
    propsPerChunk: 12,
    mix: { pine: 8, tree: 2, rock: 2, bush: 2 },
    water: false,
  },
  {
    id: 'town',
    ground: 0x3c3a36,
    path: 0x44424b,
    propsPerChunk: 5,
    mix: { house: 3, lamp: 2, tree: 2 },
    water: false,
  },
  {
    id: 'hills',
    ground: 0x46523a,
    path: 0x3a3f4a,
    propsPerChunk: 4,
    mix: { rock: 3, bush: 3, tree: 1 },
    water: false,
  },
]

export function biomeAt(z: number): Biome {
  const i = Math.floor(Math.max(0, z) / BIOME_LENGTH_M) % BIOMES.length
  return BIOMES[i]!
}

// --- props ---
export type PropType = 'tree' | 'pine' | 'bush' | 'rock' | 'reed' | 'lamp' | 'house'
export interface Prop {
  type: PropType
  z: number // forward metres
  x: number // lateral metres (absolute, already offset from the path curve)
  scale: number
  seed: number // extra per-prop hash source for the mesh builder (tint, rotation)
}

export const CHUNK_M = 40

function pickType(biome: Biome, r: number): PropType {
  const entries = Object.entries(biome.mix) as [PropType, number][]
  const total = entries.reduce((a, [, w]) => a + w, 0)
  let acc = 0
  for (const [type, w] of entries) {
    acc += w
    if (r < acc / total) return type
  }
  return entries[entries.length - 1]![0]
}

// All props for one chunk (chunk i covers [i*CHUNK_M, (i+1)*CHUNK_M)). Deterministic:
// the same chunk index always yields the same props. A chunk can straddle a biome
// border, so type/side resolve from the biome at each prop's own z — otherwise a
// "park" tree could land in the lakeside's water strip.
export function chunkProps(chunk: number): Prop[] {
  if (chunk < 0) return []
  const base = chunk * CHUNK_M
  const count = biomeAt(base).propsPerChunk
  const props: Prop[] = []
  for (let i = 0; i < count; i++) {
    const s = chunk * 131 + i * 7
    const z = base + worldHash(s) * CHUNK_M
    const biome = biomeAt(z)
    const side = worldHash(s + 1) < 0.5 ? -1 : 1
    // keep clear of the walkway: 5–28 m out from the path centre line.
    // lakeside: the -x side is water, so everything spawns on the +x shore.
    const finalSide = biome.water ? 1 : side
    const lateral = 5 + worldHash(s + 2) * 23
    props.push({
      type: pickType(biome, worldHash(s + 3)),
      z,
      x: pathX(z) + finalSide * lateral,
      scale: 0.7 + worldHash(s + 4) * 0.8,
      seed: worldHash(s + 5),
    })
  }
  return props
}

// Km signposts beside the path (right-hand side), one per 1000 m walked.
export interface Signpost {
  z: number
  km: number
}
export function signpostsIn(fromZ: number, toZ: number): Signpost[] {
  const out: Signpost[] = []
  for (let km = Math.max(1, Math.ceil(fromZ / 1000)); km * 1000 < toZ; km++) {
    out.push({ z: km * 1000, km })
  }
  return out
}

// --- day/night from walked distance ---
// Every walk gets its own sky: phase 0 (session start) is dawn; a full cycle takes
// DAY_LENGTH_M, so a typical 2–3 km walk sees dawn → noon → golden hour → dusk.
export const DAY_LENGTH_M = 3200

export function dayPhase(z: number): number {
  const p = (Math.max(0, z) % DAY_LENGTH_M) / DAY_LENGTH_M
  return p
}

export interface SkyState {
  sky: number // background / clear color
  fog: number
  sunIntensity: number // directional light
  sunColor: number
  ambient: number // hemisphere/ambient intensity
}

interface SkyKey extends SkyState {
  at: number
}
// Keyframes around the cycle; lerped between. Dark-theme friendly: even "noon" stays
// muted so the app chrome around the canvas doesn't clash.
const SKY_KEYS: SkyKey[] = [
  { at: 0.0, sky: 0x3a2f45, fog: 0x6d5468, sunIntensity: 0.7, sunColor: 0xffb08a, ambient: 0.7 }, // dawn
  { at: 0.18, sky: 0x4a6a8a, fog: 0x7a8ea3, sunIntensity: 1.0, sunColor: 0xfff2dd, ambient: 0.9 }, // morning
  { at: 0.45, sky: 0x527099, fog: 0x8298ad, sunIntensity: 1.1, sunColor: 0xffffff, ambient: 1.0 }, // day
  { at: 0.62, sky: 0x4a5c80, fog: 0x8a7f8e, sunIntensity: 0.9, sunColor: 0xffe0b0, ambient: 0.85 }, // late
  { at: 0.75, sky: 0x51345a, fog: 0x8a5c62, sunIntensity: 0.6, sunColor: 0xff9a5c, ambient: 0.6 }, // sunset
  { at: 0.87, sky: 0x1c1f33, fog: 0x2c3046, sunIntensity: 0.2, sunColor: 0x9ab0ff, ambient: 0.35 }, // night
  { at: 1.0, sky: 0x3a2f45, fog: 0x6d5468, sunIntensity: 0.7, sunColor: 0xffb08a, ambient: 0.7 }, // wraps to dawn
]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff
  return (
    (Math.round(lerp(ar, br, t)) << 16) |
    (Math.round(lerp(ag, bg, t)) << 8) |
    Math.round(lerp(ab, bb, t))
  )
}

export function skyAt(phase: number): SkyState {
  let i = 0
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1]!.at <= phase) i++
  const a = SKY_KEYS[i]!
  const b = SKY_KEYS[i + 1]!
  const t = (phase - a.at) / (b.at - a.at)
  return {
    sky: lerpColor(a.sky, b.sky, t),
    fog: lerpColor(a.fog, b.fog, t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    sunColor: lerpColor(a.sunColor, b.sunColor, t),
    ambient: lerp(a.ambient, b.ambient, t),
  }
}
