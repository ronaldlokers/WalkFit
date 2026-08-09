// Offline-first Scenic v3 progression. This module is pure apart from the optional Storage
// adapter, so XP and unlock decisions stay deterministic and are covered without Vue.

export const PROGRESSION_KEY = 'walkfit.progression'
export const PROGRESSION_VERSION = 1

export type MissionMetric = 'distanceM' | 'activeMinutes' | 'sessions'

export interface ProgressionMission {
  id: string
  metric: MissionMetric
  target: number
  rewardXp: number
}

export interface ProgressionState {
  version: 1
  xp: number
  level: number
  activeMinutes: number
  distanceM: number
  completedSessions: number
  streakDays: number
  lastActiveDate: string | null
  routeBadges: string[]
  personalBestsM: Record<string, number>
  cosmeticUnlocks: string[]
  daily: { id: string; progress: number; claimed: boolean }
  weekly: { id: string; progress: number; claimed: boolean }
}

export interface CompletedWalk {
  dateKey: string
  distanceM: number
  activeMinutes: number
  workoutCompleted?: boolean
  routeId?: string
  routeDistanceM?: number
}

const UNLOCKS = [
  { level: 1, id: 'sky' },
  { level: 2, id: 'coral' },
  { level: 3, id: 'lime' },
  { level: 5, id: 'violet' },
]

export function levelForXp(xp: number): number {
  const safe = Math.max(0, Number.isFinite(xp) ? xp : 0)
  return Math.max(1, Math.floor(Math.sqrt(safe / 100)) + 1)
}

function validDateKey(dateKey: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) && !Number.isNaN(Date.parse(`${dateKey}T00:00:00Z`))
}

