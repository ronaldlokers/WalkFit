# Scenic Life on the Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put people on WalkFit's 3D track — ambient NPC pacers you overtake and get overtaken by, a target-pace rabbit while a workout runs, and your own body casting a shadow with arms swinging at your real measured cadence.

**Architecture:** All decisions live in a new pure module `src/scenicLife.ts` with unit tests; `Scenic3D.vue` only turns answers into three.js objects, because it can never be unit-tested (jsdom has no WebGL). Pacer positions are analytic functions of elapsed time — no accumulated state — so they are deterministic across reloads and testable without simulating time forward. The rabbit's distance is integrated in `App.vue`, the one place that already owns workout state.

**Tech Stack:** Vue 3 `<script setup lang="ts">`, TypeScript strict, three.js 0.185 (already the sole runtime dependency), Vitest.

## Global Constraints

- **No new dependencies.** Pacer bodies are generated geometry; any texture is a runtime `CanvasTexture`. No asset files, so the offline PWA precache is unaffected.
- **Bundle guard:** `scripts/check-bundle-size.mjs` fails if the main chunk exceeds 250 kB. three.js must stay in the lazy `Scenic3D` chunk — never add a static import of `three`, or of any module importing it, into `App.vue` or anything `App.vue` imports eagerly. **`src/scenicLife.ts` must stay three-free** so `App.vue` can import from it directly.
- **Prettier:** no semicolons, single quotes, print width 100. Run `npm run format` before every commit.
- **Imports are extensionless and relative** (`from './scenic'`).
- **TypeScript strict.** No `any`.
- **Commit style:** conventional commits, lowercase imperative subject.
- **Never commit to `main`.**
- **Every commit must pass** `npm run lint && npm run format:check && npm run typecheck && npm test`.
- **Spec:** `docs/superpowers/specs/2026-08-07-scenic-realism-3-life-design.md`.
- Baseline at the start of this plan: **225 tests**.

## Deviation from the spec, decided up front

The spec says the rabbit is driven by "the active workout segment's target speed (or, in HR mode, the speed implied by the current HR target)". **The rabbit is implemented for weight-loss plans only; HR mode gets no rabbit.**

Reason: an HR target defines a heart rate band, not a pace. The only speed available in HR mode is `state.targetSpeed`, which is whatever the HR steering last commanded — so the rabbit would track the belt's own commanded speed and sit at a near-zero gap forever, telling the walker nothing. A rabbit that is always exactly level is worse than no rabbit. Everything else in the spec is implemented as written.

## File Structure

| File                        | Status | Responsibility                                                                       |
| --------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `src/scenicLife.ts`         | create | Pure: pacer positions, stride/cadence, step phase, pace gap. **No three.js import.** |
| `src/scenicLife.test.ts`    | create | Tests for the above.                                                                 |
| `src/scenicMeshes.ts`       | modify | Add the pacer body-part geometry factory.                                            |
| `src/Scenic3D.vue`          | modify | Build and animate pacers, rabbit and avatar.                                         |
| `src/App.vue`               | modify | Integrate `rabbitDistance`; pass it plus `steps` to `Scenic3D`.                      |
| `src/App.hrWorkout.test.ts` | modify | Cover the rabbit's integration and reset.                                            |
| `CLAUDE.md`                 | modify | Record the new module and its invariants.                                            |

---

### Task 1: Pacer positions (`scenicLife.ts`)

**Files:**

- Create: `src/scenicLife.ts`
- Create: `src/scenicLife.test.ts`

**Interfaces:**

- Consumes: `worldHash`, `LAP_M` from `./scenic`.
- Produces: `type PacerKind = 'walker' | 'jogger' | 'runner' | 'intervals'`; `interface Pacer { lane: number; d: number; speed: number; kind: PacerKind; seed: number }`; `pacers(t: number, count: number): Pacer[]`; `PACER_LANES` (the lanes pacers may use); `INTERVAL_PERIOD_M`, `INTERVAL_FAST_KMH`, `INTERVAL_SLOW_KMH`.

- [ ] **Step 1: Write the failing test**

