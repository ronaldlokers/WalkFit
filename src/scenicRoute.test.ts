import { describe, expect, it } from 'vitest'
import {
  activeRouteChunks,
  crossedLandmarks,
  landmarkAt,
  PARK_ROUTE_M,
  ROUTE_CHUNK_M,
  ROUTE_CHUNKS,
  ROUTE_POOL_CAP,
  ROUTE_TOTAL_M,
  routeChunkAt,
  routePoint,
  RouteChunkPool,
  STADIUM_HUB_M,
} from './scenicRoute'

describe('stadium-to-park route model', () => {
  it('covers a deterministic 400 m extension in equal bounded chunks', () => {
    expect(ROUTE_CHUNKS).toHaveLength(PARK_ROUTE_M / ROUTE_CHUNK_M)
    expect(ROUTE_CHUNKS[0].startM).toBe(STADIUM_HUB_M)
    expect(ROUTE_CHUNKS.at(-1)?.endM).toBe(ROUTE_TOTAL_M)
    for (let i = 1; i < ROUTE_CHUNKS.length; i++) {
      expect(ROUTE_CHUNKS[i].startM).toBe(ROUTE_CHUNKS[i - 1].endM)
    }
  })

  it('selects chunks only in the park extension', () => {
    expect(routeChunkAt(STADIUM_HUB_M - 0.01)).toBeNull()
    expect(routeChunkAt(STADIUM_HUB_M)).toEqual(ROUTE_CHUNKS[0])
    expect(routeChunkAt(ROUTE_TOTAL_M - 0.01)).toEqual(ROUTE_CHUNKS.at(-1))
    expect(routeChunkAt(ROUTE_TOTAL_M)).toBeNull()
    expect(activeRouteChunks(640, 80).length).toBeLessThanOrEqual(ROUTE_POOL_CAP)
  })

  it('keeps the park path continuous and oriented along its authored sweep', () => {
    const start = routePoint(STADIUM_HUB_M)
    const end = routePoint(ROUTE_TOTAL_M)
    expect(start).not.toBeNull()
    expect(end).not.toBeNull()
    expect(end!.x).toBeGreaterThan(start!.x)
    expect(Math.hypot(start!.tx, start!.tz)).toBeCloseTo(1)
    expect(routePoint(ROUTE_TOTAL_M + 1)).toBeNull()
  })

  it('exposes checkpoint and landmark distances', () => {
    expect(landmarkAt(640)?.kind).toBe('checkpoint')
    expect(landmarkAt(640.9, 0.5)).toBeNull()
    expect(landmarkAt(800)?.id).toBe('ridge-overlook')
  })

  it('reports each landmark crossed across a lap boundary exactly once', () => {
    expect(crossedLandmarks(635, 645).map((landmark) => landmark.id)).toEqual(['pond-checkpoint'])
    expect(crossedLandmarks(795, 805).map((landmark) => landmark.id)).toEqual(['ridge-overlook'])
    expect(crossedLandmarks(795, 1605).map((landmark) => landmark.id)).toEqual([
      'ridge-overlook',
      'park-gate',
      'garden-terrace',
      'pond-checkpoint',
      'ridge-overlook',
    ])
  })

  it('reports enter/exit deltas while enforcing the pool cap', () => {
    const pool = new RouteChunkPool()
    const first = pool.update(410, 80)
    expect(first.entered).toEqual(first.active)
    expect(first.active.length).toBeLessThanOrEqual(ROUTE_POOL_CAP)
    const second = pool.update(790, 80)
    expect(second.exited.length).toBeGreaterThan(0)
    expect(pool.clear().length).toBe(second.active.length)
  })
})
