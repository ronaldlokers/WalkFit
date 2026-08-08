# Scenic motion feel (realism slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first-person 3D scenic walk feel walked rather than flown — head bob, lateral sway, a lean into the bends and a speed-linked field of view — on by default, with a Settings off-switch and an unconditional `prefers-reduced-motion` override.

**Architecture:** Two pure modules do the maths and are unit-tested; the renderer only applies the numbers. `scenic.ts` gains `curvatureAt(s)` (exact, piecewise) and `curvatureEased(s)` (blended across the tangent points, because a real track has no transition spiral and raw curvature snaps). `scenicLife.ts` gains `cameraMotion(...)`, which returns `{dy, dx, roll, fov}` phased off **walked distance** (not wall clock), reusing the `stepPhase`/`gaitCycleM` cadence model slice 3 already established. `Scenic3D.vue` applies the result to the camera each frame; `App.vue` + `SettingsSheet.vue` own the persisted on/off preference.

**Tech Stack:** Vue 3 `<script setup lang="ts">`, three.js (lazy chunk only), Vitest, ESLint + Prettier.

**Source spec:** `docs/superpowers/specs/2026-08-07-scenic-realism-4-motion-design.md`

## Global Constraints

- `scenicLife.ts` and `scenic.ts` must stay **three.js-free**. A three import in either drags three.js out of `Scenic3D.vue`'s lazy chunk into the main bundle and trips CI's 250 kB guard (`scripts/check-bundle-size.mjs`).
- Motion phase comes from **walked distance**, never wall-clock time — deterministic, belt-locked, testable without fake timers. Same choice `dayPhase` and `stepPhase` already make.
- All amplitudes are named exported constants at the top of their module; tests assert against the constants, not magic numbers.
- Amplitudes from the spec, verbatim: vertical bob **3 cm**, lateral sway **1.5 cm**, roll **±1.2°**, FOV **60° at 1 km/h → 66° at 6 km/h** linear and clamped at both ends, `updateProjectionMatrix()` only when the FOV change exceeds **0.05°**.
- New localStorage key: `walkfit.scenic.motion`, values `'on' | 'off'`, default `'on'`.
- `prefers-reduced-motion: reduce` forces motion off regardless of the stored setting.
- Prettier: no semicolons, single quotes, width 100. Extensionless relative imports.
- Never regenerate Playwright baselines outside the pinned container. This change does not touch them (the e2e smoke spec runs the default 2D track view).

## Deviation from the spec — read before Task 1

The spec's test list says `curvatureAt` "flips sign between the two bends". **It does not, and it must not.** An athletics track is walked counterclockwise with the infield on the left, so _both_ bends are left turns; only the bend centres sit on opposite sides in world coordinates. Total turning around the loop is 2π, not 0. A camera that took its roll sign from a flipping curvature would lean _into_ one bend and _out of_ the other — the exact motion-sickness failure the off-switch exists to avoid.

This plan therefore implements the geometrically true version: `curvatureAt` returns `0` on both straights and `+1/BEND_R` on **both** bends, under the documented convention _positive = turning left_. Task 1 includes a test that derives the turn direction numerically from `trackPoint`'s own tangents, so the claim is verified against the geometry rather than asserted. Everything else in the spec is implemented as written.

---

## File Structure

- `src/scenic.ts` — **modify**. Add `BEND_LEN_M`, `curvatureAt`, `CURVATURE_EASE_M`, `curvatureEased`. Pure geometry, no new imports.
- `src/scenic.test.ts` — **modify**. New `describe` blocks for both functions.
- `src/scenicLife.ts` — **modify**. Add the camera-motion constants, the `CameraMotion` interface and `cameraMotion()`. Imports `BEND_R` from `./scenic` (already imports from there).
- `src/scenicLife.test.ts` — **modify**. New `describe('cameraMotion')` block.
- `src/Scenic3D.vue` — **modify**. New `motion?: boolean` prop; camera built at `FOV_BASE_DEG`; `update()` applies bob/sway/roll/FOV.
- `src/App.vue` — **modify**. `scenicMotion` ref + persistence, prop pass-through, `v-model` to Settings.
- `src/SettingsSheet.vue` — **modify**. On/Off row in the Display section.
- `src/i18n.ts` — **modify**. Four new keys in both `en` and `nl`.
- `CLAUDE.md` — **modify**. New localStorage key, the reversed "no bob" comfort note, the two module bullets.

