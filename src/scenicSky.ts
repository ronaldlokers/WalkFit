// Sky, weather and the day/night cycle for the 3D scenic walk. Split out of scenic.ts
// (which keeps the track geometry and surveyed markings) when the render-quality work
// grew this concern past a comfortable size. Pure and framework-free, like its sibling:
// Scenic3D.vue turns these answers into lights, fog and sky meshes.
import { worldHash } from './scenic'

// --- weather (#72): a per-walk condition, deterministic from a session seed ---
export type WeatherId = 'clear' | 'overcast' | 'mist'
export function weatherFor(seed: number): WeatherId {
  const r = worldHash(Math.floor(seed) % 100000)
  if (r < 0.6) return 'clear'
  if (r < 0.85) return 'overcast'
  return 'mist'
}
// fog band per weather; the component applies these to THREE.Fog near/far
export const WEATHER_FOG: Record<WeatherId, { near: number; far: number }> = {
  clear: { near: 60, far: 230 },
  overcast: { near: 45, far: 190 },
  mist: { near: 15, far: 100 },
}
// how strongly the sky/fog colors pull toward gray, and the light dimming
const WEATHER_GRAY: Record<WeatherId, { mix: number; gray: number; sun: number }> = {
  clear: { mix: 0, gray: 0x9a9da6, sun: 1 },
  overcast: { mix: 0.55, gray: 0x8a8d96, sun: 0.55 },
  mist: { mix: 0.7, gray: 0xb9bcc4, sun: 0.45 },
}

// Fixed times of day for the Settings override (#72); 'auto' follows walked distance.
export type TimeOfDay = 'auto' | 'dawn' | 'day' | 'sunset' | 'night'
export const TIME_PHASES: Record<Exclude<TimeOfDay, 'auto'>, number> = {
  dawn: 0.02,
  day: 0.45,
  sunset: 0.75,
  night: 0.9,
}

// --- day/night from walked distance ---
// Every walk gets its own sky: phase 0 (session start) is dawn; a full cycle takes
// DAY_LENGTH_M, so a typical 2–3 km walk sees dawn → noon → golden hour → dusk.
export const DAY_LENGTH_M = 3200

export function dayPhase(z: number): number {
  return (Math.max(0, z) % DAY_LENGTH_M) / DAY_LENGTH_M
}

export interface SkyState {
  sky: number // upper sky color
  fog: number // horizon / fog color
  sunIntensity: number // directional light
  sunColor: number
  ambient: number // hemisphere intensity
}

interface SkyKey extends SkyState {
  at: number
}
// Keyframes around the cycle; lerped between. Dark-theme friendly: even "noon" stays
// muted so the app chrome around the canvas doesn't clash.
const SKY_KEYS: SkyKey[] = [
  { at: 0.0, sky: 0x3a2f45, fog: 0x6d5468, sunIntensity: 0.7, sunColor: 0xffb08a, ambient: 0.7 }, // dawn
  { at: 0.18, sky: 0x4a6a8a, fog: 0x7a8ea3, sunIntensity: 1.0, sunColor: 0xfff2dd, ambient: 0.9 }, // morning
  { at: 0.45, sky: 0x527099, fog: 0x8298ad, sunIntensity: 1.1, sunColor: 0xffffff, ambient: 1.0 }, // day
  { at: 0.62, sky: 0x4a5c80, fog: 0x8a7f8e, sunIntensity: 0.9, sunColor: 0xffe0b0, ambient: 0.85 }, // late
  { at: 0.75, sky: 0x51345a, fog: 0x8a5c62, sunIntensity: 0.6, sunColor: 0xff9a5c, ambient: 0.6 }, // sunset
  { at: 0.87, sky: 0x1c1f33, fog: 0x2c3046, sunIntensity: 0.2, sunColor: 0x9ab0ff, ambient: 0.35 }, // night
  { at: 1.0, sky: 0x3a2f45, fog: 0x6d5468, sunIntensity: 0.7, sunColor: 0xffb08a, ambient: 0.7 }, // wraps to dawn
]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff
  return (
    (Math.round(lerp(ar, br, t)) << 16) |
    (Math.round(lerp(ag, bg, t)) << 8) |
    Math.round(lerp(ab, bb, t))
  )
}

export function skyAt(phase: number, weather: WeatherId = 'clear'): SkyState {
  let i = 0
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1]!.at <= phase) i++
  const a = SKY_KEYS[i]!
  const b = SKY_KEYS[i + 1]!
  const t = (phase - a.at) / (b.at - a.at)
  const w = WEATHER_GRAY[weather]
  return {
    sky: lerpColor(lerpColor(a.sky, b.sky, t), w.gray, w.mix),
    fog: lerpColor(lerpColor(a.fog, b.fog, t), w.gray, w.mix),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t) * w.sun,
    sunColor: lerpColor(a.sunColor, b.sunColor, t),
    ambient: lerp(a.ambient, b.ambient, t) * (weather === 'clear' ? 1 : 0.85),
  }
}

// Night band (#72): floodlights switch on, path edges matter — shared so the component
// and any future logic agree on what "night" means.
export function isNight(phase: number): boolean {
  return phase >= 0.82 || phase < 0.02
}

// --- sun and moon ---
// The directional light used to sit at a hardcoded (-40, 60, 30) forever, so a dawn sky
// was lit like noon. Elevation follows the same stylised cycle the palette does — this is
// a day cycle over walked distance, not astronomy — and drives long raking shadows at
// dawn and sunset, which is most of what sells the scene as outdoors.

