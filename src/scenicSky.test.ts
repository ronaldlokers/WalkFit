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
  cloudColor,
} from './scenicSky'

const lumOf = (c: number) =>
  0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff)

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

  it('weather desaturates the sky without brightening it', () => {
    for (const phase of [TIME_PHASES.day, TIME_PHASES.night]) {
      const lum = (c: number) =>
        0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff)
      const clear = skyAt(phase, 'clear')
      for (const w of ['overcast', 'mist'] as const) {
        const bad = skyAt(phase, w)
        expect(`${w}@${phase}`).toBe(
          lum(bad.sky) <= lum(clear.sky) + 1 ? `${w}@${phase}` : `${w}@${phase} brightened the sky`,
        )
      }
    }
    // and the headline case: a misty night must stay darker than a clear day
    expect(lumOf(skyAt(TIME_PHASES.night, 'mist').sky)).toBeLessThan(
      lumOf(skyAt(TIME_PHASES.day, 'clear').sky),
    )
  })
})

describe('palette brightness (#realism slice 1)', () => {
  it('daylight is authored bright for ACES, not muted', () => {
    const day = skyAt(0.45)
    // the muted palette peaked at sunIntensity 1.1; ACES compresses highlights, so real
    // outdoor brightness needs a much larger number to survive tone mapping
    expect(day.sunIntensity).toBeGreaterThan(2)
    // and the day sky is genuinely blue: blue channel well clear of red
    const r = (day.sky >> 16) & 0xff
    const b = day.sky & 0xff
    expect(b - r).toBeGreaterThan(60)
  })

  it('night stays dark — tone mapping must not be allowed to lift it into day', () => {
    const night = skyAt(0.87)
    expect(night.sunIntensity).toBeLessThan(0.5)
    expect(night.ambient).toBeLessThan(0.5)
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

  it('the sun is actually up at the dawn and sunset presets', () => {
    // the whole point of those presets is a low sun — a cosine keyed to the wrong phases
    // once put it 68° underground at dawn, which no other test noticed
    for (const preset of ['dawn', 'day', 'sunset'] as const) {
      const b = skyBodies(TIME_PHASES[preset])
      expect(`${preset}: ${b.sun.elevation > 0}`).toBe(`${preset}: true`)
      expect(`${preset}: ${b.sun.visible}`).toBe(`${preset}: true`)
    }
    // and low at the ends, high in the middle
    const deg = (r: number) => (r * 180) / Math.PI
    expect(deg(skyBodies(TIME_PHASES.dawn).sun.elevation)).toBeLessThan(15)
    expect(deg(skyBodies(TIME_PHASES.sunset).sun.elevation)).toBeLessThan(30)
    // high, but well short of vertical — a near-overhead sun leaves nothing casting a
    // readable shadow, which is the specific flatness this bound exists to prevent
    expect(deg(skyBodies(TIME_PHASES.day).sun.elevation)).toBeGreaterThan(40)
    expect(deg(skyBodies(TIME_PHASES.day).sun.elevation)).toBeLessThan(60)
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
    // dawn shoulder now lives inside the night band's tail
    expect(skyBodies(0.005).starOpacity).toBeGreaterThan(skyBodies(0.015).starOpacity)
    expect(skyBodies(0.02).starOpacity).toBe(0)
  })

  it('the stars are gone by the time the sun is up', () => {
    // a risen sun over a full star field is the specific thing this pins
    for (let p = 0; p < 1; p += 0.005) {
      const b = skyBodies(p)
      if (b.sun.elevation > 0) {
        expect(`${p.toFixed(3)}: ${b.starOpacity}`).toBe(`${p.toFixed(3)}: 0`)
      }
    }
  })
})

describe('cloud tint', () => {
  it('is brighter than the sky while the sun is up', () => {
    // the whole point of the shell: tinted to exactly sky.sky it is invisible by day
    for (const p of [TIME_PHASES.dawn, TIME_PHASES.day, TIME_PHASES.sunset]) {
      const sky = skyAt(p)
      expect(lumOf(cloudColor(sky, p))).toBeGreaterThan(lumOf(sky.sky) + 8)
    }
  })

  it('sinks back into the sky at night', () => {
    // a lit shell after dark doubles the night sky's luminance — the same mistake
    // overcastify() guards against on the weather side
    const sky = skyAt(TIME_PHASES.night)
    expect(cloudColor(sky, TIME_PHASES.night)).toBe(sky.sky)
  })

  it('takes the sun colour, so sunset clouds are warm', () => {
    const sunset = cloudColor(skyAt(TIME_PHASES.sunset), TIME_PHASES.sunset)
    const red = (sunset >> 16) & 0xff
    const blue = sunset & 0xff
    expect(red).toBeGreaterThan(blue)
  })
})
