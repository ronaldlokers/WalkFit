import type { WeatherId } from './scenicSky'

export type AmbientKind = 'birds' | 'crickets' | 'rain'

export interface AmbientProfile {
  kind: AmbientKind
  frequencyHz: number
  gain: number
}

export type ScenicCueKind = 'checkpoint' | 'achievement' | 'level-up' | 'footstep'

export interface ScenicCue {
  frequenciesHz: readonly number[]
  durationMs: number
  gapMs: number
}

const CUES: Record<ScenicCueKind, ScenicCue> = {
  checkpoint: { frequenciesHz: [660, 880], durationMs: 90, gapMs: 55 },
  achievement: { frequenciesHz: [784, 988, 1319], durationMs: 110, gapMs: 65 },
  'level-up': { frequenciesHz: [523, 659, 784, 1047], durationMs: 120, gapMs: 70 },
  footstep: { frequenciesHz: [145], durationMs: 35, gapMs: 0 },
}

export function scenicCue(kind: ScenicCueKind): ScenicCue {
  return CUES[kind]
}

export function ambientProfile(phase: number, weather: WeatherId): AmbientProfile {
  if (weather === 'overcast' || weather === 'mist') {
    return { kind: 'rain', frequencyHz: 140, gain: 0.003 }
  }
  const day = ((phase % 1) + 1) % 1
  if (day >= 0.78 || day < 0.08) return { kind: 'crickets', frequencyHz: 220, gain: 0.0025 }
  return { kind: 'birds', frequencyHz: 620, gain: 0.002 }
}
