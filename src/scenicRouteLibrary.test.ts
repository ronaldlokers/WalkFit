import { describe, expect, it } from 'vitest'
import { routeCompletion, ROUTE_LIBRARY } from './scenicRouteLibrary'

describe('scenic route library', () => {
  it('keeps stable route identifiers with three playable local routes', () => {
    expect(new Set(ROUTE_LIBRARY.map((route) => route.id)).size).toBe(ROUTE_LIBRARY.length)
    expect(ROUTE_LIBRARY.filter((route) => route.available)).toHaveLength(3)
    expect(ROUTE_LIBRARY[0].distanceM).toBe(800)
  })

  it('derives completion and personal bests from local progression only', () => {
    const route = ROUTE_LIBRARY[0]
    expect(
      routeCompletion(route, {
        routeBadges: ['stadium-park'],
        personalBestsM: { 'stadium-park': 812 },
      }),
    ).toEqual({ completed: true, personalBestM: 812 })
    expect(routeCompletion(route, { routeBadges: [], personalBestsM: {} })).toEqual({
      completed: false,
      personalBestM: 0,
    })
  })
})