Create `src/scenicLife.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  pacers,
  PACER_LANES,
  INTERVAL_PERIOD_M,
  INTERVAL_FAST_KMH,
  INTERVAL_SLOW_KMH,
} from './scenicLife'

const LAP = 400 // scenic.ts LAP_M, restated so the test does not depend on the module it checks

describe('pacers', () => {
  it('is deterministic: same inputs give deep-equal results', () => {
    expect(pacers(37.5, 8)).toEqual(pacers(37.5, 8))
  })

  it('honours the requested count and keeps every lane in the allowed set', () => {
    for (const n of [0, 1, 3, 8]) {
      const list = pacers(12, n)
      expect(list).toHaveLength(n)
      for (const p of list) expect(PACER_LANES).toContain(p.lane)
    }
  })

  it('every pacer advances as time moves forward', () => {
    const a = pacers(0, 8)
    const b = pacers(30, 8)
    a.forEach((p, i) => expect(b[i]!.d).toBeGreaterThan(p.d))
  })

  it('distance advances at the pacer own speed over a short window', () => {
    const dt = 10
    const a = pacers(100, 8)
    const b = pacers(100 + dt, 8)
    a.forEach((p, i) => {
      if (p.kind === 'intervals') return // its speed varies within the window
      const expected = ((p.speed * 1000) / 3600) * dt
      expect(b[i]!.d - p.d).toBeCloseTo(expected, 3)
    })
  })

  it('same-lane pacers start apart and travel at different speeds, so they never merge', () => {
    const list = pacers(0, 8)
    for (const lane of PACER_LANES) {
      const inLane = list.filter((p) => p.lane === lane)
      for (let i = 0; i < inLane.length; i++) {
        for (let j = i + 1; j < inLane.length; j++) {
          const gap = Math.abs(inLane[i]!.d - inLane[j]!.d)
          const wrapped = Math.min(gap, LAP - gap)
          expect(`lane ${lane} gap ${wrapped.toFixed(1)}`).toBe(
            wrapped >= 8 ? `lane ${lane} gap ${wrapped.toFixed(1)}` : `lane ${lane} gap >= 8`,
          )
          expect(inLane[i]!.speed).not.toBeCloseTo(inLane[j]!.speed, 3)
        }
      }
    }
  })

  it('interval pacers hit exactly their fast and slow speeds within each cycle', () => {
    // sample a whole cycle at a fine step and confirm both plateaus are reached
    const seen = new Set<number>()
    for (let t = 0; t < 600; t += 0.25) {
      for (const p of pacers(t, 8)) {
        if (p.kind === 'intervals') seen.add(Math.round(p.speed * 100))
      }
    }
    expect(seen.has(Math.round(INTERVAL_FAST_KMH * 100))).toBe(true)
    expect(seen.has(Math.round(INTERVAL_SLOW_KMH * 100))).toBe(true)
    // and never anything outside the two plateaus — this is a square cycle, not a ramp
    for (const v of seen) {
      expect(`speed ${v}`).toBe(
        v === Math.round(INTERVAL_FAST_KMH * 100) || v === Math.round(INTERVAL_SLOW_KMH * 100)
          ? `speed ${v}`
          : `speed fast-or-slow`,
      )
    }
  })

  it('interval distance is analytic: a full cycle covers exactly INTERVAL_PERIOD_M', () => {
    const p0 = pacers(0, 8).find((p) => p.kind === 'intervals')!
    // seconds for one full cycle: half the period at fast, half at slow
    const half = INTERVAL_PERIOD_M / 2
    const cycleSecs =
      half / ((INTERVAL_FAST_KMH * 1000) / 3600) + half / ((INTERVAL_SLOW_KMH * 1000) / 3600)
    const p1 = pacers(cycleSecs, 8).find((p) => p.kind === 'intervals')!
    expect(p1.d - p0.d).toBeCloseTo(INTERVAL_PERIOD_M, 3)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicLife.test.ts`
Expected: FAIL — cannot resolve `./scenicLife`.

- [ ] **Step 3: Write the implementation**

Create `src/scenicLife.ts`:

