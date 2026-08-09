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
  // Clear air should stay clear: at near 60 / far 230 the far side of the loop and the
  // treeline were already half-dissolved, which reads as permanent haze rather than
  // distance. Mist and overcast keep their close bands — that is their whole character.
  clear: { near: 110, far: 320 },
  overcast: { near: 45, far: 190 },
  mist: { near: 15, far: 100 },
}
// how strongly the sky/fog colors desaturate, and the light dimming
const WEATHER_GRAY: Record<WeatherId, { mix: number; sun: number }> = {
  clear: { mix: 0, sun: 1 },
  overcast: { mix: 0.55, sun: 0.55 },
  mist: { mix: 0.7, sun: 0.45 },
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
// Every walk gets its own sky: a full cycle takes DAY_LENGTH_M, so a typical 2–3 km walk
// sees dawn → noon → golden hour → dusk. Every walk starts just before dawn — the sun
// clears the horizon about 64 m in.
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
// Keyframes around the cycle; lerped between. Authored at real outdoor brightness for
// ACES tone mapping (which compresses the highlights), rather than the muted values the
// old un-tone-mapped renderer needed to avoid clashing with the dark app chrome. That
// clash is now handled where it belongs — the HUD pills carry their own scrim and the
// canvas has a vignette (App.vue) — instead of by dimming the world.
const SKY_KEYS: SkyKey[] = [
  { at: 0.0, sky: 0x54486a, fog: 0xa8788a, sunIntensity: 3.2, sunColor: 0xffb08a, ambient: 1.0 }, // pre-dawn: sun is still below the horizon until phase 0.02
  { at: 0.18, sky: 0x5f95d6, fog: 0xa8c4e0, sunIntensity: 2.3, sunColor: 0xfff2dd, ambient: 1.1 }, // morning
  { at: 0.45, sky: 0x6ba8e8, fog: 0xb9d4ee, sunIntensity: 2.6, sunColor: 0xffffff, ambient: 1.2 }, // day
  { at: 0.62, sky: 0x6b8fc4, fog: 0xc0a9a8, sunIntensity: 2.1, sunColor: 0xffe0b0, ambient: 1.0 }, // late
  { at: 0.75, sky: 0x6d4270, fog: 0xc4707a, sunIntensity: 2.6, sunColor: 0xff9a5c, ambient: 0.55 }, // sunset
  { at: 0.87, sky: 0x161a2e, fog: 0x24283c, sunIntensity: 0.2, sunColor: 0x9ab0ff, ambient: 0.3 }, // night
  { at: 1.0, sky: 0x54486a, fog: 0xa8788a, sunIntensity: 3.2, sunColor: 0xffb08a, ambient: 0.4 }, // wraps to pre-dawn
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

// Weather desaturates the sky toward its OWN luminance rather than toward a fixed gray.
// Mixing toward a constant made a misty night (#8a8d98) come out brighter than a clear
// day (#527099) — weather was adding light instead of removing colour.
function overcastify(base: number, mix: number): number {
  const r = (base >> 16) & 0xff
  const g = (base >> 8) & 0xff
  const b = base & 0xff
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const t = (c: number) => Math.round(c + (lum - c) * mix)
  return (t(r) << 16) | (t(g) << 8) | t(b)
}

export function skyAt(phase: number, weather: WeatherId = 'clear'): SkyState {
  let i = 0
  while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1]!.at <= phase) i++
  const a = SKY_KEYS[i]!
  const b = SKY_KEYS[i + 1]!
  const t = (phase - a.at) / (b.at - a.at)
  const w = WEATHER_GRAY[weather]
  return {
    sky: overcastify(lerpColor(a.sky, b.sky, t), w.mix),
    fog: overcastify(lerpColor(a.fog, b.fog, t), w.mix),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t) * w.sun,
    sunColor: lerpColor(a.sunColor, b.sunColor, t),
    ambient: lerp(a.ambient, b.ambient, t) * (weather === 'clear' ? 1 : 0.85),
  }
}

// Cloud shell tint. Clouds are lit by the same sun the ground is, so by day they read
// BRIGHTER than the sky behind them; after dark they have no light of their own and must
// sink back into the sky, or the shell doubles the night sky's luminance. Tinting the
// shell to exactly `sky` (the first cut) made it invisible in daylight: the same colour
// as its background, with only the texture's alpha to tell the two apart.
// How lit the world is, 0..1, for the unlit backdrops (cloud shell, treeline ring) that
// three.js will not shade for us. Keyed off the sun's ELEVATION, not sunIntensity: the
// pre-dawn keyframe carries a deliberately large sunIntensity (3.2) that the interpolation
// is already ramping toward while the sun is still underground, so an intensity-driven
// factor lights unlit geometry up in the middle of the night.
export function daylight(phase: number): number {
  return Math.max(0, Math.min(1, skyBodies(phase).sun.elevation / 0.08))
}

export function cloudColor(sky: SkyState, phase: number): number {
  const lit = daylight(phase)
  return lerpColor(lerpColor(sky.sky, sky.sunColor, 0.55 * lit), 0xffffff, 0.45 * lit)
}

// How bright flat PAINT should read, 0..1. Painted surfaces (lane lines, markings, signs,
// the fence) are unlit MeshBasic — flat paint needs no shading, and a lit material placed
// 4 cm above the track z-fights against it — but unlit also means nothing dims them, so
// after dark they rendered exactly as bright as at noon. Floors at a non-zero value: a club
// track at night is floodlit, not pitch black.
export function paintLevel(phase: number): number {
  return 0.22 + 0.78 * daylight(phase)
}

// Tint for a camera-following backdrop ring at `haze` (0 = keeps its own colour, 1 = fully
// the horizon colour). MeshBasic backdrops take no light at all, so the daylight factor has
// to do the dimming by hand — without it the treeline stayed a bright daytime green under a
// night sky, lit by nothing.
export function backdropTint(sky: SkyState, phase: number, haze: number): number {
  const t = haze + (1 - haze) * (1 - daylight(phase)) * 0.85
  return lerpColor(0xffffff, sky.fog, Math.min(1, t))
}

// Night band (#72): floodlights switch on, path edges matter — shared so the component
// and any future logic agree on what "night" means.
export function isNight(phase: number): boolean {
  return phase >= NIGHT_DUSK_EDGE || phase < NIGHT_DAWN_EDGE
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
// Deliberately NOT straight overhead. At the old 0.42pi (76 deg) the midday sun cast
// shadows barely a quarter of an object's height, so the whole scene rendered flat and
// unmodelled — nothing on the track had a shadow to sit in. A ~50 deg peak keeps shadows
// roughly as long as the things casting them, which is what gives the ground depth.
const MAX_ELEVATION = Math.PI * 0.28
// isNight()'s dawn edge (phase < 0.02). Elevation must stay negative right up to this
// edge — see the p < NIGHT_DAWN_EDGE branch in sunElevation below.
const NIGHT_DAWN_EDGE = 0.02
// isNight()'s dusk edge (phase >= 0.82) — shared with starFade's dusk-shoulder ramp below,
// which needs the same edge so "stars fully out" lands exactly where "night" starts.
const NIGHT_DUSK_EDGE = 0.82

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
  // dusk: rise from 0 at sunset (SUN_SET_PHASE) to 1 by the night band's edge
  // (NIGHT_DUSK_EDGE), then clamp holds it at 1 for the rest of the (wrapping) night band
  if (p >= SUN_SET_PHASE) return clamp((p - SUN_SET_PHASE) / (NIGHT_DUSK_EDGE - SUN_SET_PHASE))
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
