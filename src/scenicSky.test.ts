import { describe, it, expect } from 'vitest'
import {
  dayPhase,
  DAY_LENGTH_M,
  skyAt,
  isNight,
  weatherFor,
  WEATHER_FOG,
  TIME_PHASES,
} from './scenicSky'

describe('day/night', () => {
  it('phase starts at dawn (0) and wraps after DAY_LENGTH_M', () => {
    expect(dayPhase(0)).toBe(0)
    expect(dayPhase(DAY_LENGTH_M / 2)).toBe(0.5)
    expect(dayPhase(DAY_LENGTH_M)).toBe(0)
  })

  it('skyAt lerps between keyframes and matches endpoints across the wrap', () => {
    const dawn = skyAt(0)
    const wrapped = skyAt(0.999999)
    expect(wrapped.sky).toBeCloseTo(dawn.sky, -2)
    const day = skyAt(0.45)
    const night = skyAt(0.87)
    expect(day.sunIntensity).toBeGreaterThan(night.sunIntensity)
    expect(day.ambient).toBeGreaterThan(night.ambient)
  })
})

describe('ambience (#72)', () => {
  it('weather is deterministic per seed and covers all variants', () => {
    expect(weatherFor(1)).toBe(weatherFor(1))
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(weatherFor(i))
    expect([...seen].sort()).toEqual(['clear', 'mist', 'overcast'])
  })

  it('overcast and mist dim the sun and pull the sky toward gray', () => {
    const clear = skyAt(0.45, 'clear')
    const overcast = skyAt(0.45, 'overcast')
    const mist = skyAt(0.45, 'mist')
    expect(overcast.sunIntensity).toBeLessThan(clear.sunIntensity)
    expect(mist.sunIntensity).toBeLessThan(clear.sunIntensity)
    expect(WEATHER_FOG.mist.far).toBeLessThan(WEATHER_FOG.clear.far)
  })

  it('fixed time-of-day phases sit inside sensible bands', () => {
    expect(isNight(TIME_PHASES.night)).toBe(true)
    expect(isNight(TIME_PHASES.day)).toBe(false)
    expect(isNight(TIME_PHASES.dawn)).toBe(false)
    expect(TIME_PHASES.sunset).toBeCloseTo(0.75, 5)
  })
})