```ts
// Other people on the 3D track, plus the cadence model the avatar and (in a later slice)
// the camera bob run on. Pure and three.js-free on purpose: Scenic3D.vue can never be
// unit-tested because jsdom has no WebGL, and App.vue imports from here directly, so a
// three import would drag three.js into the main bundle chunk.
//
// Pacer positions are ANALYTIC functions of elapsed time — no accumulated state — so the
// same second always produces the same scene, across reloads and in tests, without having
// to simulate time forward.
import { worldHash, LAP_M } from './scenic'

export type PacerKind = 'walker' | 'jogger' | 'runner' | 'intervals'

export interface Pacer {
  lane: number // 2..6 — never lane 1, which is where the walker is
  d: number // metres travelled along that lane's own line
  speed: number // km/h, instantaneous
  kind: PacerKind
  seed: number // 0..1, stable per pacer — drives kit colour
}

// Lane 1 is the walker's. Pacers use the outer lanes so a fast one overtaking cannot
// clip through the camera.
export const PACER_LANES = [2, 3, 4, 5, 6]

// Interval pacers run a square cycle: INTERVAL_PERIOD_M / 2 fast, then the same distance
// slow. A square cycle keeps the position closed-form — see distanceAt below.
export const INTERVAL_PERIOD_M = 200
export const INTERVAL_FAST_KMH = 14
export const INTERVAL_SLOW_KMH = 6

const KINDS: { kind: PacerKind; speed: number }[] = [
  { kind: 'walker', speed: 4.5 },
  { kind: 'jogger', speed: 8 },
  { kind: 'runner', speed: 11 },
  { kind: 'intervals', speed: INTERVAL_FAST_KMH },
  { kind: 'walker', speed: 5.5 },
  { kind: 'jogger', speed: 9 },
  { kind: 'runner', speed: 12.5 },
  { kind: 'walker', speed: 4 },
]

const mps = (kmh: number) => (kmh * 1000) / 3600

// One full fast+slow cycle, in seconds.
const CYCLE_SECS =
  INTERVAL_PERIOD_M / 2 / mps(INTERVAL_FAST_KMH) + INTERVAL_PERIOD_M / 2 / mps(INTERVAL_SLOW_KMH)
const FAST_SECS = INTERVAL_PERIOD_M / 2 / mps(INTERVAL_FAST_KMH)

// Closed-form distance for an interval pacer at time t: whole cycles are exact multiples
// of INTERVAL_PERIOD_M, and the remainder is one plateau or the other.
function intervalDistance(t: number): number {
  const cycles = Math.floor(t / CYCLE_SECS)
  const rem = t - cycles * CYCLE_SECS
  const base = cycles * INTERVAL_PERIOD_M
  return rem <= FAST_SECS
    ? base + rem * mps(INTERVAL_FAST_KMH)
    : base + INTERVAL_PERIOD_M / 2 + (rem - FAST_SECS) * mps(INTERVAL_SLOW_KMH)
}

function intervalSpeed(t: number): number {
  const rem = t - Math.floor(t / CYCLE_SECS) * CYCLE_SECS
  return rem <= FAST_SECS ? INTERVAL_FAST_KMH : INTERVAL_SLOW_KMH
}

export function pacers(t: number, count: number): Pacer[] {
  const out: Pacer[] = []
  for (let i = 0; i < count; i++) {
    const k = KINDS[i % KINDS.length]!
    const seed = worldHash(i * 31 + 7)
    // Spread starts around the lap so a lane's pacers begin well apart; the +i term
    // keeps two pacers landing in the same lane from starting on top of each other.
    const start = ((i * LAP_M) / KINDS.length + seed * 40) % LAP_M
    const offset = i * 0.37 // km/h, so same-lane pacers separate rather than travel merged
    const speed = k.kind === 'intervals' ? intervalSpeed(t) : k.speed + offset
    const d =
      k.kind === 'intervals' ? start + intervalDistance(t) : start + mps(k.speed + offset) * t
    out.push({ lane: PACER_LANES[i % PACER_LANES.length]!, d, speed, kind: k.kind, seed })
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenicLife.test.ts`
Expected: PASS, 7 tests.

If the same-lane separation case fails, adjust the `start` spread or `PACER_LANES` cycling so two pacers sharing a lane begin at least 8 m apart — do not relax the assertion. It is what stops two bodies rendering merged into one.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicLife.ts src/scenicLife.test.ts
git commit -m "feat: deterministic pacer positions for the scenic track"
```

---

### Task 2: Stride, cadence and step phase

The avatar's legs must move at the walker's REAL cadence, not a modelled one. `treadmill.ts` already records `state.steps` from the belt's own pedometer, so stride length is measurable rather than assumed.

**Files:**

- Modify: `src/scenicLife.ts`
- Modify: `src/scenicLife.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `DEFAULT_STRIDE_M`, `MIN_STRIDE_M`, `MAX_STRIDE_M`, `strideLength(distance: number, steps: number): number`, `stepPhase(distance: number, stride: number): number`, `cadenceHz(speedKmh: number, stride: number): number`.

- [ ] **Step 1: Write the failing test**

Append to `src/scenicLife.test.ts` (add the new names to its import list):

```ts
describe('strideLength', () => {
  it('measures your real stride from the belt pedometer', () => {
    expect(strideLength(1000, 1400)).toBeCloseTo(0.714, 3)
  })

  it('falls back to the default when there is no pedometer data', () => {
    // pre-#43 device state, a sensor gap, or the very first tick of a session
    expect(strideLength(0, 0)).toBe(DEFAULT_STRIDE_M)
    expect(strideLength(500, 0)).toBe(DEFAULT_STRIDE_M)
  })

  it('clamps nonsense rather than letting the legs thrash', () => {
    expect(strideLength(1000, 2)).toBe(MAX_STRIDE_M) // 500 m per step
    expect(strideLength(1, 1000)).toBe(MIN_STRIDE_M) // 1 mm per step
  })
})

describe('stepPhase', () => {
  it('completes exactly one cycle per stride walked', () => {
    const s = 0.72
    expect(stepPhase(0, s)).toBeCloseTo(0, 6)
    expect(stepPhase(s * 0.5, s)).toBeCloseTo(0.5, 6)
    expect(stepPhase(s * 3, s)).toBeCloseTo(0, 6)
  })

  it('is continuous across the lap wrap', () => {
    // phase comes from total distance, so 400 m is not special — but guard it anyway,
    // because a naive implementation keyed off trackPoint's wrapped s would jump here
    const s = 0.72
    const a = stepPhase(399.999, s)
    const b = stepPhase(400.001, s)
    expect(Math.abs(b - a)).toBeLessThan(0.01)
  })

  it('always lands in [0, 1)', () => {
    for (const d of [0, 0.1, 12.34, 399.99, 1000.5]) {
      const p = stepPhase(d, 0.72)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })
})

describe('cadenceHz', () => {
  it('rises with speed and falls with a longer stride', () => {
    expect(cadenceHz(6, 0.72)).toBeGreaterThan(cadenceHz(3, 0.72))
    expect(cadenceHz(5, 0.9)).toBeLessThan(cadenceHz(5, 0.6))
  })

  it('gives a plausible walking cadence at a walking pace', () => {
    // 5 km/h at a 0.72 m stride is about 116 steps per minute
    expect(cadenceHz(5, 0.72) * 60).toBeCloseTo(115.7, 1)
  })

  it('is zero when stopped', () => {
    expect(cadenceHz(0, 0.72)).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicLife.test.ts`
