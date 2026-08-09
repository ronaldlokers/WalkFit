// Local route catalogue. All three routes share the bounded chunk/asset pipeline but use
// distinct deterministic path profiles, so each is playable offline without a server.

export interface ScenicRouteDefinition {
  id: string
  name: string
  distanceM: number
  scenery: string
  available: boolean
  badgeId: string
}

export interface RouteCompletionSource {
  routeBadges: readonly string[]
  personalBestsM: Readonly<Record<string, number>>
}

export const ROUTE_LIBRARY: readonly ScenicRouteDefinition[] = [
  {
    id: 'stadium-park',
    name: 'Stadium to Park',
    distanceM: 800,
    scenery: 'track hub · garden · pond · overlook',
    available: true,
    badgeId: 'stadium-park-complete',
  },
  {
    id: 'river-greenway',
    name: 'River Greenway',
    distanceM: 800,
    scenery: 'waterfront · reeds · footbridge',
    available: true,
    badgeId: 'river-greenway-complete',
  },
  {
    id: 'hill-gardens',
    name: 'Hill Gardens',
    distanceM: 800,
    scenery: 'terraces · woodland · skyline',
    available: true,
    badgeId: 'hill-gardens-complete',
  },
]

export function routeCompletion(
  route: ScenicRouteDefinition,
  source: RouteCompletionSource,
): { completed: boolean; personalBestM: number } {
  return {
    completed: source.routeBadges.includes(route.id),
    personalBestM: source.personalBestsM[route.id] ?? 0,
  }
}
