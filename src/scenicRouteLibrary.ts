// Local route catalogue. Only the first route is wired to the current renderer; the other
// entries make the forward-compatible identifiers and metadata explicit without pretending
// that an unbuilt route is playable.

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
    distanceM: 1200,
    scenery: 'waterfront · reeds · footbridge',
    available: false,
    badgeId: 'river-greenway-complete',
  },
  {
    id: 'hill-gardens',
    name: 'Hill Gardens',
    distanceM: 1600,
    scenery: 'terraces · woodland · skyline',
    available: false,
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