Expected: FAIL — `strideLength is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/scenicLife.ts`:

```ts
// --- cadence ---
// The belt reports its own step count (treadmill.ts records it from the fff1 running
// frame), so the avatar's cadence is MEASURED, not modelled: legs, arms and — in a later
// slice — the camera bob all move at the walker's real rate.

export const DEFAULT_STRIDE_M = 0.72
export const MIN_STRIDE_M = 0.4
export const MAX_STRIDE_M = 1.0

export function strideLength(distance: number, steps: number): number {
  if (steps <= 0 || distance <= 0) return DEFAULT_STRIDE_M
  const raw = distance / steps
  return Math.min(MAX_STRIDE_M, Math.max(MIN_STRIDE_M, raw))
}

// 0..1 through the current step, driven by walked distance rather than wall clock so it
// stays locked to the belt and is deterministic in tests.
export function stepPhase(distance: number, stride: number): number {
  const p = (distance / stride) % 1
  return p < 0 ? p + 1 : p
}

export function cadenceHz(speedKmh: number, stride: number): number {
  return mps(speedKmh) / stride
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenicLife.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicLife.ts src/scenicLife.test.ts
git commit -m "feat: measure stride and step phase from the belt pedometer"
```

---

### Task 3: Pace gap

**Files:**

- Modify: `src/scenicLife.ts`
- Modify: `src/scenicLife.test.ts`

**Interfaces:**

- Produces: `paceGap(yourDistance: number, rabbitDistance: number): number` — signed metres, positive when the rabbit is ahead.

- [ ] **Step 1: Write the failing test**

Append to `src/scenicLife.test.ts`:

```ts
describe('paceGap', () => {
  it('is positive when the rabbit is ahead of you', () => {
    expect(paceGap(100, 130)).toBe(30)
  })

  it('is negative when you are ahead of the rabbit', () => {
    expect(paceGap(160, 130)).toBe(-30)
  })

  it('is zero when level', () => {
    expect(paceGap(250, 250)).toBe(0)
  })

  it('does not wrap at the lap boundary — it is a total-distance gap, not a lap position', () => {
    // you have run a full lap more than the rabbit; that is a 400 m lead, not level
    expect(paceGap(800, 400)).toBe(-400)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicLife.test.ts`
Expected: FAIL — `paceGap is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/scenicLife.ts`:

