// Geometry array builders for the 3D scenic walk. These return plain vertex/uv/index
// arrays rather than three.js BufferGeometry so the maths is unit-testable without a
// WebGL context (Scenic3D.vue itself can never be tested — jsdom has no WebGL).
//
// UVs matter more than they look: the loop ribbons used to carry none, which forced the
// component's merge pass to DELETE uv from every primitive so mergeGeometries would
// accept a mixed batch. Textured surfaces need the opposite, so every builder here emits
// uv and the merge pass fills in zeros for anything still missing it.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { trackPoint, LAP_M, worldHash } from './scenic'

export interface MeshArrays {
  position: number[]
  uv: number[]
  index: number[]
}

// Texture tiling scale per surface, in metres of arc per texture repeat.
//
// Every value here MUST divide LAP_M (400) exactly. `ribbonArrays` sets u = s /
// repeatMetres, so the closing ring lands at u = 400 / repeatMetres — and unless that
// is a whole number the tile does not line up with itself where the loop closes, which
// reads as the texture visibly jumping at the start/finish line. 400 / 5 = 80,
// 400 / 10 = 40, 400 / 8 = 50, 400 / 1 = 400. All integers.
export const REPEAT = { track: 5, infield: 10, kerb: 8, mark: 1 }

// Closed ribbon around the whole loop between lateral offsets [o0, o1], sampled every
// `step` metres. `u` advances one unit per `repeatMetres` of arc so a tiled texture keeps
// a plausible physical scale instead of being stretched around all 400 m; `v` spans the
// width. Winding matches the original component's: face normals point +y.
export function ribbonArrays(
  o0: number,
  o1: number,
  y: number,
  repeatMetres: number,
  step = 2,
): MeshArrays {
  const n = Math.ceil(LAP_M / step)
  const position: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * LAP_M
    const a = trackPoint(s, o0)
    const b = trackPoint(s, o1)
    position.push(a.x, y, a.z, b.x, y, b.z)
    const u = s / repeatMetres
    uv.push(u, 0, u, 1)
    if (i > 0) {
      const k = (i - 1) * 2
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  return { position, uv, index }
}

// Short strip across the track at arc position s (finish line, lane staggers, relay and
// hurdle marks). One quad, one full 0..1 uv square.
export function stripArrays(
  s: number,
  widthM: number,
  y: number,
  o0: number,
  o1: number,
): MeshArrays {
  const a0 = trackPoint(s, o0)
  const a1 = trackPoint(s, o1)
  const b0 = trackPoint(s + widthM, o0)
  const b1 = trackPoint(s + widthM, o1)
  return {
    position: [a0.x, y, a0.z, a1.x, y, a1.z, b0.x, y, b0.z, b1.x, y, b1.z],
    uv: [0, 0, 0, 1, 1, 0, 1, 1],
    index: [0, 2, 1, 1, 2, 3],
  }
}

export function geometryFrom(a: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.position, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2))
  g.setIndex(a.index)
  g.computeVertexNormals()
  return g
}

// mergeGeometries silently produces garbage if the batch disagrees on which attributes
// exist. Everything we build carries uv; three.js primitives do too, but a future
// geometry might not — fill in zeros rather than deleting uv from the ones that have it.
export function ensureUv(g: THREE.BufferGeometry): void {
  if (g.getAttribute('uv')) return
  const count = g.getAttribute('position')!.count
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2))
}

// Fail loudly at build time instead of rendering a corrupted mesh. A mismatch here is
// the single most likely way this file breaks, and it is invisible without the check.
export function assertSameAttributes(geoms: THREE.BufferGeometry[], label: string): void {
  if (geoms.length < 2) return
  const key = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort().join(',')
  const first = key(geoms[0]!)
  for (const g of geoms) {
    if (key(g) !== first) {
      throw new Error(`scenic merge: attribute mismatch for "${label}" — ${key(g)} vs ${first}`)
    }
  }
}

// Every surface texture is generated at runtime into a canvas — no asset files, so the
// offline service worker precache is unaffected and the bundle does not grow. All noise
// comes from worldHash, so a given size always produces the identical texture.
function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return [c, c.getContext('2d')!]
}

function finish(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// red tartan: base colour, fine rubber granules, faint roll marks along the lap
export function tartanTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#9c4238'
  ctx.fillRect(0, 0, size, size)
  const grains = Math.min(size * size * 0.12, 40000)
  for (let i = 0; i < grains; i++) {
    const x = worldHash(i * 3 + 1) * size
    const y = worldHash(i * 3 + 2) * size
    const v = worldHash(i * 3 + 3)
    ctx.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,190,170,0.12)'
    ctx.fillRect(x, y, 1.5, 1.5)
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.05)'
  ctx.lineWidth = 1
  for (let i = 0; i < 12; i++) {
    const y = (i / 12) * size + worldHash(i + 900) * 4
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(size, y)
    ctx.stroke()
  }
  return finish(c)
}

