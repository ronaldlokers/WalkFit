# Scenic realism slice 1 — render quality

Date: 2026-08-07
Status: approved, awaiting implementation plan
Parent: `2026-08-07-scenic-realism-0-overview-design.md`
Depends on: nothing. Build first.

## Goal

The 3D view stops looking like untextured toy blocks. Same geometry, same
world, but lit, textured and tone-mapped like an outdoor scene at a real time of
day. This slice also introduces the quality-tier machinery every later slice
gates on, and performs the module extractions the later slices build against.

## Scope

1. Renderer: ACES tone mapping.
2. Sun position derived from the day cycle, driving light direction and shadows.
3. Shadows: real shadow map on high tier, blob shadows on low.
4. Procedural `CanvasTexture` surfaces for track, grass, bark, foliage, kerb.
5. Sky bodies: sun disc, moon, stars, clouds.
6. Bright palette re-author plus the HUD legibility retune it forces.
7. Quality tiers (`scenicQuality.ts`) and the Settings control.
8. Module extractions: `scenicSky.ts`, `scenicMeshes.ts`.

## Design

### Renderer

```
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
```

`outputColorSpace` is already `SRGBColorSpace` by default in three 0.185 and is
left alone. Because ACES changes how every colour lands, all palette hex values
are re-authored against it rather than converted — see "Palette" below. Nothing
is double-corrected.

### Sun drives the light

Today `sun.position` is hardcoded to `(-40, 60, 30)` and never moves, so a dawn
sky is lit like noon. New in `scenicSky.ts`:

```ts
export interface SkyBodies {
  sun: { azimuth: number; elevation: number; color: number; visible: boolean }
  moon: { azimuth: number; elevation: number; visible: boolean }
  starOpacity: number // 0 by day, ramps in over the isNight() band
}
export function skyBodies(phase: number): SkyBodies
```

The directional light position is placed from `sun.azimuth`/`sun.elevation` at a
fixed radius. Low dawn and sunset elevations produce long raking shadows across
the track; this is the single highest-value change in the slice and is roughly
twenty lines.

Sun elevation follows the existing `dayPhase` keyframes rather than real
astronomy — this is a stylised day cycle over walked distance, not a
planetarium. Elevation peaks at `phase ≈ 0.45` (the existing "day" keyframe) and
goes negative through the `isNight()` band, at which point the moon takes over.

### Shadows

**High tier.** `renderer.shadowMap.enabled = true`, `type = PCFSoftShadowMap`,
`sun.shadow.mapSize = 2048`. The shadow camera is orthographic with a
**fixed-size** box of roughly 120 m re-centred on the camera position each frame.
Fixed size matters: fitting the box to the whole 400 m loop would waste almost
all the map's resolution on geometry behind the walker.

`castShadow` goes on the merged prop meshes and (in later slices) the venue and
pacers. `receiveShadow` goes on the track band, infield and ground.

Interaction with the bake pass: the merge produces one mesh per material, so
shadow flags are set per merged mesh, not per prop. All merged scenery shares
the cast/receive setting, which is correct — everything in the scenery ring both
casts and receives.

**Low tier.** No shadow map at all. Instead a single shared blob-shadow material
(a radial-gradient `CanvasTexture` on a transparent plane) placed under each
prop, pacer and the avatar. It costs one extra material and, after the bake, one
extra draw call for the static blobs. It does not track sun direction, which is
the honest trade: it sells ground contact, not lighting.

### Procedural textures

All generated once at mount as `CanvasTexture`, `RepeatWrapping` on both axes,
`anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())`. Resolution
is 256 px on low tier, 1024 px on high.

| Surface             | Content                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| tartan (track band) | base red, fine granule speckle, faint directional roll marks along the lap            |
| grass (ground)      | green value-noise plus blade streaks                                                  |
| infield             | same generator, different scale and hue, so the two greens read as different surfaces |
| bark (trunks)       | vertical striation                                                                    |
| foliage (crowns)    | leaf-cluster value noise                                                              |
| kerb, concrete      | off-white with panel joints                                                           |

Materials become `MeshStandardMaterial` with a roughness value per surface on
high tier and stay `MeshLambertMaterial` (which also accepts a `map`) on low. A
single factory keeps this from doubling the material table:

```ts
function surface(
  tier: Tier,
  opts: { color: number; map?: Texture; roughness?: number; side?: Side },
): Material
```

#### The bake-pass UV change — the load-bearing detail

`Scenic3D.vue:413` currently does `g.deleteAttribute('uv')` before merging,
because the primitive geometries carry UVs and the hand-built loop ribbons and
cross strips do not. `mergeGeometries` requires matching attribute sets, and
deleting was the cheap way to agree.

Textures invert that requirement. Changes:

- `buildLoopRibbon` and `buildCrossStrip` (moving to `scenicMeshes.ts`) generate
  UVs: `u = s / repeatMetres` along the loop, `v` spanning 0..1 across the width.
  `repeatMetres` is a per-surface constant so the tartan grain tiles at a
  plausible physical scale rather than being stretched around 400 m.
- The bake pass **generates** a zero-filled UV attribute for any geometry still
  missing one, instead of deleting UVs from those that have them.
- Before calling `mergeGeometries`, assert that all geometries in a batch have
  identical attribute name sets, and throw with the offending material name if
  not. Silent garbage from mismatched attributes is the most likely way this
  slice breaks, and it fails visually rather than loudly without the assert.

