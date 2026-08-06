# Scenic realism overview — "make the 3D view feel like Zwift"

Date: 2026-08-07
Status: approved, awaiting implementation plans

## Problem

The 3D scenic walk (`src/scenic.ts`, `src/Scenic3D.vue`, #51) is geometrically
accurate — a surveyed 400 m athletics track with correct staggers, relay zones,
hurdle marks and a waterfall start — but it does not look or feel like a place.
Four distinct gaps, all confirmed with the user:

1. **Render quality.** Flat-shaded `MeshLambertMaterial` primitives, solid
   colours, no textures, no shadows, no tone mapping. Reads as untextured blocks.
2. **Empty world.** A red ring, a green infield and 48 scattered props. No
   venue, no horizon, nothing built.
3. **Alone.** A disembodied camera on an empty track. No other people, no
   avatar, no shadow of your own.
4. **Dead motion.** The camera glides on rails at fixed height with a fixed
   60° FOV.

## Decisions taken during brainstorming

- **All four gaps are in scope**, but as four separate specs and PRs, not one
  mega-change.
- **Quality tiers are adaptive**: a frame-time probe picks a tier, with a manual
  override in Settings. The app must stay usable on a phone propped on the
  treadmill _and_ look good on a desktop.
- **No ghost-of-past-walks feature.** Considered and rejected: it would require
  adding per-session pace sampling to `statistics.ts`. The company on the track
  is ambient NPC pacers plus a target-pace rabbit.
- **Bright, realistic sky palette wins** over the current deliberately-muted
  one. `SKY_KEYS` gets re-authored and the HUD chrome is re-tuned to survive it.
- **Club track, not a stadium bowl.** One grandstand on the home straight. A
  closed bowl would occlude the sky cycle and hide the existing scenery ring.
- **Head bob ships on by default** with a Settings off-switch, at full
  amplitude rather than a timid version. `prefers-reduced-motion` still forces
  it off.

## Slices

| #   | Slice                                | Spec                           | Depends on             |
| --- | ------------------------------------ | ------------------------------ | ---------------------- |
| 1   | Render quality (incl. quality tiers) | `…-1-render-quality-design.md` | —                      |
| 2   | Club track venue                     | `…-2-venue-design.md`          | 1                      |
| 3   | Life on the track                    | `…-3-life-design.md`           | 1                      |
| 4   | Motion feel                          | `…-4-motion-design.md`         | 3 (shares `stepPhase`) |

Recommended build order **1 → 3 → 2 → 4**. Slice 1 first because tone mapping,
textures and sun-driven shadows are the biggest perceived jump per line of code,
and because slice 1 defines the material and texture vocabulary that slices 2
and 3 build against. Slice 3 before slice 2 because an empty grandstand looks
worse than no grandstand. Slice 4 last: smallest, and the most likely to be
re-tuned or reverted after real use.

## Shared architecture rules

These apply to every slice and are the reason the work is safe to split.

### The purity boundary stays, and hardens

`Scenic3D.vue` has no unit tests and cannot get any — jsdom has no WebGL, so the
component's only tested behaviour is that it emits `unsupported`. Therefore
**every new decision goes into a pure module with its own test file**, and the
component only turns answers into meshes. This is the existing `scenic.ts`
contract, extended.

`scenic.ts` is 377 lines today and would roughly double. Split by concern:

| Module             | Owns                                                                                                                | Test file                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `scenic.ts`        | track geometry + surveyed markings (its current core), `surroundings()`                                             | `scenic.test.ts` (exists)                    |
| `scenicSky.ts`     | day cycle, weather, palette, `skyBodies()`                                                                          | `scenicSky.test.ts`                          |
| `scenicVenue.ts`   | `stadium()` — grandstand, fence, clubhouse, infield furniture, skyline                                              | `scenicVenue.test.ts`                        |
| `scenicLife.ts`    | pacers, rabbit gap, stride/cadence, `stepPhase`                                                                     | `scenicLife.test.ts`                         |
| `scenicQuality.ts` | frame-time probe, tier selection, settings override                                                                 | `scenicQuality.test.ts`                      |
| `scenicMeshes.ts`  | three.js mesh/texture builders extracted from the component, plus the pure vertex/index/uv array builders they wrap | `scenicMeshes.test.ts` (array builders only) |

Slice 1 performs the `scenicSky.ts` and `scenicMeshes.ts` extractions. Moving
the day-cycle exports is a pure move — `Scenic3D.vue` and any other importer
update their import paths, no behaviour change, and `scenic.test.ts`'s sky cases
move to `scenicSky.test.ts` unchanged so the move is provably behaviour-neutral.

### Quality tiers

`scenicQuality.ts` exposes:

```ts
export type Tier = 'low' | 'high'
export type QualitySetting = 'auto' | 'low' | 'high'
export function tierFromFrames(frameMs: number[]): Tier
export function resolveTier(setting: QualitySetting, probed: Tier): Tier
```

`tierFromFrames` takes frame times sampled over the first 60 rendered frames and
returns a tier from the median (not the mean — the first frames include shader
compilation spikes). The component starts on `low`, probes, and upgrades once if
the probe says so; it never downgrades mid-session, because a tier flip
mid-walk is more jarring than a slightly low frame rate.

Settings → Display gains a three-way control (`Auto` / `Performance` /
`Quality`) persisted at `walkfit.scenic.quality`, default `auto`.

What the tier gates:

| Feature            | low                | high                     |
| ------------------ | ------------------ | ------------------------ |
| Shadows            | blob-shadow planes | 2048 PCF soft shadow map |
| Texture resolution | 256 px             | 1024 px                  |
| Pacers             | 3                  | 8                        |
| Stars              | 200                | 800                      |
| Cloud layer        | off                | on                       |

Static venue geometry is **not** gated. After the existing merge-by-material
bake it costs about three extra draw calls, which is not where the budget goes.

### Performance discipline

The existing bake pass (`Scenic3D.vue`, "static world, built once") merges every
static mesh by material. All new static geometry funnels through it unchanged.
The only live per-frame meshes are pacers, the rabbit, the avatar arms, and the
sky bodies.

Draw-call budget: the static world is roughly 10 draws after the bake. Pacers
are 5 meshes each and are the dominant cost — worst case about 40 draws on high
tier with all 8 visible, in practice 3–4 are within fog range. If real hardware
struggles, the tier drops pacer count first and shadows second.

### Bundle

Zero new dependencies. Every texture is a runtime `CanvasTexture`; no external
assets, so the offline PWA precache is unaffected. Tone mapping is built into
`WebGLRenderer` — no `EffectComposer`, no post-processing chain, deliberately.
`three/addons/utils/BufferGeometryUtils.js` is already imported; no other addon
is needed. The main chunk stays three-free and the 250 kB
`scripts/check-bundle-size.mjs` guard is unaffected.

### Tests and e2e

`e2e/views.spec.ts` asserts that scenic either mounts or falls back, which is
WebGL-agnostic and unaffected by any of this. The only real screenshot baseline
is `wizard.png` (`e2e/smoke.spec.ts:7`), which slice 1's HUD scrim and vignette
retune may shift. It is regenerated once, in slice 1, in the pinned
`mcr.microsoft.com/playwright:v1.61.1-noble` container per CLAUDE.md.

## Out of scope

- Multiplayer or any network feature.
- Routes other than the 400 m loop (no roads, no elevation, no world-switching).
- Ghost replay of past sessions.
- Third-person camera. The view stays first-person.
- Post-processing (bloom, SSAO, SMAA).