// grass / infield: value noise plus blade streaks. `hue` shifts the two green surfaces
// apart so ground and infield do not read as one continuous plane.
export function grassTexture(size: number, hue: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = `hsl(${hue}, 28%, 22%)`
  ctx.fillRect(0, 0, size, size)
  const cells = Math.max(16, size / 8)
  for (let i = 0; i < cells * cells; i++) {
    const x = (i % cells) * (size / cells)
    const y = Math.floor(i / cells) * (size / cells)
    const v = worldHash(i * 7 + 11)
    ctx.fillStyle = `hsla(${hue + (v - 0.5) * 14}, 30%, ${18 + v * 12}%, 0.7)`
    ctx.fillRect(x, y, size / cells, size / cells)
  }
  ctx.strokeStyle = 'rgba(160,200,140,0.10)'
  for (let i = 0; i < Math.min(size * 1.5, 1200); i++) {
    const x = worldHash(i * 5 + 31) * size
    const y = worldHash(i * 5 + 32) * size
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (worldHash(i * 5 + 33) - 0.5) * 3, y - 3)
    ctx.stroke()
  }
  return finish(c)
}

// trunk striation
export function barkTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#5d4634'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < Math.min(size / 2, 400); i++) {
    const x = worldHash(i * 4 + 51) * size
    ctx.fillStyle = worldHash(i * 4 + 52) < 0.5 ? 'rgba(0,0,0,0.22)' : 'rgba(210,180,150,0.10)'
    ctx.fillRect(x, 0, 1 + worldHash(i * 4 + 53) * 2, size)
  }
  return finish(c)
}

// leaf-cluster noise for the crowns
export function foliageTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#3f7d3a'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < Math.min(size * 2, 1200); i++) {
    const x = worldHash(i * 6 + 71) * size
    const y = worldHash(i * 6 + 72) * size
    const r = 2 + worldHash(i * 6 + 73) * (size / 24)
    const v = worldHash(i * 6 + 74)
    ctx.fillStyle = `rgba(${40 + v * 40}, ${100 + v * 60}, ${40 + v * 30}, 0.55)`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  return finish(c)
}

// off-white concrete with panel joints — kerb now, grandstand in slice 2
export function concreteTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#e8ecf2'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < Math.min(size * size * 0.04, 16000); i++) {
    ctx.fillStyle = `rgba(120,130,145,${0.04 + worldHash(i + 131) * 0.06})`
    ctx.fillRect(worldHash(i * 2 + 132) * size, worldHash(i * 2 + 133) * size, 2, 2)
  }
  ctx.strokeStyle = 'rgba(110,120,135,0.35)'
  ctx.lineWidth = Math.max(1, size / 256)
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath()
    ctx.moveTo(0, f * size)
    ctx.lineTo(size, f * size)
    ctx.stroke()
  }
  return finish(c)
}

// Fallback ground contact for the cheap tier, which runs no shadow map at all: a soft
// dark disc laid under each prop. It does not track the sun — that is the honest trade.
export function blobShadowTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.45)')
  g.addColorStop(0.6, 'rgba(0,0,0,0.18)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// soft radial disc used for both the sun (bright, additive) and the moon (pale)
export function glowTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.18)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// Deterministic star field on the upper hemisphere of a sphere of `radius`. Points below
// about 8° elevation are skipped — they would sit inside the fog band and just smear.
export function starPositions(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const azimuth = worldHash(i * 2 + 401) * Math.PI * 2
    const elevation = 0.14 + worldHash(i * 2 + 402) * (Math.PI / 2 - 0.14)
    out[i * 3] = Math.cos(azimuth) * Math.cos(elevation) * radius
    out[i * 3 + 1] = Math.sin(elevation) * radius
    out[i * 3 + 2] = Math.sin(azimuth) * Math.cos(elevation) * radius
  }
  return out
}

