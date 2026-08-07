import { describe, it, expect } from 'vitest'
import {
  dayPhase,
  DAY_LENGTH_M,
  skyAt,
  isNight,
  weatherFor,
  WEATHER_FOG,
  TIME_PHASES,
  skyBodies,
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

describe('skyBodies', () => {
  it('sun climbs from dawn to the day keyframe and falls after it', () => {
    const dawn = skyBodies(0).sun.elevation
    const morning = skyBodies(0.18).sun.elevation
    const day = skyBodies(0.45).sun.elevation
    const late = skyBodies(0.62).sun.elevation
    expect(morning).toBeGreaterThan(dawn)
    expect(day).toBeGreaterThan(morning)
    expect(late).toBeLessThan(day)
  })

  it('sun is below the horizon and hidden through the whole night band', () => {
    for (const phase of [0.87, 0.9, 0.95, 0.99, 0.0001]) {
      if (!isNight(phase)) continue
      expect(skyBodies(phase).sun.elevation).toBeLessThan(0)
      expect(skyBodies(phase).sun.visible).toBe(false)
    }
  })

  it('the moon is up exactly when the sun is below the horizon', () => {
    for (let p = 0; p < 1; p += 0.01) {
      const b = skyBodies(p)
      // derived from elevation and the night band, NOT from b.sun.visible
      const sunShouldBeUp = b.sun.elevation > 0 && !isNight(p)
      expect(`${p.toFixed(2)}: ${b.moon.visible}`).toBe(`${p.toFixed(2)}: ${!sunShouldBeUp}`)
      // and a visible moon is never below the ground
      if (b.moon.visible) expect(b.moon.elevation).toBeGreaterThanOrEqual(0)
    }
  })

  it('stars are out at night and gone by day, and ramp rather than pop', () => {
    expect(skyBodies(TIME_PHASES.day).starOpacity).toBe(0)
    expect(skyBodies(TIME_PHASES.night).starOpacity).toBeGreaterThan(0.5)
    const a = skyBodies(0.8).starOpacity
    const b = skyBodies(0.84).starOpacity
    expect(b).toBeGreaterThan(a)
    expect(a).toBeGreaterThanOrEqual(0)
  })

  it('sun and moon sit on opposite sides of the sky', () => {
    const b = skyBodies(0.45)
    const delta = Math.abs(b.sun.azimuth - b.moon.azimuth) % (Math.PI * 2)
    expect(delta).toBeCloseTo(Math.PI, 3)
  })

  it('stars fade at BOTH edges of the night band, including the dawn wrap', () => {
    // dusk shoulder: rising toward the night band
    expect(skyBodies(0.8).starOpacity).toBeLessThan(skyBodies(0.815).starOpacity)
    // the boundaries themselves must not jump
    expect(skyBodies(0.8199).starOpacity).toBeCloseTo(skyBodies(0.8201).starOpacity, 2)
    expect(skyBodies(0.0199).starOpacity).toBeCloseTo(skyBodies(0.0201).starOpacity, 2)
    // dawn shoulder: falling away from the night band, gone by 0.07
    expect(skyBodies(0.03).starOpacity).toBeGreaterThan(skyBodies(0.05).starOpacity)
    expect(skyBodies(0.07).starOpacity).toBe(0)
  })
})