---

### Task 1: Track curvature in the pure world model

**Files:**

- Modify: `src/scenic.ts` (append after `trackPoint`, which ends at line 91)
- Test: `src/scenic.test.ts` (append new describes at the end of the file)

**Interfaces:**

- Consumes: existing `LAP_M`, `STRAIGHT_M`, `BEND_R`, `trackPoint` from `scenic.ts`.
- Produces:
  - `export const BEND_LEN_M: number` — arc length of one bend (`Math.PI * BEND_R`).
  - `export function curvatureAt(s: number): number` — `0` on straights, `+1 / BEND_R` on both bends. Positive = turning left.
  - `export const CURVATURE_EASE_M: number` — blend window width in metres (6).
  - `export function curvatureEased(s: number, ease?: number): number` — same units, smoothstepped across segment boundaries.

- [ ] **Step 1: Write the failing tests**

Append to `src/scenic.test.ts`:

```ts
describe('curvatureAt (slice 4)', () => {
  it('is zero along both straights', () => {
    for (const s of [0, 1, STRAIGHT_M / 2, STRAIGHT_M - 1]) {
      expect(curvatureAt(s)).toBe(0)
    }
    const back = STRAIGHT_M + BEND_LEN_M
    for (const s of [back + 1, back + STRAIGHT_M / 2, back + STRAIGHT_M - 1]) {
      expect(curvatureAt(s)).toBe(0)
    }
  })

  it('is 1/BEND_R through both bends', () => {
    expect(curvatureAt(STRAIGHT_M + BEND_LEN_M / 2)).toBeCloseTo(1 / BEND_R, 9)
    expect(curvatureAt(2 * STRAIGHT_M + 1.5 * BEND_LEN_M)).toBeCloseTo(1 / BEND_R, 9)
  })

  it('gives both bends the SAME sign, because both are left turns', () => {
    // The spec expected the sign to flip. It must not: the track is walked
    // counterclockwise, so the walker never turns right — only the bend CENTRES sit on
    // opposite sides in world coordinates. Derive the turn direction from trackPoint's
    // own tangents rather than trusting the constant.
    const turnSign = (s: number) => {
      const a = trackPoint(s)
      const b = trackPoint(s + 0.01)
      return Math.sign(a.tx * b.tz - a.tz * b.tx)
    }
    const bend1 = STRAIGHT_M + BEND_LEN_M / 2
    const bend2 = 2 * STRAIGHT_M + 1.5 * BEND_LEN_M
    expect(turnSign(bend1)).toBe(turnSign(bend2))
    expect(Math.sign(curvatureAt(bend1))).toBe(Math.sign(curvatureAt(bend2)))
  })

  it('matches the tangent turning rate the geometry actually produces', () => {
    // |dθ/ds| on a bend is 1/R — check the constant against a numeric derivative, so a
    // future geometry change cannot leave curvatureAt quietly stale.
    const s = STRAIGHT_M + BEND_LEN_M / 2
    const a = trackPoint(s)
    const b = trackPoint(s + 0.001)
    const dTheta = Math.abs(Math.atan2(b.tz, b.tx) - Math.atan2(a.tz, a.tx))
    expect(dTheta / 0.001).toBeCloseTo(Math.abs(curvatureAt(s)), 4)
  })

  it('wraps like every other arc parameter', () => {
    expect(curvatureAt(LAP_M + 1)).toBe(curvatureAt(1))
    expect(curvatureAt(-1)).toBe(curvatureAt(LAP_M - 1))
  })
})

describe('curvatureEased (slice 4)', () => {
  it('equals the exact curvature away from the tangent points', () => {
    expect(curvatureEased(STRAIGHT_M / 2)).toBe(0)
    expect(curvatureEased(STRAIGHT_M + BEND_LEN_M / 2)).toBeCloseTo(1 / BEND_R, 9)
  })

  it('has no snap at the straight/bend boundary', () => {
    // a real track has no transition spiral, so raw curvature steps 1/R in one frame —
    // this is the whole reason the eased variant exists
    let maxStep = 0
    let prev = curvatureEased(STRAIGHT_M - 6)
    for (let s = STRAIGHT_M - 6; s <= STRAIGHT_M + 6; s += 0.05) {
      const v = curvatureEased(s)
      maxStep = Math.max(maxStep, Math.abs(v - prev))
      prev = v
    }
    expect(maxStep).toBeLessThan(1 / BEND_R / 20)
  })

  it('has no snap at the finish-line wrap either', () => {
    let maxStep = 0
    let prev = curvatureEased(LAP_M - 6)
    for (let s = LAP_M - 6; s <= LAP_M + 6; s += 0.05) {
      const v = curvatureEased(s)
      maxStep = Math.max(maxStep, Math.abs(v - prev))
      prev = v
    }
    expect(maxStep).toBeLessThan(1 / BEND_R / 20)
  })

  it('stays inside the curvature range it blends between', () => {
    for (let s = 0; s < LAP_M; s += 0.25) {
      const v = curvatureEased(s)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1 / BEND_R + 1e-12)
    }
  })
})
```

