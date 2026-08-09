// Pure route model for the first stadium-to-park vertical slice. The surveyed track remains
// the hub (0..400 m); this extension is deliberately data-only until the renderer consumes
// it, so route decisions can be tested without Three.js or a browser.

import { BEND_R, STRAIGHT_M, TRACK_OUT } from './scenic'

export const STADIUM_HUB_M = 400
export const PARK_ROUTE_M = 400
export const ROUTE_TOTAL_M = STADIUM_HUB_M + PARK_ROUTE_M
export const ROUTE_CHUNK_M = 80
export const ROUTE_POOL_CAP = 3

export type RouteBiome = 'gate' | 'promenade' | 'garden' | 'pond' | 'overlook'

export interface RouteLandmark {
  id: string
  name: string
  distanceM: number
  kind: 'gate' | 'landmark' | 'checkpoint'
}

export interface RouteChunk {
  id: string
  index: number
  startM: number
  endM: number
  biome: RouteBiome
  landmarkId?: string
}

export interface RoutePoint {
  x: number
  z: number
  tx: number
  tz: number
}

// The park path leaves the outer edge of the home straight and sweeps into open space.
// It is intentionally gentle and deterministic; later art passes can replace the control
// curve without changing route distances, landmarks, or chunk IDs.
export function routePoint(distanceM: number): RoutePoint | null {
  if (!Number.isFinite(distanceM) || distanceM < STADIUM_HUB_M || distanceM > ROUTE_TOTAL_M)
    return null
  const local = Math.max(0, Math.min(PARK_ROUTE_M, distanceM - STADIUM_HUB_M))
  const u = local / PARK_ROUTE_M
  const x = BEND_R + TRACK_OUT + 3 + local * 0.32
  const z = STRAIGHT_M / 2 - local * 0.2 + Math.sin(u * Math.PI * 2) * 14
  const dx = 0.32
  const dz = -0.2 + (Math.cos(u * Math.PI * 2) * (14 * Math.PI * 2)) / PARK_ROUTE_M
  const length = Math.hypot(dx, dz)
  return { x, z, tx: dx / length, tz: dz / length }
}

const CHUNK_BIOMES: readonly RouteBiome[] = ['gate', 'promenade', 'garden', 'pond', 'overlook']

export const ROUTE_LANDMARKS: readonly RouteLandmark[] = [
  { id: 'park-gate', name: 'Park gate', distanceM: 400, kind: 'gate' },
  { id: 'garden-terrace', name: 'Garden terrace', distanceM: 560, kind: 'landmark' },
  { id: 'pond-checkpoint', name: 'Pond checkpoint', distanceM: 640, kind: 'checkpoint' },
  { id: 'ridge-overlook', name: 'Ridge overlook', distanceM: 800, kind: 'landmark' },
]

export const ROUTE_CHUNKS: readonly RouteChunk[] = CHUNK_BIOMES.map((biome, index) => {
  const startM = STADIUM_HUB_M + index * ROUTE_CHUNK_M
  const landmark = ROUTE_LANDMARKS.find((candidate) => candidate.distanceM === startM)
  return {
    id: `park-${biome}`,
    index,
    startM,
    endM: startM + ROUTE_CHUNK_M,
    biome,
    ...(landmark ? { landmarkId: landmark.id } : {}),
  }
})

export function routeChunkAt(distanceM: number): RouteChunk | null {
  if (!Number.isFinite(distanceM) || distanceM < STADIUM_HUB_M || distanceM >= ROUTE_TOTAL_M)
    return null
  return ROUTE_CHUNKS[Math.floor((distanceM - STADIUM_HUB_M) / ROUTE_CHUNK_M)] ?? null
}

export function activeRouteChunks(distanceM: number, radiusM = ROUTE_CHUNK_M): RouteChunk[] {
  if (!Number.isFinite(distanceM) || radiusM < 0) return []
  const min = distanceM - radiusM
  const max = distanceM + radiusM
  return ROUTE_CHUNKS.filter((chunk) => chunk.endM > min && chunk.startM < max).slice(
    0,
    ROUTE_POOL_CAP,
  )
}

export function landmarkAt(distanceM: number, toleranceM = 1): RouteLandmark | null {
  if (!Number.isFinite(distanceM) || toleranceM < 0) return null
  return (
    ROUTE_LANDMARKS.find((landmark) => Math.abs(landmark.distanceM - distanceM) <= toleranceM) ??
    null
  )
}

export function crossedLandmarks(previousM: number, currentM: number): RouteLandmark[] {
  if (!Number.isFinite(previousM) || !Number.isFinite(currentM) || currentM <= previousM) return []
  const firstLap = Math.floor(previousM / ROUTE_TOTAL_M)
  const lastLap = Math.floor(currentM / ROUTE_TOTAL_M)
  const crossed: RouteLandmark[] = []
  for (let lap = firstLap; lap <= lastLap; lap++) {
    for (const landmark of ROUTE_LANDMARKS) {
      const absolute = lap * ROUTE_TOTAL_M + landmark.distanceM
      if (absolute > previousM && absolute <= currentM) crossed.push(landmark)
    }
  }
  return crossed
}

export interface RoutePoolDelta {
  active: RouteChunk[]
  entered: RouteChunk[]
  exited: RouteChunk[]
}

// Renderer-facing pool bookkeeping. It never creates Three.js objects; callers map entered
// chunks to meshes and dispose exited meshes, while this class enforces the hard cap.
export class RouteChunkPool {
  private activeIds = new Set<string>()

  update(distanceM: number, radiusM = ROUTE_CHUNK_M): RoutePoolDelta {
    const active = activeRouteChunks(distanceM, radiusM)
    const nextIds = new Set(active.map((chunk) => chunk.id))
    const entered = active.filter((chunk) => !this.activeIds.has(chunk.id))
    const exited = ROUTE_CHUNKS.filter(
      (chunk) => this.activeIds.has(chunk.id) && !nextIds.has(chunk.id),
    )
    this.activeIds = nextIds
    return { active, entered, exited }
  }

  clear(): RouteChunk[] {
    const exited = ROUTE_CHUNKS.filter((chunk) => this.activeIds.has(chunk.id))
    this.activeIds.clear()
    return exited
  }
}
