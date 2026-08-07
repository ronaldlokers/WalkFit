# Scenic realism slice 4 — motion feel

Date: 2026-08-07
Status: approved, awaiting implementation plan
Parent: `2026-08-07-scenic-realism-0-overview-design.md`
Depends on: nothing strictly; shares `stepPhase` with slice 3, so build it after
slice 3 to avoid defining cadence twice.

## Goal

The camera stops gliding on rails. Head bob, lateral sway, a lean into the
bends, and a speed-linked field of view — the difference between watching a
flythrough and walking.

This deliberately reverses a documented decision. `Scenic3D.vue`'s comments call
the fixed horizon a comfort choice, and it was the right default before there
was anything else to look at. It ships **on by default** now, at full amplitude
rather than a timid version, with a Settings off-switch — and
`prefers-reduced-motion` still overrides it unconditionally.

## Design

In `scenicLife.ts` (alongside `stepPhase`, which it shares):

```ts
export interface CameraMotion {
  dy: number // metres, vertical bob
  dx: number // metres, lateral sway
  roll: number // radians
  fov: number // degrees
}
export function cameraMotion(
  distance: number,
  stride: number,
  speed: number,
  curvature: number, // signed 1/R at the current arc position, 0 on the straights
  enabled: boolean,
): CameraMotion
```

Phase comes from **walked distance**, not wall-clock time. That keeps it locked
to the belt, deterministic, and testable without a fake timer — the same choice
`dayPhase` already makes.

Amplitudes:

- **vertical bob**: 3 cm, at 2× step cadence (one dip per foot)
- **lateral sway**: 1.5 cm, at 1× step cadence (alternating feet)
- **roll**: ±1.2° into the bend, sign taken from the curvature at the current
  arc position, zero on the straights, eased across the transition so there is
  no snap at the straight/bend boundary
- **FOV**: 60° at 1 km/h rising to 66° at 6 km/h, linear, clamped at both ends

`camera.updateProjectionMatrix()` is called only when the FOV change exceeds
0.05°, so it is not rebuilding the projection matrix every frame for a change
nobody can see.

`curvature` is a new tiny export from `scenic.ts`: `curvatureAt(s)` returns
`0` on the straights and `±1 / BEND_R` on the bends, sign by bend direction. It
falls straight out of the existing `trackPoint` piecewise structure.

All amplitudes live as named constants at the top of the module so re-tuning
after real use is a one-line change, and so the tests assert against the
constants rather than magic numbers.

### Settings and reduced motion

New key `walkfit.scenic.motion`, `'on' | 'off'`, default `'on'`, exposed in
Settings → Display next to the 2D/3D and quality controls.

`prefers-reduced-motion: reduce` forces `enabled = false` regardless of the
stored setting. That path already renders discretely per distance tick rather
than running a rAF loop, so a bob there would be a per-tick jolt — strictly
worse than nothing.

## Testing

In `scenicLife.test.ts`:

- `dy` and `dx` stay within their stated amplitude bounds for all inputs
- both are continuous across the lap wrap (no jump at 400 m)
- vertical bob completes two cycles per step, lateral sway one
- `fov` is monotonically non-decreasing in speed and clamped at 60 and 66
- `roll` sign matches the bend direction on both bends and is exactly 0 on both
  straights
- every field is exactly 0 (and `fov` is the 60° base) when `enabled` is false

In `scenic.test.ts`:

- `curvatureAt` is 0 across both straights, `±1/BEND_R` mid-bend, and flips sign
  between the two bends

## Risks

1. **Motion sickness.** This is the whole reason the original code avoided it.
   The off-switch is the mitigation, but the amplitudes should be checked over a
   full-length walk, not a ten-second look — nausea builds.
2. **Bob interacting with the shadow and arms from slice 3.** They read the same
   `stepPhase`, so they will be in phase, but verify the arms do not appear to
   float when the camera dips.
3. **Roll plus a fixed horizon sky dome.** The dome follows the camera position
   but not its rotation, which is correct; confirm the roll does not shear the
   horizon line visibly.

## Done when

- Walking feels like walking: the view dips with each step and leans into the
  bends, and speeding up widens the view.
- The Settings toggle turns it fully off.
- With `prefers-reduced-motion`, it never engages regardless of the setting.
- Full CI suite passes.
