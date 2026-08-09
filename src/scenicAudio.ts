import type { WeatherId } from './scenicSky'

export type AmbientKind = 'birds' | 'crickets' | 'rain'

export interface AmbientProfile {
  kind: AmbientKind
  frequencyHz: number
  gain: number
}

export function ambientProfile(phase: number, weather: WeatherId): AmbientProfile {
  if (weather === 'overcast' || weather === 'mist') {
    return { kind: 'rain', frequencyHz: 140, gain: 0.003 }
  }
  const day = ((phase % 1) + 1) % 1
  if (day >= 0.78 || day < 0.08) return { kind: 'crickets', frequencyHz: 220, gain: 0.0025 }
  return { kind: 'birds', frequencyHz: 620, gain: 0.002 }
}