Extend the existing import block at the top of `src/scenic.test.ts` with `BEND_LEN_M`, `curvatureAt`, `CURVATURE_EASE_M`, `curvatureEased` (keep `CURVATURE_EASE_M` out if the linter flags it as unused — no test references it directly; prefer not importing it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/scenic.test.ts`
Expected: FAIL — `curvatureAt is not a function` / import errors for the new names.

- [ ] **Step 3: Implement**

Append to `src/scenic.ts`, immediately after `trackPoint` (before the `--- surroundings ---` block):

```ts
// --- curvature (slice 4: camera lean) ---
export const BEND_LEN_M = Math.PI * BEND_R

// Signed curvature of the lane-1 line at arc distance s: 0 on the straights, 1/BEND_R on
// the bends. POSITIVE MEANS TURNING LEFT — and both bends are left turns, because the loop
// is walked counterclockwise with the infield on the left. The bend CENTRES sit on
// opposite sides of the world origin, which makes it tempting to give them opposite signs;
// relative to the direction of travel they curve the same way, and a camera that took its
// roll from a flipping sign would lean out of one bend.
export function curvatureAt(s: number): number {
  const w = ((s % LAP_M) + LAP_M) % LAP_M
  if (w < STRAIGHT_M) return 0
  if (w < STRAIGHT_M + BEND_LEN_M) return 1 / BEND_R
  if (w < 2 * STRAIGHT_M + BEND_LEN_M) return 0
  return 1 / BEND_R
}

// A real track has no transition spiral: curvature steps by a full 1/R at the tangent
// point, and a camera roll driven off curvatureAt alone snaps over in a single frame.
// Blend across the nearest segment boundary instead. Analytic (no state), so it stays as
// deterministic and testable as everything else here.
export const CURVATURE_EASE_M = 6

export function curvatureEased(s: number, ease = CURVATURE_EASE_M): number {
  const w = ((s % LAP_M) + LAP_M) % LAP_M
  // LAP_M is included so the finish-line wrap eases like any other boundary
  const bounds = [0, STRAIGHT_M, STRAIGHT_M + BEND_LEN_M, 2 * STRAIGHT_M + BEND_LEN_M, LAP_M]
  let nearest = Infinity
  let at = 0
  for (const b of bounds) {
    if (Math.abs(w - b) < Math.abs(nearest)) {
      nearest = w - b
      at = b
    }
  }
  if (Math.abs(nearest) >= ease / 2) return curvatureAt(w)
  // every segment is far longer than `ease`, so ±ease lands squarely in the neighbours
  const before = curvatureAt(at - ease)
  const after = curvatureAt(at + ease)
  const u = nearest / ease + 0.5 // 0 at the window's leading edge, 1 at its trailing edge
  return before + (after - before) * (u * u * (3 - 2 * u)) // smoothstep
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/scenic.test.ts`
Expected: PASS, including the pre-existing describes.

- [ ] **Step 5: Commit**

```bash
git add src/scenic.ts src/scenic.test.ts
git commit -m "feat: track curvature in the scenic world model"
```

---

### Task 2: `cameraMotion` in the cadence module

**Files:**

- Modify: `src/scenicLife.ts` (append after `cadenceHz`, before `paceGap`; extend the `./scenic` import with `BEND_R`)
- Test: `src/scenicLife.test.ts` (append at the end)

**Interfaces:**

- Consumes: `stepPhase`, `gaitCycleM` (same module), `BEND_R` from `./scenic`.
- Produces:
  - `export const BOB_M = 0.03`, `SWAY_M = 0.015`, `ROLL_MAX_RAD`, `FOV_BASE_DEG = 60`, `FOV_MAX_DEG = 66`, `FOV_SPEED_LO = 1`, `FOV_SPEED_HI = 6`, `FOV_EPSILON_DEG = 0.05`
  - `export interface CameraMotion { dy: number; dx: number; roll: number; fov: number }`
  - `export function cameraMotion(distance: number, stride: number, speed: number, curvature: number, enabled: boolean): CameraMotion`
  - `dx` is a **lateral offset in the `trackPoint(s, o)` sense** — metres from the lane-1 line, positive outward (i.e. to the walker's right). That is what lets `Scenic3D.vue` apply sway by passing it straight into `trackPoint`.

- [ ] **Step 1: Write the failing tests**

Append to `src/scenicLife.test.ts`:

```ts
describe('cameraMotion (slice 4)', () => {
  const STRIDE = 0.72
  const GAIT = gaitCycleM(STRIDE)

  it('stays within the stated amplitudes for any distance', () => {
    for (let d = 0; d < 20; d += 0.013) {
      const m = cameraMotion(d, STRIDE, 4.5, 0, true)
      expect(Math.abs(m.dy)).toBeLessThanOrEqual(BOB_M + 1e-12)
      expect(Math.abs(m.dx)).toBeLessThanOrEqual(SWAY_M + 1e-12)
    }
  })

  it('bobs twice and sways once per gait cycle', () => {
    // The gait cycle is TWO footfalls (see gaitCycleM). One dip per FOOT means the bob
    // runs at twice the gait frequency and the alternating-feet sway at exactly it.
    // Getting this backwards is the slice-3 2x-cadence bug, which no screenshot can catch.
    const at = (d: number) => cameraMotion(d, STRIDE, 4.5, 0, true)
    expect(at(GAIT).dy).toBeCloseTo(at(0).dy, 9)
    expect(at(GAIT / 2).dy).toBeCloseTo(at(0).dy, 9) // bob repeats every half gait cycle
    expect(at(GAIT).dx).toBeCloseTo(at(0).dx, 9)
    expect(at(GAIT / 2).dx).toBeCloseTo(-at(0).dx, 9) // sway does NOT — it inverts
    // and the sway genuinely swings to both sides within one cycle
    expect(at(GAIT / 4).dx).toBeGreaterThan(0)
    expect(at((3 * GAIT) / 4).dx).toBeLessThan(0)
  })

  it('is continuous across the lap wrap', () => {
    // phase is total walked distance, so 400 m is not special — guard it anyway, because
    // an implementation keyed off trackPoint's wrapped s would jump here
    const a = cameraMotion(399.999, STRIDE, 4.5, 0, true)
    const b = cameraMotion(400.001, STRIDE, 4.5, 0, true)
    expect(Math.abs(b.dy - a.dy)).toBeLessThan(BOB_M / 20)
    expect(Math.abs(b.dx - a.dx)).toBeLessThan(SWAY_M / 20)
  })

  it('leans into a bend and sits level on a straight', () => {
    const straight = cameraMotion(10, STRIDE, 4.5, 0, true)
    const bend = cameraMotion(10, STRIDE, 4.5, 1 / BEND_R, true)
    expect(straight.roll).toBe(0)
    expect(bend.roll).toBeCloseTo(ROLL_MAX_RAD, 9)
    // both of the track's bends are left turns, so both produce the same lean; a
    // right-turning curvature would mirror it
    expect(cameraMotion(10, STRIDE, 4.5, -1 / BEND_R, true).roll).toBeCloseTo(-ROLL_MAX_RAD, 9)
  })

  it('clamps the lean on a curvature tighter than a track bend', () => {
    expect(cameraMotion(10, STRIDE, 4.5, 10 / BEND_R, true).roll).toBeCloseTo(ROLL_MAX_RAD, 9)
  })

  it('widens the view with speed, monotonically and clamped at both ends', () => {
    expect(cameraMotion(0, STRIDE, 0.2, 0, true).fov).toBe(FOV_BASE_DEG)
    expect(cameraMotion(0, STRIDE, FOV_SPEED_LO, 0, true).fov).toBe(FOV_BASE_DEG)
    expect(cameraMotion(0, STRIDE, FOV_SPEED_HI, 0, true).fov).toBe(FOV_MAX_DEG)
    expect(cameraMotion(0, STRIDE, 99, 0, true).fov).toBe(FOV_MAX_DEG)
    let prev = -Infinity
    for (let v = 0; v <= 8; v += 0.1) {
      const fov = cameraMotion(0, STRIDE, v, 0, true).fov
      expect(fov).toBeGreaterThanOrEqual(prev)
      prev = fov
    }
  })

  it('is completely inert when disabled', () => {
    const m = cameraMotion(12.3, STRIDE, 5.5, 1 / BEND_R, false)
    expect(m).toEqual({ dy: 0, dx: 0, roll: 0, fov: FOV_BASE_DEG })
  })

  it('returns a still camera for NaN rather than poisoning the transform', () => {
    // one NaN in camera.position blanks the whole scene until remount
    for (const m of [
      cameraMotion(NaN, STRIDE, 4.5, 0, true),
      cameraMotion(10, NaN, 4.5, 0, true),
      cameraMotion(10, 0, 4.5, 0, true),
      cameraMotion(10, STRIDE, NaN, 0, true),
      cameraMotion(10, STRIDE, 4.5, NaN, true),
    ]) {
      expect(Number.isFinite(m.dy)).toBe(true)
      expect(Number.isFinite(m.dx)).toBe(true)
      expect(Number.isFinite(m.roll)).toBe(true)
      expect(Number.isFinite(m.fov)).toBe(true)
    }
  })
})
```

Extend that file's imports: add `cameraMotion`, `BOB_M`, `SWAY_M`, `ROLL_MAX_RAD`, `FOV_BASE_DEG`, `FOV_MAX_DEG`, `FOV_SPEED_LO`, `FOV_SPEED_HI` to the `./scenicLife` import, and add `import { BEND_R } from './scenic'` (check whether the file already imports from `./scenic` and extend that line instead).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/scenicLife.test.ts`
Expected: FAIL — `cameraMotion is not a function`.

- [ ] **Step 3: Implement**

In `src/scenicLife.ts`, extend the existing import to `import { worldHash, LAP_M, TRACK_IN, LANE_W, BEND_R } from './scenic'`, then append after `cadenceHz` (before `paceGap`):

```ts
// --- camera motion (slice 4) ---
// The camera used to glide on rails, and the component's comments called the fixed horizon
// a comfort choice. It was the right default when there was nothing else to look at; now
// there is. Phase comes from WALKED DISTANCE, not wall clock, so it stays locked to the
// belt, deterministic across reloads, and testable without a fake timer — the same choice
// dayPhase and stepPhase already make.
export const BOB_M = 0.03 // vertical, one dip per footfall
export const SWAY_M = 0.015 // lateral, one full swing per gait cycle (alternating feet)
export const ROLL_MAX_RAD = (1.2 * Math.PI) / 180
export const FOV_BASE_DEG = 60
export const FOV_MAX_DEG = 66
export const FOV_SPEED_LO = 1 // km/h, mirrors the belt's SPEED_MIN
export const FOV_SPEED_HI = 6 // km/h, mirrors the belt's SPEED_MAX
// Below this the projection matrix is not worth rebuilding — nobody can see it.
export const FOV_EPSILON_DEG = 0.05

export interface CameraMotion {
  dy: number // metres, vertical bob
  dx: number // metres, lateral sway — a trackPoint() offset, so positive is outward
  roll: number // radians, positive = head tilted left = leaning into a left-hand bend
  fov: number // degrees
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function cameraMotion(
  distance: number,
  stride: number,
  speed: number,
  curvature: number, // signed 1/R at the current arc position, 0 on the straights
  enabled: boolean,
): CameraMotion {
  // Same reasoning as strideLength: a NaN reaching camera.position blanks the scene, and
  // `stride <= 0` cannot catch NaN because every comparison with NaN is false.
  const still = Number.isFinite(speed) ? speed : 0
  const fov =
    FOV_BASE_DEG +
    (FOV_MAX_DEG - FOV_BASE_DEG) *
      clamp((still - FOV_SPEED_LO) / (FOV_SPEED_HI - FOV_SPEED_LO), 0, 1)
  if (!enabled) return { dy: 0, dx: 0, roll: 0, fov: FOV_BASE_DEG }
  if (!Number.isFinite(distance) || !Number.isFinite(stride) || stride <= 0) {
    return { dy: 0, dx: 0, roll: 0, fov }
  }
  // One gait cycle = two footfalls (see gaitCycleM), so the once-per-foot bob runs at
  // TWICE this frequency and the alternating-feet sway at exactly it. Swap those and every
  // motion doubles — the slice-3 bug that survived eight review rounds, because a
  // screenshot cannot show frequency.
  const gait = stepPhase(distance, gaitCycleM(stride)) * Math.PI * 2
  const dy = -BOB_M * Math.cos(2 * gait) // lowest at the footfall, highest mid-step
  const dx = SWAY_M * Math.sin(gait)
  const lean = Number.isFinite(curvature) ? clamp(curvature * BEND_R, -1, 1) : 0
  return { dy, dx, roll: ROLL_MAX_RAD * lean, fov }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/scenicLife.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scenicLife.ts src/scenicLife.test.ts
git commit -m "feat: camera motion model for the scenic walk"
```

---

### Task 3: Apply the motion to the camera

**Files:**

- Modify: `src/Scenic3D.vue` — imports (lines 12–34), `defineProps` (lines 85–93), camera construction (line 137), the `reducedMotion` declaration (line 1242), and `update()` (lines 1029–1042)

**Interfaces:**

- Consumes: `cameraMotion`, `FOV_BASE_DEG`, `FOV_EPSILON_DEG` from `./scenicLife`; `curvatureEased` from `./scenic` (both from Tasks 1–2).
- Produces: a new optional prop `motion?: boolean` (omitted = on), consumed by `App.vue` in Task 4. Deliberately a `boolean` rather than a `'on' | 'off'` string union, so `App.vue` needs no `as never` cast — the existing casts on `:time-of-day` and `:quality` are a recorded follow-up, not a pattern to copy.

There is no unit test for this task: `Scenic3D.vue` cannot be tested in jsdom (no WebGL), which is exactly why the maths lives in the two pure modules. Verification is typecheck + build + a manual run.

- [ ] **Step 1: Extend the imports**

In the `./scenic` import block, add `curvatureEased` to the named imports. In the `./scenicLife` import line, change it to:

```ts
import {
  pacers,
  stepPhase,
  strideLength,
  gaitCycleM,
  cameraMotion,
  FOV_BASE_DEG,
  FOV_EPSILON_DEG,
} from './scenicLife'
```

- [ ] **Step 2: Add the prop and use the constant for the camera's base FOV**

In `defineProps`, add after `rabbitDistance`:

```ts
  motion?: boolean // head bob / sway / bend lean (#realism slice 4); omitted = on
```

and change the camera construction (line 137) from the literal `60` to the shared constant:

```ts
const camera = new THREE.PerspectiveCamera(FOV_BASE_DEG, 1, 0.3, CAMERA_FAR)
```

- [ ] **Step 3: Move the reduced-motion probe above `update()`**

`update()` is about to read `reducedMotion`, which is currently declared ~200 lines below it (line 1242). It resolves at call time today, but a closure reading a `const` declared after it is a temporal-dead-zone trap waiting for the next reorder. Cut this line:

```ts
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
```

from just above `let last = performance.now()`, and paste it into the `// --- camera + sky per frame ---` block, immediately above `let display = props.distance`.

- [ ] **Step 4: Apply the motion in `update()`**

Replace the opening of `update()` — from `const p = trackPoint(d)` through `armR.rotation.x = -bodySwing` — with:

```ts
// Measured, not modelled: state.steps is the belt's own pedometer, so the arms swing
// at your real cadence rather than an assumed one — and the camera bobs at it too.
const stride = strideLength(props.distance, props.steps ?? 0)
// prefers-reduced-motion overrides the setting unconditionally: that path renders
// discretely per distance tick with no rAF loop, so a bob there is a jolt, not motion.
const motion = cameraMotion(
  d,
  stride,
  props.speed,
  curvatureEased(d),
  (props.motion ?? true) && !reducedMotion,
)
// Sway is a lateral offset in the world model's own terms, so it goes straight through
// trackPoint — and through the look-at point too, or swaying would yaw the view.
const p = trackPoint(d, motion.dx)
camera.position.set(p.x, EYE_HEIGHT + motion.dy, p.z)
const ahead = trackPoint(d + 10, motion.dx)
// The bob shifts the look-at target by the same dy: a pure vertical translation, which
// keeps the horizon where it is instead of pitching the camera at it.
camera.lookAt(ahead.x, EYE_HEIGHT + motion.dy - 0.2, ahead.z)
const bodyPhase = stepPhase(d, gaitCycleM(stride)) * Math.PI * 2
const bodySwing = Math.sin(bodyPhase) * 0.55
avatarBody.position.set(camera.position.x, 0, camera.position.z)
// Read the yaw BEFORE the roll below: rotateZ mixes into the XYZ euler decomposition,
// so camera.rotation.y stops being the heading the moment the camera is rolled.
avatarBody.rotation.y = camera.rotation.y
// rotateZ is applied AFTER lookAt every frame, and lookAt rebuilds the quaternion from
// scratch, so the roll replaces itself each frame rather than accumulating.
if (motion.roll !== 0) camera.rotateZ(motion.roll)
if (Math.abs(camera.fov - motion.fov) > FOV_EPSILON_DEG) {
  camera.fov = motion.fov
  camera.updateProjectionMatrix()
}
armL.rotation.x = bodySwing
armR.rotation.x = -bodySwing
```

- [ ] **Step 5: Typecheck, lint, and build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass. The build must still print a main chunk under 250 kB — three.js stays in the lazy `Scenic3D` chunk (the new imports are from the two pure modules).

Run: `node scripts/check-bundle-size.mjs`
Expected: PASS.

- [ ] **Step 6: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS — no test drives this component, but `App.happy.test.ts` mounts the app and must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/Scenic3D.vue
git commit -m "feat: bob, sway, bend lean and speed-linked FOV on the scenic camera"
```

---

### Task 4: Settings toggle, persistence and docs

**Files:**

- Modify: `src/App.vue` (state near line 475; `<Scenic3D>` at line 1409; `<SettingsSheet>` at line 1837)
- Modify: `src/SettingsSheet.vue` (`defineModel` block near line 88; Display section near line 315)
- Modify: `src/i18n.ts` (en table near line 216, nl table near line 472)
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: `Scenic3D`'s `motion?: boolean` prop from Task 3.
- Produces: `scenicMotion: Ref<boolean>` in `App.vue`, persisted to `walkfit.scenic.motion` as `'on' | 'off'`; `scenicMotion` model on `SettingsSheet`.

- [ ] **Step 1: Add the persisted state in `App.vue`**

Directly below the `scenicQuality` pair (line 475-476):

```ts
// Head bob/sway/lean in the 3D view (#realism slice 4). Stored as on/off rather than a
// bare boolean so the key reads the same as every other scenic preference; the component
// takes a boolean, which is why this needs no `as never` cast on the way through.
const scenicMotion = ref(localStorage.getItem('walkfit.scenic.motion') !== 'off')
watch(scenicMotion, (v) => localStorage.setItem('walkfit.scenic.motion', v ? 'on' : 'off'))
```

- [ ] **Step 2: Pass it through both components**

On `<Scenic3D>`, after `:rabbit-distance="rabbitDistance"`:

```html
:motion="scenicMotion"
```

On `<SettingsSheet>`, after `v-model:scenic-quality="scenicQuality"`:

```html
v-model:scenic-motion="scenicMotion"
```

- [ ] **Step 3: Add the control in `SettingsSheet.vue`**

Next to the other scenic models (line 89):

```ts
const scenicMotion = defineModel<boolean>('scenicMotion', { required: true })
```

and after the quality `set-row` in the `display` section:

```html
<div class="set-row">
  <span>{{ t('settings.motion') }}</span>
  <div class="set-actions">
    <button :class="scenicMotion ? 'btn primary sm' : 'btn ghost sm'" @click="scenicMotion = true">
      {{ t('settings.motionOn') }}
    </button>
    <button :class="scenicMotion ? 'btn ghost sm' : 'btn primary sm'" @click="scenicMotion = false">
      {{ t('settings.motionOff') }}
    </button>
  </div>
</div>
<p class="set-note">{{ t('settings.motionNote') }}</p>
```

- [ ] **Step 4: Add the four keys to both locale tables**

In `src/i18n.ts`, after `'settings.qualityHigh': 'Quality',` in the `en` table:

```ts
  'settings.motion': '3D head motion',
  'settings.motionOn': 'On',
  'settings.motionOff': 'Off',
  'settings.motionNote':
    'Head bob, sway and a lean into the bends. Always off when your system asks for reduced motion.',
```

and after `'settings.qualityHigh': 'Kwaliteit',` in the `nl` table:

```ts
  'settings.motion': '3D-hoofdbeweging',
  'settings.motionOn': 'Aan',
  'settings.motionOff': 'Uit',
  'settings.motionNote':
    'Hoofdbeweging, zijwaartse zwaai en overhellen in de bochten. Altijd uit als je systeem om minder beweging vraagt.',
```

The `nl` table is typed `Record<MessageKey, string>`, so a missed key is a compile error — `npm run typecheck` is the check here.

- [ ] **Step 5: Update `CLAUDE.md`**

Four edits:

1. In the `localStorage` key list, after `` `walkfit.scenic.quality` (`auto` | `low` | `high`, 3D quality override), `` add:
   `` `walkfit.scenic.motion` (`on` | `off`, 3D head bob/sway/lean — on by default, and `prefers-reduced-motion` overrides it), ``
2. In the scenic paragraph, replace `Comfort: fixed horizon, no bob;` with:
   `Comfort: the camera bobs, sways and leans into the bends off walked distance (`cameraMotion`in scenicLife.ts,`curvatureEased` in scenic.ts) — reversing the original fixed-horizon choice now that there is something to look at. Settings → Display turns it off, and`
   so the sentence continues `` `prefers-reduced-motion` renders discretely per distance tick instead of a continuous rAF loop `` — then append to that sentence: `and forces the motion off regardless of the setting, because a bob applied per discrete tick is a jolt.`
3. In the `src/scenicLife.ts` bullet, add to the list of what it exports: `` `cameraMotion` (bob/sway/roll/FOV, phased off walked distance, sharing the same `gaitCycleM` cadence the limbs use — the bob is twice the gait frequency, the sway exactly it) ``.
4. In the `src/scenic.ts` mention (the Scenic (3D) paragraph), note that it also exports `` `curvatureAt`/`curvatureEased` — 0 on the straights and `+1/BEND_R` on BOTH bends, since a counterclockwise loop turns left twice and never right ``.

- [ ] **Step 6: Format, lint, typecheck, test**

Run: `npm run format && npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/App.vue src/SettingsSheet.vue src/i18n.ts CLAUDE.md
git commit -m "feat: scenic motion setting in Settings, persisted and documented"
```

---

### Task 5: Full verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run the full CI suite in order**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && node scripts/check-bundle-size.mjs
```

Expected: every step passes. Paste the real output into the task report — no "should pass".

Do **not** run `npm run e2e` on the host: the baselines are container-generated and host fonts differ. The E2E workflow covers it in CI, and this change cannot move the baseline anyway — the smoke spec runs the default 2D track view.

- [ ] **Step 2: Manual check in demo mode**

```bash
npm run dev
```

Open `http://localhost:5173/?demo`, switch the visual to 3D, and start a walk. Confirm, against the spec's three named risks:

1. **Amplitude over time** — walk at least a full lap, not a ten-second look. Nausea builds; if it reads as too much, retune `BOB_M` / `SWAY_M` / `ROLL_MAX_RAD` (one-line changes by design) and re-run Task 2's tests, which assert against the constants rather than literals.
2. **Arms and shadow vs the bob** — the forearms are parented to the camera and the shadow body is not, but both read the same `stepPhase`. Watch that the arms do not appear to float free of the body's shadow as the view dips.
3. **Roll vs the sky dome** — the dome follows the camera's position but not its rotation. Confirm the ±1.2° lean does not visibly shear the horizon line on the bends.

Also confirm:

- the lean happens on **both** bends and in the **same** direction (into the turn, infield side);
- speeding the belt from 1 to 6 km/h visibly widens the view;
- Settings → Display → 3D head motion → Off stops all four effects immediately, with no remount;
- the setting survives a reload.

- [ ] **Step 3: Verify the reduced-motion override**

In Chrome DevTools: ⋮ → More tools → Rendering → "Emulate CSS media feature prefers-reduced-motion" → `reduce`, then reload with the 3D view open and the setting left **On**. Expected: no bob, no sway, no lean, FOV pinned at 60 — the camera renders discretely per distance tick exactly as before this slice.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/scenic-motion
gh pr create --title "feat: motion feel on the scenic walk — head bob, sway, bend lean, speed-linked FOV" --body "..."
```

The PR body should record, for the next reader: the spec deviation on curvature sign (both bends turn left), and any amplitude retuning done in Step 2.

---

## Notes for the implementer

- Branch first — `feat/scenic-motion`, never commit to `main`.
- Known adjacent follow-ups from earlier slices that this plan deliberately does **not** fix: the Display section shows the 3D controls even when WebGL is unavailable (the new motion row inherits that), and `App.vue`'s `as never` casts on `:time-of-day` / `:quality`. Both are recorded in issue #205; the new prop avoids adding a third cast.