function previousDate(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export function dailyMission(dateKey: string): ProgressionMission {
  const day = validDateKey(dateKey) ? Date.parse(`${dateKey}T00:00:00Z`) / 86_400_000 : 0
  const variant = Math.abs(Math.floor(day)) % 3
  const missions: ProgressionMission[] = [
    { id: `daily-distance-${dateKey}`, metric: 'distanceM', target: 1500, rewardXp: 40 },
    { id: `daily-minutes-${dateKey}`, metric: 'activeMinutes', target: 20, rewardXp: 45 },
    { id: `daily-sessions-${dateKey}`, metric: 'sessions', target: 1, rewardXp: 35 },
  ]
  return missions[variant]!
}

export function weeklyMission(dateKey: string): ProgressionMission {
  const date = validDateKey(dateKey) ? new Date(`${dateKey}T00:00:00Z`) : new Date(0)
  const monday = new Date(date)
  const weekday = monday.getUTCDay() || 7
  monday.setUTCDate(monday.getUTCDate() - weekday + 1)
  const weekKey = monday.toISOString().slice(0, 10)
  return { id: `weekly-sessions-${weekKey}`, metric: 'sessions', target: 3, rewardXp: 100 }
}

export function initialProgression(): ProgressionState {
  return {
    version: PROGRESSION_VERSION,
    xp: 0,
    level: 1,
    activeMinutes: 0,
    distanceM: 0,
    completedSessions: 0,
    streakDays: 0,
    lastActiveDate: null,
    routeBadges: [],
    personalBestsM: {},
    // The original four palettes shipped before Scenic v3 and remain available for
    // backwards compatibility; future palettes can be added to UNLOCKS without locking
    // an existing preference after an update.
    cosmeticUnlocks: ['sky', 'coral', 'lime', 'violet'],
    daily: { id: '', progress: 0, claimed: false },
    weekly: { id: '', progress: 0, claimed: false },
  }
}

function normalise(value: unknown): ProgressionState {
  const base = initialProgression()
  if (!value || typeof value !== 'object') return base
  const raw = value as Partial<ProgressionState>
  const state: ProgressionState = {
    ...base,
    xp: Number.isFinite(raw.xp) ? Math.max(0, raw.xp!) : base.xp,
    level: Number.isFinite(raw.level) ? Math.max(1, raw.level!) : base.level,
    activeMinutes: Number.isFinite(raw.activeMinutes) ? Math.max(0, raw.activeMinutes!) : 0,
    distanceM: Number.isFinite(raw.distanceM) ? Math.max(0, raw.distanceM!) : 0,
    completedSessions: Number.isFinite(raw.completedSessions)
      ? Math.max(0, raw.completedSessions!)
      : 0,
    streakDays: Number.isFinite(raw.streakDays) ? Math.max(0, raw.streakDays!) : 0,
    lastActiveDate: typeof raw.lastActiveDate === 'string' ? raw.lastActiveDate : null,
    routeBadges: Array.isArray(raw.routeBadges)
      ? raw.routeBadges.filter((id): id is string => typeof id === 'string')
      : [],
    personalBestsM:
      raw.personalBestsM && typeof raw.personalBestsM === 'object'
        ? ({ ...raw.personalBestsM } as Record<string, number>)
        : {},
    cosmeticUnlocks: Array.isArray(raw.cosmeticUnlocks)
      ? raw.cosmeticUnlocks.filter((id): id is string => typeof id === 'string')
      : base.cosmeticUnlocks,
    daily:
      raw.daily && typeof raw.daily === 'object' ? { ...base.daily, ...raw.daily } : base.daily,
    weekly:
      raw.weekly && typeof raw.weekly === 'object'
        ? { ...base.weekly, ...raw.weekly }
        : base.weekly,
  }
  state.level = levelForXp(state.xp)
  for (const unlock of UNLOCKS)
    if (state.level >= unlock.level && !state.cosmeticUnlocks.includes(unlock.id))
      state.cosmeticUnlocks.push(unlock.id)
  return state
}

export function loadProgression(
  storage: Pick<Storage, 'getItem'> = localStorage,
): ProgressionState {
  try {
    const value = storage.getItem(PROGRESSION_KEY)
    return value ? normalise(JSON.parse(value)) : initialProgression()
  } catch {
    return initialProgression()
  }
}

export function saveProgression(
  state: ProgressionState,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(PROGRESSION_KEY, JSON.stringify(normalise(state)))
}

export function recordCompletedWalk(
  previous: ProgressionState,
  walk: CompletedWalk,
): ProgressionState {
  if (!validDateKey(walk.dateKey)) return normalise(previous)
  const distanceM = Math.max(0, Number.isFinite(walk.distanceM) ? walk.distanceM : 0)
  const activeMinutes = Math.max(0, Number.isFinite(walk.activeMinutes) ? walk.activeMinutes : 0)
  const state = normalise(previous)
  const today = dailyMission(walk.dateKey)
  const week = weeklyMission(walk.dateKey)
  state.daily ??= { id: '', progress: 0, claimed: false }
  state.weekly ??= { id: '', progress: 0, claimed: false }
  if (state.daily.id !== today.id) state.daily = { id: today.id, progress: 0, claimed: false }
  if (state.weekly.id !== week.id) state.weekly = { id: week.id, progress: 0, claimed: false }
  const wasNewDay = state.lastActiveDate !== walk.dateKey
  state.xp += Math.floor(distanceM / 100) + Math.floor(activeMinutes * 2)
  if (walk.workoutCompleted) state.xp += 50
  if (wasNewDay) state.xp += state.lastActiveDate === previousDate(walk.dateKey) ? 25 : 10
  state.activeMinutes += activeMinutes
  state.distanceM += distanceM
  state.completedSessions += 1
  state.streakDays = state.lastActiveDate === previousDate(walk.dateKey) ? state.streakDays + 1 : 1
  state.lastActiveDate = walk.dateKey
  if (walk.routeId && walk.routeDistanceM !== undefined) {
    const routeDistanceM = Math.max(0, walk.routeDistanceM)
    const best = state.personalBestsM[walk.routeId] ?? 0
    if (routeDistanceM > best) state.personalBestsM[walk.routeId] = routeDistanceM
    if (routeDistanceM >= 800 && !state.routeBadges.includes(walk.routeId))
      state.routeBadges.push(walk.routeId)
  }
  const progressValue = (mission: ProgressionMission) =>
    mission.metric === 'distanceM'
      ? distanceM
      : mission.metric === 'activeMinutes'
        ? activeMinutes
        : 1
  state.daily.progress += progressValue(today)
  state.weekly.progress += 1
  if (!state.daily.claimed && state.daily.progress >= today.target) {
    state.xp += today.rewardXp
    state.daily.claimed = true
  }
  if (!state.weekly.claimed && state.weekly.progress >= week.target) {
    state.xp += week.rewardXp
    state.weekly.claimed = true
  }
  state.level = levelForXp(state.xp)
  for (const unlock of UNLOCKS)
    if (state.level >= unlock.level && !state.cosmeticUnlocks.includes(unlock.id))
      state.cosmeticUnlocks.push(unlock.id)
  return state
}