```ts
// Signed metres between you and the rabbit, positive when it is ahead. Deliberately NOT
// wrapped to the lap: lapping the rabbit is a 400 m lead, not a dead heat.
export function paceGap(yourDistance: number, rabbitDistance: number): number {
  return rabbitDistance - yourDistance
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenicLife.test.ts`
Expected: PASS. The suite is now 225 + 14 = 239.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicLife.ts src/scenicLife.test.ts
git commit -m "feat: signed pace gap between the walker and the rabbit"
```

---

### Task 4: Pacer bodies on the track

**Files:**

- Modify: `src/scenicMeshes.ts`
- Modify: `src/Scenic3D.vue`

**Interfaces:**

- Consumes: `pacers`, `Pacer`, `stepPhase`, `cadenceHz` from `./scenicLife`; `laneDistanceToS`, `laneMeasurementO`, `trackPoint` from `./scenic`; `TIER_BUDGET[tier].pacers`.
- Produces: `src/scenicMeshes.ts` exports `runnerParts(): { body: THREE.BufferGeometry; limb: THREE.BufferGeometry }`.

- [ ] **Step 1: Add the body geometry to `src/scenicMeshes.ts`**

```ts
// A pacer is five meshes — body+head merged, two arms, two legs — sharing three
// materials. Deliberately low-poly: on the Quality tier eight of them are the scene's
// dominant per-frame cost, which is why the count is tier-gated.
export function runnerParts(): { body: THREE.BufferGeometry; limb: THREE.BufferGeometry } {
  const torso = new THREE.CapsuleGeometry(0.16, 0.5, 3, 6)
  torso.translate(0, 1.15, 0)
  const head = new THREE.SphereGeometry(0.12, 8, 6)
  head.translate(0, 1.58, 0)
  const body = mergeGeometries([torso, head])!
  torso.dispose()
  head.dispose()
  // Limb pivots at its top so a rotation about x swings it like a shoulder or hip.
  const limb = new THREE.CapsuleGeometry(0.055, 0.42, 3, 5)
  limb.translate(0, -0.24, 0)
  return { body, limb }
}
```

Add the import at the top of the file (it is already a dependency of `Scenic3D.vue`, so this adds nothing to the bundle):

```ts
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
```

- [ ] **Step 2: Build the pacers in `src/Scenic3D.vue`**

Add the imports:

```ts
import { pacers, stepPhase, cadenceHz } from './scenicLife'
import type { Pacer } from './scenicLife'
import { laneDistanceToS, laneMeasurementO } from './scenic'
import { runnerParts } from './scenicMeshes'
```

After the static world is baked (pacers move, so they must NOT enter the bake), build a pool sized to the largest tier so a tier change never rebuilds geometry:

```ts
// --- pacers (live, never baked) ---
const { body: pacerBodyGeo, limb: pacerLimbGeo } = runnerParts()
const PACER_POOL = TIER_BUDGET.high.pacers
interface PacerRig {
  group: THREE.Group
  armL: THREE.Mesh
  armR: THREE.Mesh
  legL: THREE.Mesh
  legR: THREE.Mesh
  kit: THREE.MeshStandardMaterial
}
const pacerRigs: PacerRig[] = []
for (let i = 0; i < PACER_POOL; i++) {
  const kit = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 })
  const group = new THREE.Group()
  const mk = (g: THREE.BufferGeometry, x: number, y: number) => {
    const m = new THREE.Mesh(g, kit)
    m.position.set(x, y, 0)
    m.castShadow = true
    group.add(m)
    return m
  }
  mk(pacerBodyGeo, 0, 0)
  const armL = mk(pacerLimbGeo, -0.22, 1.42)
  const armR = mk(pacerLimbGeo, 0.22, 1.42)
  const legL = mk(pacerLimbGeo, -0.09, 0.86)
  const legR = mk(pacerLimbGeo, 0.09, 0.86)
  group.visible = false
  scene.add(group)
  pacerRigs.push({ group, armL, armR, legL, legR, kit })
}
```

`scene.add` here runs AFTER the bake block, so these are never swept into `staticRoots`. Confirm that by placing this block below the bake — if you put it above, the pacers are merged into the static world and freeze in place.

- [ ] **Step 3: Drive them per frame**

Add near the other per-frame state:

```ts
let sessionSeconds = 0
```

and in `frame(now)`, right after `last = now`:

```ts
sessionSeconds += dt
```

Then in `update(d)`, after the sky work:

```ts
// Pacers: analytic positions, so no accumulated state to drift. Anything beyond the
// current weather's fog distance is hidden rather than drawn — with eight on a 400 m
// loop, typically three or four are actually visible.
const wanted = TIER_BUDGET[tier].pacers
const list = pacers(sessionSeconds, wanted)
for (let i = 0; i < pacerRigs.length; i++) {
  const rig = pacerRigs[i]!
  const p: Pacer | undefined = list[i]
  if (!p) {
    rig.group.visible = false
    continue
  }
  const o = laneMeasurementO(p.lane)
  const at = trackPoint(laneDistanceToS(o, p.d), o)
  const dx = at.x - camera.position.x
  const dz = at.z - camera.position.z
  const far = fogBand.far
  if (dx * dx + dz * dz > far * far) {
    rig.group.visible = false
    continue
  }
  rig.group.visible = true
  rig.group.position.set(at.x, 0, at.z)
  // the tangent comes from trackPoint, not from the Pacer — a Pacer has no heading
  rig.group.rotation.y = Math.atan2(-at.tx, -at.tz)
  rig.kit.color.setHSL(p.seed, 0.55, 0.5)
  // limbs swing in antiphase, arms opposite legs, at the pacer's own cadence
  const ph = stepPhase(p.d, 0.9) * Math.PI * 2
  const swing = Math.sin(ph) * 0.7
  rig.legL.rotation.x = swing
  rig.legR.rotation.x = -swing
  rig.armL.rotation.x = -swing
  rig.armR.rotation.x = swing
}
```

`trackPoint(s, o)` returns `{ x, z, tx, tz }` where `tx`/`tz` are the unit tangent — the direction of travel at that point on the loop. That is where the heading comes from; `Pacer` deliberately carries no heading of its own, because heading is a property of the track, not of the runner.

- [ ] **Step 4: Dispose**

In `cleanup`:

```ts
pacerBodyGeo.dispose()
pacerLimbGeo.dispose()
pacerRigs.forEach((r) => r.kit.dispose())
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS, suite still 239.

Then `npm run dev`, open `http://localhost:5173/?demo`, 3D view, and start a walk. Expected: other runners in the outer lanes, moving at visibly different speeds; you overtake the walkers and the faster ones overtake you. Confirm they face along the track rather than sideways or backwards, that their limbs swing, and that they do not slide (feet should not skate — the swing is tied to distance, so it will not be perfect, but it must not look frozen). Switch Settings → 3D quality between Performance and Quality and confirm the count changes from 3 to 8.

