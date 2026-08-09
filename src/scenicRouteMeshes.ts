import * as THREE from 'three'
import { routePoint, type RouteChunk } from './scenicRoute'

// A modest ribbon is enough for the first route slice. Chunk geometry is intentionally
// independent: RouteChunkPool can dispose and recreate one section without touching its
// neighbours or the surveyed stadium bake.
export function routeChunkGeometry(chunk: RouteChunk, widthM = 3.2): THREE.BufferGeometry {
  const samples = 10
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= samples; i++) {
    const distance = chunk.startM + (i / samples) * (chunk.endM - chunk.startM)
    const point = routePoint(distance)
    if (!point) throw new Error(`route chunk point outside route: ${chunk.id}`)
    const nx = -point.tz
    const nz = point.tx
    const half = widthM / 2
    positions.push(
      point.x - nx * half,
      0.025,
      point.z - nz * half,
      point.x + nx * half,
      0.025,
      point.z + nz * half,
    )
    const u = i / samples
    uvs.push((u * (chunk.endM - chunk.startM)) / 4, 0, (u * (chunk.endM - chunk.startM)) / 4, 1)
    if (i > 0) {
      const previous = (i - 1) * 2
      const current = i * 2
      indices.push(previous, current, previous + 1, previous + 1, current, current + 1)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
