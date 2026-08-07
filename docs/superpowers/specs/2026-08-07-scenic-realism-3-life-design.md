# Scenic realism slice 3 — life on the track

Date: 2026-08-07
Status: approved, awaiting implementation plan
Parent: `2026-08-07-scenic-realism-0-overview-design.md`
Depends on: slice 1 (tiers, materials, shadows)

## Goal

You are not alone on the track, and you have a body. Three parts: ambient NPC
pacers, a target-pace rabbit tied to the active workout, and your own avatar
(shadow plus arm swing).

Explicitly **not** in scope: replaying past sessions as a ghost. That was
considered and rejected — `statistics.ts` stores session totals, not pace
samples, so a ghost would require new per-session persistence. Revisit as its
own feature if wanted later.

## Design

### `scenicLife.ts`

```ts
export type PacerKind = 'walker' | 'jogger' | 'runner' | 'intervals'

export interface Pacer {
  lane: number // 2..6
  d: number // metres walked along that lane's own line
  speed: number // km/h, instantaneous
  kind: PacerKind
  seed: number
}

export function pacers(t: number, count: number): Pacer[]
export function strideLength(distance: number, steps: number): number
export function stepPhase(distance: number, stride: number): number
export function cadenceHz(speed: number, stride: number): number
export function paceGap(yourDistance: number, rabbitDistance: number): number
```

### Pacers

`pacers(t, count)` is deterministic from elapsed session seconds. Each pacer gets
a fixed lane in 2..6, a base speed and a start offset from `worldHash(seed)`.

The `intervals` kind uses a **closed-form piecewise speed cycle** over a 200 m
period — fast phase, recovery phase — so position is analytic at any `t` with no
accumulated state. This matters: it keeps the function pure, exactly reproducible
across reloads, and testable without simulating time forward.

Position on the loop goes through the existing
`laneDistanceToS(laneMeasurementO(lane), d)`, so pacers run their lane's true
surveyed line and fan correctly through the bends, exactly like the relay and
hurdle marks already do. Nothing new is needed in `scenic.ts`.

**Rendering.** Each pacer is 5 meshes — body and head merged, two arms, two legs
— sharing 3 materials, with limbs rotated by `stepPhase` scaled to that pacer's
speed. Kit colour comes from `seed`.

Counts: **3 on low tier, 8 on high**. Any pacer beyond the current weather's fog
`far` gets `visible = false`, so the live count is typically 3–4 regardless.
Worst case on high tier is about 40 draw calls; the static world is about 10
after the bake, which makes pacers the dominant per-frame cost and the reason
they are the first thing the tier reduces.

**Label.** The nearest pacer within 30 m ahead gets a sprite above it showing
kind and km/h — one sprite total, not one per pacer.

### Rabbit

A single runner holding your **target** pace, in lane 2, in accent green.

Integration lives in `App.vue`, not in `scenicLife.ts`: `App.vue` already owns
workout state, so it accumulates `rabbitDistance` by integrating the active
workout segment's target speed (or, in HR mode, the speed implied by the current
HR target) on the same tick that `treadmill.ts` integrates real distance.
`scenicLife.paceGap` only turns the two distances into a signed gap, which the
component turns into a position and a colour (ahead of you versus behind you).

**Hidden entirely when no workout and no HR target is active.** A rabbit with
nothing to pace against is decoration that implies a goal you don't have. It
resets to your current distance when a workout starts.

### Avatar

**Shadow.** A low-poly body mesh is placed at the camera with
`castShadow = true`. Its geometry sits entirely inside the 0.3 m near plane, so
it is never itself visible — it exists only to throw your shadow onto the track.
On low tier (no shadow map) it is replaced by the shared blob-shadow plane from
slice 1, positioned under the camera.

**Arms.** Two forearm meshes parented to the camera at the bottom corners of the
frustum, swinging on `stepPhase`, the standard first-person viewmodel. They are
in the same phase as the head bob from slice 4, because both read `stepPhase`.

### Cadence is measured, not modelled

`treadmill.ts:146` records `state.steps` from the belt's own pedometer. So the
avatar's cadence does not need a stride model — it can use yours:

```ts
strideLength(distance, steps) // = distance / steps, clamped to [0.4, 1.0] m
```

Clamping guards the degenerate cases: `steps === 0` (pre-#43 device state, a
sensor gap, or demo mode), and absurd ratios early in a session when both
counters are tiny. The fallback is 0.72 m. `stepPhase` then advances with walked
distance, so legs, arms and (in slice 4) head bob all move at your real cadence
and stay locked to the belt rather than to wall-clock time.

## Testing

`scenicLife.test.ts`:

- pacer `d` is monotonically increasing in `t` for every kind
- pacer positions wrap cleanly at 400 m with no discontinuity
- `intervals` pacers hit their exact fast and recovery speeds at cycle boundaries
- `pacers()` is deterministic: same `t` and `count` give deep-equal results
- requested `count` is honoured and lanes stay within 2..6. Eight pacers across
  five lanes means lanes are shared by design; the assertion is that two pacers
  in the same lane are never within 8 m of each other along that lane at t = 0,
  and that same-lane pairs are given different speeds so they separate rather
  than travelling merged
- `strideLength` clamps: `steps === 0` returns the 0.72 m default, absurd inputs
  clamp to `[0.4, 1.0]`
- `stepPhase` is continuous across the lap wrap
- `cadenceHz` rises with speed and falls with stride
- `paceGap` sign convention: positive when the rabbit is ahead

The rabbit's integration lives in `App.vue`, so its behaviour (starts at your
distance, hidden with no workout, resets on workout start) is covered by a case
in `App.hrWorkout.test.ts`, which already drives workout state directly.

## Risks

1. **Draw-call budget.** Pacers dominate. If a real phone struggles at 3 pacers,
   reduce to 2 and merge arms into the body rather than dropping the feature.
2. **Pacers overtaking through the camera.** A faster pacer in lane 2 passing you
   very close can clip the near plane. Keep pacers out of lane 1 entirely
   (already the design: lanes 2..6) and check the lane-2 case at speed.
3. **The rabbit implying a promise.** If the workout target changes mid-segment,
   the rabbit's speed jumps. This is correct — it is showing the target — but
   should be verified to look intentional rather than glitchy.
4. **`strideLength` on the very first steps** of a session gives a wild ratio.
   The clamp handles it, but confirm the legs do not visibly thrash in the first
   few seconds.

## Done when

- Other runners pass you and you pass them, in their own lanes, at plausible
  speeds.
- With a workout active, a green rabbit holds the target pace and you can see
  whether you are ahead of or behind it.
- Your shadow is on the track ahead of you and your arms swing at the bottom of
  the frame, at your real measured cadence.
- With no workout active, there is no rabbit.
- Full CI suite passes.