Also check `renderer.info.render.calls` via a temporary log: expect roughly 20 (static) + 5 per visible pacer. Remove the log before committing.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/scenicMeshes.ts src/Scenic3D.vue
git commit -m "feat: ambient pacers running the scenic track"
```

---

### Task 5: The nearest-pacer label

**Files:**

- Modify: `src/Scenic3D.vue`

**Interfaces:**

- Consumes: the `pacerRigs` and per-frame pacer loop from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Add a single reusable label sprite**

One sprite total, not one per pacer. Add after the pacer pool:

```ts
// One label, reused for whichever pacer is nearest AHEAD of the walker — Zwift shows
// who you are about to catch, not a name tag on every body in the scene.
const labelCanvas = document.createElement('canvas')
labelCanvas.width = 256
labelCanvas.height = 64
const labelTex = new THREE.CanvasTexture(labelCanvas)
labelTex.colorSpace = THREE.SRGBColorSpace
const labelSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: labelTex, depthWrite: false, transparent: true }),
)
labelSprite.scale.set(2.2, 0.55, 1)
labelSprite.visible = false
scene.add(labelSprite)
let lastLabel = ''
function drawLabel(text: string) {
  if (text === lastLabel) return // repainting a canvas every frame is a wasted upload
  lastLabel = text
  const ctx = labelCanvas.getContext('2d')!
  ctx.clearRect(0, 0, 256, 64)
  ctx.fillStyle = 'rgba(12, 15, 20, 0.72)'
  ctx.roundRect(4, 8, 248, 48, 12)
  ctx.fill()
  ctx.fillStyle = '#eaf2ff'
  ctx.font = 'bold 28px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 33)
  labelTex.needsUpdate = true
}
```

`scene.add(labelSprite)` must also run AFTER the bake, alongside the pacer rigs.

- [ ] **Step 2: Pick the nearest pacer ahead, each frame**

Inside `update(d)`, track the best candidate while looping the pacers. Add before the loop:

```ts
let nearest: { rig: PacerRig; p: Pacer; dist: number } | null = null
```

and inside the loop, after `rig.group.visible = true`:

```ts
const dist = Math.sqrt(dx * dx + dz * dz)
if (dist < 30 && (!nearest || dist < nearest.dist)) nearest = { rig, p, dist }
```

then after the loop:

```ts
if (nearest) {
  drawLabel(`${nearest.p.kind} · ${nearest.p.speed.toFixed(1)} km/h`)
  labelSprite.position.set(nearest.rig.group.position.x, 2.1, nearest.rig.group.position.z)
  labelSprite.visible = true
} else {
  labelSprite.visible = false
}
```

- [ ] **Step 3: Dispose**

In `cleanup`:

```ts
labelTex.dispose()
labelSprite.material.dispose()
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS.

`npm run dev`, `?demo`, walk. Expected: as a pacer comes within 30 m, a single label appears above it naming the kind and speed, and follows whichever pacer is nearest. Confirm only ONE label is ever on screen, and that it disappears when nobody is close.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/Scenic3D.vue
git commit -m "feat: name the nearest pacer with a single reused label"
```

---

### Task 6: The target-pace rabbit

The rabbit's distance is integrated in `App.vue`, which already owns workout state. `scenicLife` only turns two distances into a gap.

**Files:**

- Modify: `src/App.vue`
- Modify: `src/Scenic3D.vue`
- Modify: `src/App.hrWorkout.test.ts`

**Interfaces:**

- Consumes: `paceGap` from `./scenicLife`; `curSeg` (a `TimelineSegment` with `.speed` in km/h), `active`, `state.running`, `state.distance` in `App.vue`.
- Produces: `Scenic3D.vue` gains a `rabbitDistance?: number | null` prop — `null` or omitted means no rabbit.

- [ ] **Step 1: Write the failing test**

Append to `src/App.hrWorkout.test.ts`, inside its existing `describe('HR workout', ...)` block. That file already has a `toMain(w)` helper (`src/App.hrWorkout.test.ts:106`) that clicks through the wizard to a free walk, and a `fakeTm` object its `beforeEach` resets — reuse both; do not invent new ones.

Starting a plan follows the sequence `src/App.happy.test.ts:87-97` uses: click the `.mode-card` containing "Workout", click the first `.tcard`, then the button containing "Start workout".

`Scenic3D` is a `defineAsyncComponent`, so `findComponent({ name: 'Scenic3D' })` will not resolve in jsdom. Assert on the value `App.vue` computes instead, by reading the rendered prop off the wrapper's vm — the test is about the integration arithmetic, not about three.js.

```ts
it('the rabbit runs only for weight-loss plans and starts level with you (#realism slice 3)', async () => {
  const App = (await import('./App.vue')).default
  const w = (mounted = mount(App))
  await toMain(w)

  const rabbit = () => (w.vm as unknown as { rabbitDistance: number | null }).rabbitDistance

  // free walk, no plan: no rabbit at all
  expect(rabbit()).toBe(null)

  fakeTm.distance = 120
  await w
    .findAll('.mode-card')
    .find((c) => c.text().includes('Workout'))!
    .trigger('click')
  await w.findAll('.tcard')[0]!.trigger('click')
  await w
    .findAll('button')
    .find((b) => b.text().includes('Start workout'))!
    .trigger('click')

  // starts level with the walker, not back at zero
  expect(rabbit()).toBeCloseTo(120, 1)

  // and advances at the segment's target speed while the belt is running
  const before = rabbit()!
  fakeTm.running = true
  for (let i = 0; i < 10; i++) {
    fakeTm.elapsed += 1
    await nextTick()
  }
  expect(rabbit()!).toBeGreaterThan(before)
})
```

`rabbitDistance` must therefore be returned from `<script setup>`'s implicit binding — in Vue 3 SFCs every top-level `const` is exposed on the internal instance in dev/test builds, so no `defineExpose` is needed. If it turns out not to be reachable, add `defineExpose({ rabbitDistance })` in `App.vue` rather than weakening the assertions.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/App.hrWorkout.test.ts`
Expected: FAIL — `rabbitDistance` is not a prop of Scenic3D.

