// Geometry array builders for the 3D scenic walk. These return plain vertex/uv/index
// arrays rather than three.js BufferGeometry so the maths is unit-testable without a
// WebGL context (Scenic3D.vue itself can never be tested — jsdom has no WebGL).
//
// UVs matter more than they look: the loop ribbons used to carry none, which forced the
// component's merge pass to DELETE uv from every primitive so mergeGeometries would
// accept a mixed batch. Textured surfaces need the opposite, so every builder here emits
// uv and the merge pass fills in zeros for anything still missing it.
import { trackPoint, LAP_M } from './scenic'

export interface MeshArrays {
  position: number[]
  uv: number[]
  index: number[]
}

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