export interface CelestialBody {
  azimuth: number // radians, 0 = +x, increasing toward +z
  elevation: number // radians, negative = below the horizon
  visible: boolean
}
export interface SkyBodies {
  sun: CelestialBody
  moon: CelestialBody
  starOpacity: number
}

export const SUN_PEAK_PHASE = 0.45 // the "day" palette keyframe
export const SUN_SET_PHASE = 0.8 // sun reaches the horizon shortly after the sunset keyframe
const MAX_ELEVATION = Math.PI * 0.42 // just shy of straight overhead
// isNight()'s dawn edge (phase < 0.02). Elevation must stay negative right up to this
// edge — see the p < NIGHT_DAWN_EDGE branch in sunElevation below.
const NIGHT_DAWN_EDGE = 0.02

// Elevation has to agree with the PALETTE, not with an arbitrary cosine. A plain
// cos(p - 0.45) crosses zero at 0.20 and 0.70, which puts the sun 68° underground at the
// dawn keyframe (0.02) and 23° under at sunset (0.75) — the two presets that exist
// precisely to give a low sun. Instead: rise from the horizon at phase 0, peak at the day
// keyframe, return to the horizon at SUN_SET_PHASE, and stay below through the night.
function nightElevation(p: number): number {
  // p spans SUN_SET_PHASE..(1 + NIGHT_DAWN_EDGE) here (the caller wraps the pre-dawn
  // tail by passing p + 1), dipping to a nadir around the middle of the dark stretch.
  return (
    -Math.sin(Math.PI * ((p - SUN_SET_PHASE) / (1 - SUN_SET_PHASE + NIGHT_DAWN_EDGE))) *
    MAX_ELEVATION *
    0.5
  )
}

function sunElevation(p: number): number {
  if (p < NIGHT_DAWN_EDGE) {
    // Still inside the night band (isNight's dawn edge is 0.02). The rise branch below
    // would give a tiny POSITIVE elevation this close to phase 0, which contradicts
    // isNight() saying this is still night — route it through the night curve instead,
    // continuing from before the wrap (p + 1) so it's continuous with the p -> 1 tail.
    return nightElevation(p + 1)
  }
  if (p <= SUN_PEAK_PHASE) return Math.sin((Math.PI / 2) * (p / SUN_PEAK_PHASE)) * MAX_ELEVATION
  if (p <= SUN_SET_PHASE) {
    return (
      Math.sin((Math.PI / 2) * ((SUN_SET_PHASE - p) / (SUN_SET_PHASE - SUN_PEAK_PHASE))) *
      MAX_ELEVATION
    )
  }
  return nightElevation(p)
}

// Stars are fully out through the dark middle of the night, and ramp in/out across a
// shoulder on each side that stays INSIDE the sun's actual below-horizon window: the dusk
// shoulder starts at SUN_SET_PHASE (not the old 0.77, which started fading stars in while
// the sun was still above the horizon — the same defect Fix 3 targets, just on the other
// edge) and the dawn shoulder ends at NIGHT_DAWN_EDGE, so stars are gone by the moment the
// sun crosses the horizon there. Fading them any earlier/later than that leaves stars
// visible over a sun that's still up (or already risen).
function starFade(p: number): number {
  // Below this, treat as exactly 0/1 — the ramps below are float subtractions/divisions
  // of nearby phase values, which can leave a ~1e-14 dust value sitting on the wrong side
  // of zero right at a shoulder boundary. That's invisible on screen but would otherwise
  // break the "stars are exactly 0 once the sun is up" invariant at the boundary itself.
  const EPS = 1e-9
  const clamp = (v: number) => (v < EPS ? 0 : Math.min(1, v))
  // dusk: rise from 0 at sunset (SUN_SET_PHASE) to 1 by the night band's edge (0.82),
  // then clamp holds it at 1 for the rest of the (wrapping) night band
  if (p >= SUN_SET_PHASE) return clamp((p - SUN_SET_PHASE) / (0.82 - SUN_SET_PHASE))
  // dawn: fall from 1 at phase 0 to 0 by NIGHT_DAWN_EDGE, inside the night band's tail
  if (p < NIGHT_DAWN_EDGE) return clamp(1 - p / NIGHT_DAWN_EDGE)
  return 0
}

export function skyBodies(phase: number): SkyBodies {
  const p = ((phase % 1) + 1) % 1
  // one full circuit per cycle; elevation rises from the horizon at phase 0, peaks at
  // SUN_PEAK_PHASE, and returns to the horizon at SUN_SET_PHASE, staying negative
  // through the night band the rest of the way round — see sunElevation above.
  const azimuth = p * Math.PI * 2
  const elevation = sunElevation(p)
  // elevation's zero-crossings sit right at the night band's edges (SUN_SET_PHASE and
  // NIGHT_DAWN_EDGE) by construction, so !isNight(p) rarely flips this on its own — kept
  // as a defensive guard against future retuning of either curve, not dead code.
  const sunUp = elevation > 0 && !isNight(p)
  const starOpacity = starFade(p)
  return {
    sun: { azimuth, elevation, visible: sunUp },
    moon: { azimuth: azimuth + Math.PI, elevation: -elevation, visible: !sunUp },
    starOpacity,
  }
}