- [ ] **Step 3: Integrate the rabbit in `src/App.vue`**

Add near the other workout state:

```ts
// Target-pace rabbit (#realism slice 3): integrated here because this is the one place
// that already knows the workout's target speed. Weight-loss plans only — an HR target
// defines a heart rate, not a pace, so there is no pace to chase.
const rabbitDistance = ref<number | null>(null)
watch(active, (a) => {
  rabbitDistance.value = a ? state.distance : null
})
watch(
  () => state.elapsed,
  (now, prev) => {
    if (rabbitDistance.value === null || !state.running) return
    const seg = curSeg.value
    if (!seg) return
    const dt = Math.max(0, now - (prev ?? now))
    rabbitDistance.value += ((seg.speed * 1000) / 3600) * dt
  },
)
```

Pass it to the component:

```html
<Scenic3D
  :distance="state.distance"
  :speed="state.speed"
  :weather-seed="weatherSeed"
  :time-of-day="scenicTime as never"
  :quality="scenicQuality as never"
  :steps="state.steps"
  :rabbit-distance="rabbitDistance"
  @unsupported="scenicUnsupported"
/>
```

(`:steps` is consumed by Task 7; add it now so both tasks touch this element once.)

- [ ] **Step 4: Render the rabbit in `src/Scenic3D.vue`**

Add to the props:

```ts
  steps?: number
  rabbitDistance?: number | null
```

Build one more rig, in accent green, after the pacer pool:

```ts
// The rabbit runs lane 2 so it is beside the walker rather than under the camera.
const rabbitKit = new THREE.MeshStandardMaterial({ color: 0x3ba55d, roughness: 0.7 })
const rabbitGroup = new THREE.Group()
const rabbitLimbs: THREE.Mesh[] = []
{
  const mk = (g: THREE.BufferGeometry, x: number, y: number) => {
    const m = new THREE.Mesh(g, rabbitKit)
    m.position.set(x, y, 0)
    m.castShadow = true
    rabbitGroup.add(m)
    return m
  }
  mk(pacerBodyGeo, 0, 0)
  rabbitLimbs.push(mk(pacerLimbGeo, -0.22, 1.42), mk(pacerLimbGeo, 0.22, 1.42))
  rabbitLimbs.push(mk(pacerLimbGeo, -0.09, 0.86), mk(pacerLimbGeo, 0.09, 0.86))
}
rabbitGroup.visible = false
scene.add(rabbitGroup)
```

and drive it in `update(d)`:

```ts
const rd = props.rabbitDistance
if (rd == null) {
  rabbitGroup.visible = false
} else {
  rabbitGroup.visible = true
  const o = laneMeasurementO(2)
  const at = trackPoint(laneDistanceToS(o, rd), o)
  rabbitGroup.position.set(at.x, 0, at.z)
  rabbitGroup.rotation.y = Math.atan2(-at.tx, -at.tz)
  const ph = stepPhase(rd, 0.9) * Math.PI * 2
  const sw = Math.sin(ph) * 0.7
  rabbitLimbs[0]!.rotation.x = -sw
  rabbitLimbs[1]!.rotation.x = sw
  rabbitLimbs[2]!.rotation.x = sw
  rabbitLimbs[3]!.rotation.x = -sw
}
```

Dispose `rabbitKit` in `cleanup`.

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS, suite 240.

`npm run dev`, `?demo`, start a weight-loss plan. Expected: a green runner in lane 2, holding the plan's target speed. Walk faster than the target and you pull ahead of it; walk slower and it pulls away. End the workout and it disappears.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/App.vue src/Scenic3D.vue src/App.hrWorkout.test.ts
git commit -m "feat: target-pace rabbit for weight-loss plans"
```

---

### Task 7: Your own body

**Files:**

- Modify: `src/Scenic3D.vue`

**Interfaces:**

- Consumes: `props.steps`, `props.distance`; `strideLength`, `stepPhase` from `./scenicLife`; `TIER_BUDGET[tier].shadowMap`; the `blobGeo`/`blobMat` from the shadow work.
- Produces: nothing new.

- [ ] **Step 1: Add the shadow-casting body and the viewmodel arms**

The body exists only to cast your shadow — its geometry sits inside the 0.3 m near plane, so it is never itself visible. Add after the rabbit:

```ts
// Your own body. You never see it: every part sits inside the camera's 0.3 m near
// plane, so it is clipped away and exists purely to throw your shadow on the track.
const avatarKit = new THREE.MeshStandardMaterial({ color: 0x9fb4d0, roughness: 0.8 })
const avatarBody = new THREE.Mesh(pacerBodyGeo, avatarKit)
avatarBody.castShadow = true
scene.add(avatarBody)