The UV-generating ribbon builders are extracted as pure functions that return
plain vertex/index/uv arrays, so they are unit-testable without three.js:
`scenicMeshes.ts` exports `ribbonArrays(o0, o1, y, repeatMetres)` and
`stripArrays(...)`, and the three.js wrapper just stuffs them into a
`BufferGeometry`.

### Sky bodies

- **Sun disc**: an additive billboard on the dome with a soft radial glow
  texture, positioned from `skyBodies().sun`. Hidden when elevation is negative.
- **Moon**: same billboard mechanism, a flat pale disc, visible through the
  night band.
- **Stars**: `THREE.Points` with deterministic positions from `worldHash`, 800
  on high tier and 200 on low, material opacity driven by
  `skyBodies().starOpacity` so they fade in and out rather than popping.
- **Clouds** (high tier only): a second transparent dome shell inside the sky
  dome, carrying an fbm-noise `CanvasTexture` with alpha, rotating slowly. One
  draw call, and it does more for "this is a sky" than anything else here.

### Palette and HUD legibility

`SKY_KEYS` is re-authored bright. Reference values agreed for the "day"
keyframe, with the other keyframes moved consistently:

```
day sky   0x527099 -> 0x6ba8e8
day fog   0x8298ad -> 0xb9d4ee
sunIntensity  1.1  -> 2.6   (ACES compresses the highlights)
ambient       1.0  -> 1.2
```

The original palette's stated reason for being muted was that the canvas sits
inside dark app chrome. That constraint is now handled directly instead of by
dimming the world:

- `.imm-*` HUD pill scrim opacity increases in `App.vue`.
- A CSS vignette (top and bottom linear-gradient overlay) is added over the
  canvas so white HUD text keeps contrast against a bright sky.

The muted palette is **not** kept as a selectable option — the user chose the
bright default outright, and a second palette would double the sky test surface
for a preference nobody asked to keep.

### Quality tiers

`scenicQuality.ts` as specified in the overview. The component samples
`performance.now()` deltas for the first 60 rendered frames, calls
`tierFromFrames`, and applies the resolved tier once. Rebuilding textures at a
higher resolution on upgrade is acceptable (it happens within the first two
seconds); shadow map enablement likewise.

Settings → Display gains `Auto / Performance / Quality`, persisted at
`walkfit.scenic.quality`, default `auto`.

### Extractions

- `scenicSky.ts` receives `dayPhase`, `skyAt`, `isNight`, `SKY_KEYS`,
  `TIME_PHASES`, `DAY_LENGTH_M`, the weather table, and the new `skyBodies`.
  Existing sky cases move from `scenic.test.ts` to `scenicSky.test.ts`
  unchanged, which is what makes the move provably behaviour-neutral.
- `scenicMeshes.ts` receives `buildLoopRibbon`, `buildCrossStrip`, `buildProp`,
  the texture factories, `digitTexture` and `signTexture` out of the component.
  `Scenic3D.vue` stays a coordinator: probe, build, bake, animate, dispose.

## Testing

`scenicSky.test.ts`:

- sun elevation rises from dawn to the day keyframe and falls after it
- sun elevation is negative for every phase in the `isNight()` band
- moon is visible exactly when the sun is not
- `starOpacity` is 0 at the day keyframe and 1 at the deepest night keyframe
- palette lerp is continuous across every keyframe boundary (no jump when
  crossing `at`)
- weather still greys the re-authored palette by the same ratios

`scenicQuality.test.ts`:

- `tierFromFrames` returns `high` for fast samples, `low` for slow ones
- it uses the median, so a few slow leading frames (shader compilation) do not
  force `low`
- `resolveTier` honours an explicit `low`/`high` setting over the probe, and
  falls through to the probe on `auto`

`scenicMeshes.test.ts`:

- `ribbonArrays` returns a closed loop (first and last rings coincide)
- UV `u` advances at the requested metres-per-repeat
- vertex and index counts are consistent
- `stripArrays` spans exactly the requested lateral offsets

## Risks

1. **The UV/merge change is the one place a silent corruption can hide.**
   Mitigated by the attribute-set assert and by the pure array builders being
   directly testable.
2. **Bright palette versus HUD legibility** cannot be settled by tests. Needs
   eyes on real hardware, in both day and night phases, with the HUD populated.
3. **`wizard.png` may shift** from the scrim and vignette change. Regenerate once
   in the pinned Playwright container:
   `docker run --rm -v "$PWD":/work -w /work -e CI=1 mcr.microsoft.com/playwright:v1.62.1-noble bash -c "npm ci && npm run e2e:update"`
4. **Tone mapping plus a bright palette can blow out the night phase** — night
   is lit almost entirely by ambient, and ACES will lift it. Check the night
   keyframe explicitly rather than assuming the day tuning carries.

## Done when

- The 3D view is textured, shadowed and tone-mapped on a desktop, and textured
  with blob shadows on a phone.
- Dawn and sunset produce visibly raking shadows across the track.
- Stars fade in at night; clouds drift on high tier.
- HUD text is legible against the brightest sky phase.
- `npm run lint`, `format:check`, `typecheck`, `test`, `build`, the bundle-size
  guard and `npm run e2e` all pass, with `wizard.png` regenerated in-container.
