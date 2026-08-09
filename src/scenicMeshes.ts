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
  // Indexing has to agree too, and this one is easy to hit by accident: three's primitives
  // disagree among themselves (PlaneGeometry is indexed, IcosahedronGeometry is not), and
  // the only symptom is mergeGeometries quietly returning null.
  const indexed = geoms[0]!.getIndex() !== null
  for (const g of geoms) {
    if ((g.getIndex() !== null) !== indexed) {
      throw new Error(
        `scenic merge: "${label}" mixes indexed and non-indexed geometry — ` +
          'call toNonIndexed() on the indexed ones',
      )
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

// Derive a tangent-space normal map from a colour texture's own luminance, treating it as a
// height field: central differences give the surface slope, which becomes the xy of the
// normal. Every surface here is generated into a canvas, so the height field is free — no
// authored maps, no extra downloads.
//
// This is what separates "a photo of tartan" from "tartan": with a colour map alone the
// track, the concrete and the seating are perfectly flat planes that happen to be patterned,
// and no light direction ever changes how they look.
export function normalFromTexture(src: THREE.CanvasTexture, strength = 1): THREE.CanvasTexture {
  const img = src.image as HTMLCanvasElement
  const size = img.width
  const sctx = img.getContext('2d')!
  const height = sctx.getImageData(0, 0, size, size).data
  const [c, ctx] = canvas(size)
  const out = ctx.createImageData(size, size)
  // luminance at (x, y), wrapping — these textures tile, so the derivative has to tile too
  const lum = (x: number, y: number) => {
    const i = (((y + size) % size) * size + ((x + size) % size)) * 4
    return (0.2126 * height[i]! + 0.7152 * height[i + 1]! + 0.0722 * height[i + 2]!) / 255
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength
      // normalise (-dx, -dy, 1) into the 0..255 encoding three expects
      const len = Math.hypot(dx, dy, 1)
      const i = (y * size + x) * 4
      out.data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255)
      out.data[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255)
      out.data[i + 2] = Math.round((1 / len) * 0.5 * 255 + 127.5)
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  // A normal map is data, not colour: sRGB decoding it bends every slope it encodes.
  t.colorSpace = THREE.NoColorSpace
  t.repeat.copy(src.repeat)
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

// One octave of value noise: random cells drawn small, then scaled up through the canvas's
// own bilinear filter. Drawing the cells at full size instead (the first cut) left hard
// square edges — at the infield's 10 m repeat those squares are 0.8 m across and read as
// tiling blocks from ten metres away, which is what made the grass look like a checkerboard.
function noiseLayer(
  ctx: CanvasRenderingContext2D,
  size: number,
  cells: number,
  salt: number,
  paint: (v: number) => string,
): void {
  const [n, nctx] = canvas(cells)
  for (let i = 0; i < cells * cells; i++) {
    nctx.fillStyle = paint(worldHash(i * 7 + salt))
    nctx.fillRect(i % cells, Math.floor(i / cells), 1, 1)
  }
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(n, 0, 0, size, size)
}

// grass / infield: two octaves of smooth value noise, mowing stripes, then blade streaks.
// `hue` shifts the two green surfaces apart so ground and infield do not read as one
// continuous plane.
export function grassTexture(size: number, hue: number, mown = true): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = `hsl(${hue}, 30%, 24%)`
  ctx.fillRect(0, 0, size, size)
  // broad patchiness, then a finer break-up on top of it
  noiseLayer(ctx, size, 16, 11, (v) => `hsla(${hue + (v - 0.5) * 16}, 32%, ${20 + v * 12}%, 0.85)`)
  noiseLayer(ctx, size, 64, 23, (v) => `hsla(${hue + (v - 0.5) * 10}, 30%, ${20 + v * 10}%, 0.35)`)
  // mowing stripes: the single strongest "this is a maintained sports ground" cue, and
  // free — a groundsman's roller lays the blades in alternating directions, which reads as
  // alternating lightness. Four bands per tile so the texture still tiles seamlessly.
  if (mown) {
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.05)'
      ctx.fillRect(0, (i / 4) * size, size, size / 4)
    }
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

// Canopy alpha for crossed-billboard foliage: an irregular cluster of leaf clumps with a
// ragged edge, transparent outside it. A convex primitive (the icosahedron this replaces)
// reads as a faceted ball no matter how it is textured — the silhouette is the whole tell,
// and a silhouette is exactly what a solid mesh cannot fake.
export function canopyTexture(size: number, hue: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  const cx = size / 2
  const cy = size * 0.46
  // main mass, then clumps around its edge to break the outline up
  const clumps = 26
  for (let i = 0; i < clumps; i++) {
    const h = i * 4
    const a = worldHash(h + 301) * Math.PI * 2
    const rad = size * 0.3 * Math.sqrt(worldHash(h + 302))
    const x = cx + Math.cos(a) * rad
    const y = cy + Math.sin(a) * rad * 0.86
    const r = size * (0.07 + worldHash(h + 303) * 0.09)
    const v = worldHash(h + 304)
    ctx.fillStyle = `hsl(${hue + (v - 0.5) * 18}, ${34 + v * 16}%, ${20 + v * 20}%)`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  // leaf speckle inside the mass so it is not a flat colour when close
  for (let i = 0; i < size * 3; i++) {
    const h = i * 3
    const a = worldHash(h + 401) * Math.PI * 2
    const rad = size * 0.34 * Math.sqrt(worldHash(h + 402))
    const x = cx + Math.cos(a) * rad
    const y = cy + Math.sin(a) * rad * 0.86
    const v = worldHash(h + 403)
    ctx.globalCompositeOperation = 'source-atop' // only where canopy already is
    ctx.fillStyle = `hsla(${hue + (v - 0.5) * 14}, 40%, ${18 + v * 26}%, 0.5)`
    ctx.fillRect(x, y, 2, 2)
  }
  ctx.globalCompositeOperation = 'source-over'
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

// Cumulus alpha: soft-edged puffs gathered into a handful of clusters, with real gaps of
// clear sky between them. The first cut stacked 70 hard-edged circles at low alpha across
// the whole tile, which averaged out to a uniform haze — it read as the sky being milky
// rather than as clouds, and left nowhere for the blue to show through.
export function cloudTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  const puff = (x: number, y: number, r: number, a: number) => {
    // Drawn at every wrap offset it could straddle, so a cluster near an edge continues on
    // the far side instead of being cut in half at the tile seam.
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (Math.abs(x + ox - size / 2) > size || Math.abs(y + oy - size / 2) > size) continue
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r)
        g.addColorStop(0, `rgba(255,255,255,${a})`)
        g.addColorStop(0.55, `rgba(255,255,255,${a * 0.55})`)
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        // flattened: cumulus are wider than they are tall
        ctx.ellipse(x + ox, y + oy, r, r * 0.62, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  const clusters = 7
  for (let k = 0; k < clusters; k++) {
    const cx = worldHash(k * 5 + 501) * size
    const cy = worldHash(k * 5 + 502) * size
    const spread = size * (0.06 + worldHash(k * 5 + 503) * 0.08)
    const puffs = 5 + Math.floor(worldHash(k * 5 + 504) * 5)
    for (let i = 0; i < puffs; i++) {
      const h = (k * 37 + i) * 3
      puff(
        cx + (worldHash(h + 601) - 0.5) * spread * 2.4,
        cy + (worldHash(h + 602) - 0.5) * spread,
        size * (0.05 + worldHash(h + 603) * 0.07),
        0.5 + worldHash(h + 604) * 0.4,
      )
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// A pacer is five meshes — torso, two arms, two legs — in the kit colour, plus a head in
// skin tone. The head used to be merged into the torso and therefore wore the kit colour
// too, which is the single clearest reason the figures read as mannequins rather than
// people: a runner whose head is the same flat colour as their shirt has no face, no skin
// and no silhouette break at the shoulders.
// Arms and legs need DIFFERENT lengths: a leg has to reach the ground from the hip, and an
// arm that long would hang past the knee. Each limb pivots at its top so a rotation about x
// swings it from the shoulder or hip.
export function runnerParts(): {
  body: THREE.BufferGeometry
  head: THREE.BufferGeometry
  arm: THREE.BufferGeometry
  leg: THREE.BufferGeometry
} {
  const torso = new THREE.CapsuleGeometry(0.16, 0.5, 3, 6)
  torso.translate(0, 1.15, 0)
  const neck = new THREE.CylinderGeometry(0.055, 0.07, 0.09, 6)
  neck.translate(0, 1.45, 0)
  const body = mergeGeometries([torso, neck])!
  torso.dispose()
  neck.dispose()
  const head = new THREE.SphereGeometry(0.115, 10, 8)
  head.translate(0, 1.575, 0)
  // Leg: half-height is length/2 + radius = 0.43, so translating by that puts the pivot at
  // the very top and the foot exactly 0.86 m below it. Mounted at hip y = 0.86, the foot
  // lands on y = 0 — the track surface.
  const leg = new THREE.CapsuleGeometry(0.06, 0.74, 3, 5)
  leg.translate(0, -0.43, 0)
  // Arm: 0.60 m from the shoulder, so the hand sits at y = 0.82 with the shoulder at 1.42.
  const arm = new THREE.CapsuleGeometry(0.05, 0.5, 3, 5)
  arm.translate(0, -0.3, 0)
  return { body, head, arm, leg }
}

// Always Standard: material class cannot change after the bake (materials are the merge
// keys), so a tier-dependent class meant the auto-probed upgrade silently kept Lambert
// and left every roughness value inert. The tier still gates what actually costs —
// shadow map, texture resolution, object counts.
export function surface(opts: {
  color: number
  map?: THREE.Texture
  normalMap?: THREE.Texture | null
  normalScale?: number
  vertexColors?: boolean
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
    vertexColors: opts.vertexColors ?? false,
  }
  if (opts.map) base.map = opts.map
  if (opts.normalMap) {
    base.normalMap = opts.normalMap
    const k = opts.normalScale ?? 1
    base.normalScale = new THREE.Vector2(k, k)
  }
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

// Stepped terracing with seat rows — read at a distance, so bands rather than seats, but
// with the detail that makes a stand look occupied rather than moulded: individual seat
// divisions, a scattering of spectators, and a shaded gap under each row's lip.
export function seatingTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#8d93a0'
  ctx.fillRect(0, 0, size, size)
  const rows = 8
  const rowH = size / rows
  const seatW = Math.max(3, size / 64)
  for (let r = 0; r < rows; r++) {
    const y = r * rowH
    ctx.fillStyle = r % 2 === 0 ? '#3f6fa8' : '#4a7cb8'
    ctx.fillRect(0, y, size, rowH * 0.62)
    // seat divisions: a dark hairline every seatW, so the band is a row of seats
    ctx.fillStyle = 'rgba(22, 30, 44, 0.30)'
    for (let x = 0; x < size; x += seatW) ctx.fillRect(x, y, Math.max(1, seatW * 0.14), rowH * 0.62)
    // a sparse crowd — never full, and never evenly spread
    for (let x = 0; x < size; x += seatW) {
      const h = Math.round(x * 3 + r * 131)
      if (worldHash(h + 701) > 0.26) continue
      const v = worldHash(h + 702)
      ctx.fillStyle = `hsl(${Math.round(v * 360)}, ${40 + v * 30}%, ${40 + v * 25}%)`
      ctx.fillRect(x + seatW * 0.18, y + rowH * 0.1, seatW * 0.6, rowH * 0.42)
      ctx.fillStyle = 'rgba(60, 44, 34, 0.75)' // head
      ctx.fillRect(x + seatW * 0.3, y + rowH * 0.02, seatW * 0.36, rowH * 0.12)
    }
    // shaded gap under the row's lip, and the tread edge itself
    ctx.fillStyle = 'rgba(18, 24, 34, 0.45)'
    ctx.fillRect(0, y + rowH * 0.62, size, Math.max(1, rowH * 0.16))
    ctx.fillStyle = 'rgba(214, 220, 230, 0.35)'
    ctx.fillRect(0, y + rowH * 0.78, size, Math.max(1, size / 200))
  }
  return finish(c)
}

// Football pitch markings: touchlines, halfway, centre circle, two penalty boxes.
export function pitchLinesTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#2f5230'
  ctx.fillRect(0, 0, size, size)
  // Mown stripes across the pitch, drawn before the markings so the lines sit on top of
  // them the way paint does. This texture is not tiled (one copy over the whole pitch), so
  // the band count is the stripe count a groundsman would actually cut.
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'
    ctx.fillRect(0, (i / 8) * size, size, size / 8)
  }
  ctx.strokeStyle = 'rgba(236, 242, 248, 0.8)'
  ctx.lineWidth = Math.max(2, size / 200)
  const m = size * 0.06
  ctx.strokeRect(m, m, size - 2 * m, size - 2 * m)
  ctx.beginPath()
  ctx.moveTo(m, size / 2)
  ctx.lineTo(size - m, size / 2)
  ctx.stroke()
  // The pitch plane is 40 m across by 64 m along, so v stretches 1.6x relative to u.
  // Pre-squash the circle by 40/64 so it renders round on the ground.
  ctx.beginPath()
  ctx.ellipse(size / 2, size / 2, size * 0.12, size * 0.12 * (40 / 64), 0, 0, Math.PI * 2)
  ctx.stroke()
  const bw = size * 0.34
  const bh = size * 0.14
  ctx.strokeRect(size / 2 - bw / 2, m, bw, bh)
  ctx.strokeRect(size / 2 - bw / 2, size - m - bh, bw, bh)
  return finish(c)
}

// Rooftop silhouette for the distant ring — alpha above the roofline so sky shows through.
//
// Authored LIGHT on purpose. The mesh multiplies this by the current fog colour every
// frame, so a light facade lands on the fog colour with its detail intact (distant
// buildings in haze) while a dark one lands on near-black. The first cut painted one row
// of 26 flat #39414f slabs spanning the full 1508 m circumference: each "building" was
// 58 m wide, which is why it read as a wall rather than a skyline.
export function skylineTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  // two depth layers: a paler, taller row behind, a slightly darker row in front. The
  // overlap is what stops the roofline reading as a single cut-out strip.
  // Mid-tone, low-contrast: light enough that the fog multiply keeps the structure, dark
  // enough that they still read as buildings. Painted near-white (the first attempt at
  // fixing the multiply) they came out as a bank of ghostly slabs indistinguishable from
  // the sky, and the window rows read as horizontal scratches.
  const layers = [
    { fill: '#74808f', win: 'rgba(52,60,74,0.24)', wMin: 0.012, wVar: 0.03, hMin: 0.3, hVar: 0.45 },
    {
      fill: '#828d9e',
      win: 'rgba(62,72,88,0.26)',
      wMin: 0.008,
      wVar: 0.022,
      hMin: 0.16,
      hVar: 0.3,
    },
  ]
  layers.forEach((L, li) => {
    let x = 0
    let i = 0
    while (x < size) {
      const w = size * (L.wMin + worldHash(i * 11 + li * 97 + 3) * L.wVar)
      // Gaps of open sky. Without them every block abuts its neighbour and the row reads as
      // one continuous wall no matter how the heights vary.
      if (worldHash(i * 11 + li * 97 + 9) < 0.22) {
        x += w * 0.7
        i++
        continue
      }
      const hv = worldHash(i * 11 + li * 97 + 4)
      // squared, so most blocks are low and the occasional tower stands well clear
      const h = size * (L.hMin + hv * hv * L.hVar * 1.6)
      const top = size - h
      ctx.fillStyle = L.fill
      ctx.fillRect(x, top, w, h)
      // window grid — spacing in texels, so it stays a grid at any generated size
      const step = Math.max(3, size / 180)
      ctx.fillStyle = L.win
      for (let wy = top + step * 1.5; wy < size - step; wy += step * 2) {
        for (let wx = x + step * 0.8; wx < x + w - step; wx += step * 2) {
          if (worldHash(Math.round(wx * 3 + wy * 7 + li * 31)) < 0.22) continue // dark windows
          ctx.fillRect(wx, wy, step, step)
        }
      }
      // occasional roof furniture: a mast or a stepped-back top floor
      const r = worldHash(i * 11 + li * 97 + 5)
      if (r > 0.82) {
        ctx.fillStyle = L.fill
        ctx.fillRect(x + w * 0.45, top - h * 0.14, Math.max(1, w * 0.06), h * 0.14)
      } else if (r < 0.16) {
        ctx.fillStyle = L.fill
        ctx.fillRect(x + w * 0.2, top - h * 0.08, w * 0.6, h * 0.08)
      }
      x += w
      i++
    }
  })
  // Aerial perspective: haze thickens toward the horizon, so wash the lower band out. Done
  // with a white overlay rather than by fading alpha — dissolving the bases would leave the
  // buildings floating with a gap under them.
  const hz = ctx.createLinearGradient(0, size * 0.55, 0, size)
  hz.addColorStop(0, 'rgba(255,255,255,0)')
  hz.addColorStop(1, 'rgba(255,255,255,0.4)')
  ctx.fillStyle = hz
  ctx.globalCompositeOperation = 'source-atop' // only where a building already is
  ctx.fillRect(0, size * 0.55, size, size * 0.45)
  ctx.globalCompositeOperation = 'source-over'
  return finish(c)
}

// Distant treeline: a silhouette ring between the venue fence and the skyline, so the world
// does not end at a hard grass/sky edge. Alpha above the canopy, opaque below.
//
// `groundV` is where the world's y=0 lands in this texture's v — the caller derives it from
// the cylinder's height and centre. The crowns are drawn tall in v and narrow in u because
// the two axes have wildly different metres-per-texel: the ring is ~1000 m around and only
// 26 m high, so a circular crown in texture space renders as a 0.5 m sliver in the world.
// Drawn round, the whole ring came out as a single dark hairline on the horizon.
export const TREELINE_GROUND_V = 0.73

export function treeLineTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  const base = size * TREELINE_GROUND_V
  const crowns = 120
  for (let i = 0; i < crowns; i++) {
    const h = i * 5
    const x = (i / crowns) * size + (worldHash(h + 811) - 0.5) * (size / crowns) * 1.6
    const rx = size * (0.006 + worldHash(h + 812) * 0.012)
    // in metres, not texels: v spans the ring's 26 m over the full canvas, so a crown has
    // to be drawn very tall in v to come out 6-12 m tall in the world
    const ry = size * (0.2 + worldHash(h + 813) * 0.16)
    const top = base - ry * 0.9
    ctx.fillStyle = `hsl(${94 + worldHash(h + 814) * 18}, 26%, ${15 + worldHash(h + 815) * 10}%)`
    ctx.beginPath()
    ctx.ellipse(x, top, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(x - rx * 0.35, top, rx * 0.7, base - top)
  }
  // solid ground band below the canopy so no sky leaks under the trees
  ctx.fillStyle = 'hsl(100, 20%, 19%)'
  ctx.fillRect(0, base - 1, size, size - base + 1)
  return finish(c)
}

// Long-jump sand.
export function sandTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#cbb68c'
  ctx.fillRect(0, 0, size, size)
  // Capped the same way tartanTexture is: uncapped, the high tier's size * size * 0.05 is
  // 52,428 iterations, which stalled applyTier's promotion by ~200 ms on the auto probe.
  const speckles = Math.min(size * size * 0.05, 20000)
  for (let i = 0; i < speckles; i++) {
    ctx.fillStyle = `rgba(150, 132, 96, ${0.1 + worldHash(i + 71) * 0.15})`
    ctx.fillRect(worldHash(i * 2 + 72) * size, worldHash(i * 2 + 73) * size, 2, 2)
  }
  return finish(c)
}