// Forearms, parented to the camera at the bottom corners of the frustum — the standard
// first-person viewmodel. Same stepPhase as the shadow, so they cannot drift apart.
const armGeo = new THREE.CapsuleGeometry(0.05, 0.34, 3, 5)
armGeo.translate(0, -0.17, 0)
const armL = new THREE.Mesh(armGeo, avatarKit)
const armR = new THREE.Mesh(armGeo, avatarKit)
armL.position.set(-0.26, -0.32, -0.55)
armR.position.set(0.26, -0.32, -0.55)
camera.add(armL, armR)
scene.add(camera) // a camera must be in the scene graph for its children to render
```

- [ ] **Step 2: Drive them from your measured cadence**

In `update(d)`, after the camera has been positioned:

```ts
// Measured, not modelled: state.steps is the belt's own pedometer, so the arms swing
// at your real cadence rather than an assumed one.
const stride = strideLength(props.distance, props.steps ?? 0)
const bodyPhase = stepPhase(d, stride) * Math.PI * 2
const bodySwing = Math.sin(bodyPhase) * 0.55
avatarBody.position.set(camera.position.x, 0, camera.position.z)
avatarBody.rotation.y = camera.rotation.y
armL.rotation.x = bodySwing
armR.rotation.x = -bodySwing
```

- [ ] **Step 3: Blob fallback on the cheap tier**

Without a shadow map the invisible body casts nothing, so give the walker a disc instead. After the avatar block:

```ts
const avatarBlob = new THREE.Mesh(blobGeo, blobMat)
avatarBlob.rotation.x = -Math.PI / 2
avatarBlob.scale.setScalar(1.1)
scene.add(avatarBlob)
```

and in `update(d)`:

```ts
avatarBlob.visible = !TIER_BUDGET[tier].shadowMap
avatarBlob.position.set(camera.position.x, 0.03, camera.position.z)
```

`blobGeo` and `blobMat` are already created and disposed by the shadow work — do NOT dispose them again here.

- [ ] **Step 4: Dispose**

In `cleanup`:

```ts
avatarKit.dispose()
armGeo.dispose()
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: PASS.

`npm run dev`, `?demo`, Settings → 3D quality → Quality, and walk. Expected: your shadow on the track ahead of you (clearest with the time of day pinned to `dawn` or `sunset`, where the sun rakes), and forearms swinging at the bottom corners of the frame. Confirm the body itself is never visible — if you can see a torso, its geometry is outside the near plane and needs moving, not deleting.

On Performance: a soft disc under you instead, and the arms still swing.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/Scenic3D.vue
git commit -m "feat: your own shadow and swinging arms in the scenic view"
```

---

### Task 8: Update `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the module to the Layout section**

Next to the existing `src/scenicMeshes.ts` bullet, matching the surrounding voice:

- `src/scenicLife.ts` — **pure, three.js-free** (App.vue imports it directly, so a three import would drag three.js into the main chunk): ambient `pacers(t, count)` whose positions are analytic in elapsed time rather than accumulated, `strideLength`/`stepPhase`/`cadenceHz` (cadence is MEASURED from the belt's own pedometer via `state.steps`, not modelled), and `paceGap`. Unit-tested in `src/scenicLife.test.ts`.

- [ ] **Step 2: Add a paragraph after the scenic section**

> **Life on the track (slice 3)** — pacers, the rabbit and your avatar are the only live
> meshes in the scene; everything else is baked. They are added to the scene **after** the
> bake block, or they get merged into the static world and freeze. Pacers run lanes 2-6 so
> a fast one overtaking cannot clip through the camera, and anything beyond the current
> weather's fog distance is hidden rather than drawn. The rabbit runs for **weight-loss
> plans only** — an HR target defines a heart rate, not a pace, so there is no pace to
> chase — and `App.vue` integrates its distance because that is the one place that already
> knows the segment's target speed. Your own body is a shadow-caster only: every part sits
> inside the camera's 0.3 m near plane, so it is clipped away and exists purely to throw
> your shadow.

- [ ] **Step 3: Commit**

```bash
npm run format
git add CLAUDE.md
git commit -m "docs: record the scenic life module in CLAUDE.md"
```

---

## Definition of done

- Other runners pass you and you pass them, in their own lanes, at plausible speeds, with limbs swinging.
- A single label names the nearest pacer within 30 m.
- With a weight-loss plan running, a green rabbit holds the target pace and the gap reflects whether you are ahead or behind. No workout, no rabbit.
- Your shadow is on the track and your arms swing at your real measured cadence.
- Draw calls stay proportional to visible pacers — roughly 20 static plus 5 per visible body.
- `npm run lint`, `format:check`, `typecheck`, `test`, `build` and the bundle-size guard all pass.
- No new dependency in `package.json`, and `src/scenicLife.ts` contains no three.js import.