// fbm-ish cloud alpha: a few octaves of blurred blobs, tiled
export function cloudTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  for (let octave = 0; octave < 3; octave++) {
    const blobs = 40 >> octave
    const r = (size / 6) * (octave + 1)
    ctx.globalAlpha = 0.16 / (octave + 1)
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < blobs; i++) {
      const x = worldHash(i * 3 + octave * 97 + 501) * size
      const y = worldHash(i * 3 + octave * 97 + 502) * size
      ctx.beginPath()
      ctx.arc(x, y, r * (0.4 + worldHash(i * 3 + octave * 97 + 503)), 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// A pacer is five meshes — body+head merged, two arms, two legs — sharing one material.
// Arms and legs need DIFFERENT lengths: a leg has to reach the ground from the hip, and an
// arm that long would hang past the knee. Each limb pivots at its top so a rotation about x
// swings it from the shoulder or hip.
export function runnerParts(): {
  body: THREE.BufferGeometry
  arm: THREE.BufferGeometry
  leg: THREE.BufferGeometry
} {
  const torso = new THREE.CapsuleGeometry(0.16, 0.5, 3, 6)
  torso.translate(0, 1.15, 0)
  const head = new THREE.SphereGeometry(0.12, 8, 6)
  head.translate(0, 1.58, 0)
  const body = mergeGeometries([torso, head])!
  torso.dispose()
  head.dispose()
  // Leg: half-height is length/2 + radius = 0.43, so translating by that puts the pivot at
  // the very top and the foot exactly 0.86 m below it. Mounted at hip y = 0.86, the foot
  // lands on y = 0 — the track surface.
  const leg = new THREE.CapsuleGeometry(0.06, 0.74, 3, 5)
  leg.translate(0, -0.43, 0)
  // Arm: 0.60 m from the shoulder, so the hand sits at y = 0.82 with the shoulder at 1.42.
  const arm = new THREE.CapsuleGeometry(0.05, 0.5, 3, 5)
  arm.translate(0, -0.3, 0)
  return { body, arm, leg }
}

// Always Standard: material class cannot change after the bake (materials are the merge
// keys), so a tier-dependent class meant the auto-probed upgrade silently kept Lambert
// and left every roughness value inert. The tier still gates what actually costs —
// shadow map, texture resolution, object counts.
export function surface(opts: {
  color: number
  map?: THREE.Texture
  roughness?: number
  side?: THREE.Side
  flatShading?: boolean
}): THREE.Material {
  const base: THREE.MeshStandardMaterialParameters = {
    color: opts.color,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
    roughness: opts.roughness ?? 0.9,
    metalness: 0,
  }
  if (opts.map) base.map = opts.map
  return new THREE.MeshStandardMaterial(base)
}

// Chain-link: an alpha texture, so the fence reads as mesh rather than a wall.
export function chainLinkTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(150, 158, 170, 0.85)'
  ctx.lineWidth = Math.max(1, size / 128)
  const cell = size / 8
  for (let i = -8; i < 16; i++) {
    ctx.beginPath()
    ctx.moveTo(i * cell, 0)
    ctx.lineTo(i * cell + size, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(i * cell, size)
    ctx.lineTo(i * cell + size, 0)
    ctx.stroke()
  }
  return finish(c)
}

// Stepped terracing with seat rows — read at a distance, so bands rather than seats.
export function seatingTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#8d93a0'
  ctx.fillRect(0, 0, size, size)
  const rows = 8
  for (let r = 0; r < rows; r++) {
    const y = (r / rows) * size
    ctx.fillStyle = r % 2 === 0 ? '#3f6fa8' : '#4a7cb8'
    ctx.fillRect(0, y, size, (size / rows) * 0.62)
    ctx.fillStyle = 'rgba(30, 36, 46, 0.35)'
    ctx.fillRect(0, y + (size / rows) * 0.62, size, Math.max(1, size / 128))
  }
  return finish(c)
}

// Football pitch markings: touchlines, halfway, centre circle, two penalty boxes.
export function pitchLinesTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#2f5230'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(236, 242, 248, 0.8)'
  ctx.lineWidth = Math.max(2, size / 200)
  const m = size * 0.06
  ctx.strokeRect(m, m, size - 2 * m, size - 2 * m)
  ctx.beginPath()
  ctx.moveTo(m, size / 2)
  ctx.lineTo(size - m, size / 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * 0.12, 0, Math.PI * 2)
  ctx.stroke()
  const bw = size * 0.34
  const bh = size * 0.14
  ctx.strokeRect(size / 2 - bw / 2, m, bw, bh)
  ctx.strokeRect(size / 2 - bw / 2, size - m - bh, bw, bh)
  return finish(c)
}

// Rooftop silhouette for the distant ring — alpha above the roofline so sky shows through.
export function skylineTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = '#39414f'
  let x = 0
  let i = 0
  while (x < size) {
    const w = size * (0.02 + worldHash(i * 7 + 3) * 0.05)
    const h = size * (0.25 + worldHash(i * 7 + 4) * 0.5)
    ctx.fillRect(x, size - h, w, h)
    x += w
    i++
  }
  return finish(c)
}

// Long-jump sand.
export function sandTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#cbb68c'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < size * size * 0.05; i++) {
    ctx.fillStyle = `rgba(150, 132, 96, ${0.1 + worldHash(i + 71) * 0.15})`
    ctx.fillRect(worldHash(i * 2 + 72) * size, worldHash(i * 2 + 73) * size, 2, 2)
  }
  return finish(c)
}
