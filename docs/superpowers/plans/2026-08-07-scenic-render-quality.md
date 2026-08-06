# Scenic Render Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WalkFit's 3D scenic walk look like a lit, textured outdoor scene at a real time of day, and introduce the quality-tier machinery the later slices gate on.

**Architecture:** All world _decisions_ live in pure, unit-tested modules (`scenic.ts`, new `scenicSky.ts`, `scenicQuality.ts`, plus the pure array builders in `scenicMeshes.ts`); `Scenic3D.vue` only turns answers into three.js meshes and stays a coordinator. `Scenic3D.vue` has no unit tests because jsdom has no WebGL, so anything testable must be extracted before it is changed. Rendering gains ACES tone mapping, a sun position driven by the day cycle, procedural `CanvasTexture` surfaces, and tier-gated shadows.

**Tech Stack:** Vue 3 `<script setup lang="ts">`, TypeScript strict, three.js 0.185 (already the one runtime dependency), Vitest, Playwright.

## Global Constraints

- **No new dependencies.** Not a single one. Every texture is a runtime `CanvasTexture`; no external asset files, so the offline PWA precache is unaffected. No `EffectComposer`, no post-processing. The only `three/addons` import allowed is `BufferGeometryUtils`, which is already imported.
- **Bundle guard:** `scripts/check-bundle-size.mjs` fails if the main chunk exceeds 250 kB. three.js must stay in the lazy `Scenic3D` chunk — never add a static import of `three` or of any new module that imports it into `App.vue` or anything `App.vue` imports eagerly.
- **Prettier:** no semicolons, single quotes, print width 100. Run `npm run format` before every commit.
- **Imports are extensionless and relative** (`from './scenic'`). `vi.mock` specifiers must match.
- **TypeScript strict.** No `any`. Protocol/BLE-adjacent conversions stay types-only.
- **Commit style:** conventional commits, lowercase imperative subject (`feat: …`, `fix: …`, `refactor: …`).
- **Never commit to `main`.** All work lands on the existing branch `feat/scenic-realism`.
- **Every commit must pass** `npm run lint && npm run format:check && npm run typecheck && npm test`.
- **Spec:** `docs/superpowers/specs/2026-08-07-scenic-realism-1-render-quality-design.md`.

## File Structure

| File                                     | Status     | Responsibility                                                                                              |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `src/scenic.ts`                          | modify     | Track geometry + surveyed markings + `surroundings()`. Sky/weather exports move out.                        |
| `src/scenicSky.ts`                       | create     | Day cycle, weather, palette, `skyBodies()`.                                                                 |
| `src/scenicSky.test.ts`                  | create     | Tests for the above.                                                                                        |
| `src/scenicQuality.ts`                   | create     | Frame-time probe, tier selection, settings resolution.                                                      |
| `src/scenicQuality.test.ts`              | create     | Tests for the above.                                                                                        |
| `src/scenicMeshes.ts`                    | create     | Pure vertex/index/uv array builders + the three.js mesh and texture factories extracted from the component. |
| `src/scenicMeshes.test.ts`               | create     | Tests for the pure array builders only.                                                                     |
| `src/Scenic3D.vue`                       | modify     | Coordinator: probe, build, bake, animate, dispose.                                                          |
| `src/SettingsSheet.vue`                  | modify     | Display section gains the quality control.                                                                  |
| `src/App.vue`                            | modify     | Quality ref + persistence, HUD scrim/vignette retune.                                                       |
| `src/i18n.ts`                            | modify     | Keys for the quality control, `en` and `nl`.                                                                |
| `src/scenic.test.ts`                     | modify     | Sky cases move out.                                                                                         |
| `e2e/smoke.spec.ts-snapshots/wizard.png` | regenerate | Only in the final task, only if it actually shifted.                                                        |

---

### Task 1: Extract `scenicSky.ts` (behaviour-neutral move)

The sky/weather/day-cycle code is about to grow. Move it out first, with zero behaviour change, so every later diff is small and readable. Moving the tests unchanged is what proves the move is neutral.

**Files:**

- Create: `src/scenicSky.ts`
- Create: `src/scenicSky.test.ts`
- Modify: `src/scenic.ts` (delete the moved block, lines 278-377)
- Modify: `src/scenic.test.ts` (delete the moved describe blocks and their imports)
- Modify: `src/Scenic3D.vue:12-35` (split the import)

**Interfaces:**

- Consumes: `worldHash` from `./scenic`.
- Produces: `src/scenicSky.ts` exporting `WeatherId`, `weatherFor`, `WEATHER_FOG`, `TimeOfDay`, `TIME_PHASES`, `DAY_LENGTH_M`, `dayPhase`, `SkyState`, `skyAt`, `isNight` — identical signatures to today's `scenic.ts` exports.

- [ ] **Step 1: Create `src/scenicSky.ts` by moving lines 278-377 of `src/scenic.ts` verbatim**

Cut everything from the `// --- weather (#72) ...` comment to the end of the file. Paste into the new file under this header, and add the one import it needs (`weatherFor` calls `worldHash`):

```ts
// Sky, weather and the day/night cycle for the 3D scenic walk. Split out of scenic.ts
// (which keeps the track geometry and surveyed markings) when the render-quality work
// grew this concern past a comfortable size. Pure and framework-free, like its sibling:
// Scenic3D.vue turns these answers into lights, fog and sky meshes.
import { worldHash } from './scenic'
```

Keep `lerp` and `lerpColor` module-private exactly as they are today — they are not exported and nothing outside uses them.

- [ ] **Step 2: Create `src/scenicSky.test.ts` by moving the sky cases verbatim**

Move the `describe('day/night', …)` block (`src/scenic.test.ts:224-240`) and the `describe('ambience (#72)', …)` block (`src/scenic.test.ts:242-265`) into the new file, unchanged. Header:

```ts
import { describe, it, expect } from 'vitest'
import {
  dayPhase,
  DAY_LENGTH_M,
  skyAt,
  isNight,
  weatherFor,
  WEATHER_FOG,
  TIME_PHASES,
} from './scenicSky'
```

Do not modify a single assertion. Unchanged assertions passing against the moved code is the entire point of this task.

- [ ] **Step 3: Delete the moved code and imports from the originals**

In `src/scenic.ts`, delete lines 278-377. In `src/scenic.test.ts`, delete the two moved `describe` blocks and remove `dayPhase`, `DAY_LENGTH_M`, `skyAt`, `isNight`, `weatherFor`, `WEATHER_FOG`, `TIME_PHASES` from its import list (leave every other import alone).

- [ ] **Step 4: Split the import in `src/Scenic3D.vue`**

Lines 12-35 currently import everything from `./scenic`. Split into two import statements — track things from `./scenic`, sky things from `./scenicSky`:

```ts
import {
  trackPoint,
  LAP_M,
  LANE_W,
  LANES,
  TRACK_IN,
  TRACK_OUT,
  surroundings,
  distanceSigns,
  laneStaggers,
  laneNumbers,
  BREAK_LINE_S,
  relayZoneLines,
  hurdleTicks,
  waterfallPoints,
} from './scenic'
import type { Prop } from './scenic'
import { dayPhase, skyAt, weatherFor, WEATHER_FOG, TIME_PHASES, isNight } from './scenicSky'
import type { TimeOfDay } from './scenicSky'
```

- [ ] **Step 5: Run the full check — nothing should have changed**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS, with the same total test count as before the move.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/scenic.ts src/scenic.test.ts src/scenicSky.ts src/scenicSky.test.ts src/Scenic3D.vue
git commit -m "refactor: split sky and weather out of scenic.ts into scenicSky.ts"
```

---

### Task 2: Quality tiers (`scenicQuality.ts`)

Pure tier selection, with no three.js and no DOM. Wiring comes in Task 6.

**Files:**

- Create: `src/scenicQuality.ts`
- Create: `src/scenicQuality.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type Tier = 'low' | 'high'`, `type QualitySetting = 'auto' | 'low' | 'high'`, `tierFromFrames(frameMs: number[]): Tier`, `resolveTier(setting: QualitySetting, probed: Tier): Tier`, `PROBE_FRAMES: number`, `TIER_BUDGET: Record<Tier, {textureSize, pacers, stars, clouds, shadowMap}>`.

- [ ] **Step 1: Write the failing test**

Create `src/scenicQuality.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tierFromFrames, resolveTier, PROBE_FRAMES, TIER_BUDGET } from './scenicQuality'

describe('tierFromFrames', () => {
  it('picks high for consistently fast frames', () => {
    expect(tierFromFrames(Array(PROBE_FRAMES).fill(8))).toBe('high')
  })

  it('picks low for consistently slow frames', () => {
    expect(tierFromFrames(Array(PROBE_FRAMES).fill(40))).toBe('low')
  })

  it('uses the median, so leading shader-compile spikes do not force low', () => {
    // the first handful of frames are always slow: shader compilation, texture upload
    const frames = [400, 120, 90, 60, ...Array(PROBE_FRAMES - 4).fill(8)]
    expect(tierFromFrames(frames)).toBe('high')
  })

  it('falls back to low when there is not enough data to judge', () => {
    expect(tierFromFrames([])).toBe('low')
    expect(tierFromFrames([8, 8])).toBe('low')
  })
})

describe('resolveTier', () => {
  it('honours an explicit setting over the probe', () => {
    expect(resolveTier('low', 'high')).toBe('low')
    expect(resolveTier('high', 'low')).toBe('high')
  })

  it('falls through to the probe on auto', () => {
    expect(resolveTier('auto', 'high')).toBe('high')
    expect(resolveTier('auto', 'low')).toBe('low')
  })
})

describe('TIER_BUDGET', () => {
  it('high is at least as generous as low on every axis', () => {
    expect(TIER_BUDGET.high.textureSize).toBeGreaterThan(TIER_BUDGET.low.textureSize)
    expect(TIER_BUDGET.high.pacers).toBeGreaterThan(TIER_BUDGET.low.pacers)
    expect(TIER_BUDGET.high.stars).toBeGreaterThan(TIER_BUDGET.low.stars)
    expect(TIER_BUDGET.high.shadowMap).toBe(true)
    expect(TIER_BUDGET.low.shadowMap).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicQuality.test.ts`
Expected: FAIL — `Failed to resolve import "./scenicQuality"`.

- [ ] **Step 3: Write the implementation**

Create `src/scenicQuality.ts`:

```ts
// Adaptive quality for the 3D scenic walk. The same app runs on a phone propped on the
// treadmill and on a desktop, so the renderer probes its own frame time for the first
// PROBE_FRAMES frames and picks a tier from the median — the mean would be dragged by
// the shader-compilation spikes that always sit at the front of the sample.
//
// Pure and DOM-free so it can be unit-tested; Scenic3D.vue owns the sampling.

export type Tier = 'low' | 'high'
export type QualitySetting = 'auto' | 'low' | 'high'

export const PROBE_FRAMES = 60
// median frame time at or below this counts as "this machine can afford the trimmings"
export const HIGH_TIER_MS = 20 // ≈ 50 fps

export interface TierBudget {
  textureSize: number
  pacers: number // slice 3
  stars: number
  clouds: boolean
  shadowMap: boolean
}

export const TIER_BUDGET: Record<Tier, TierBudget> = {
  low: { textureSize: 256, pacers: 3, stars: 200, clouds: false, shadowMap: false },
  high: { textureSize: 1024, pacers: 8, stars: 800, clouds: true, shadowMap: true },
}

export function tierFromFrames(frameMs: number[]): Tier {
  // too few samples to judge: stay where we started rather than guessing upward
  if (frameMs.length < PROBE_FRAMES / 2) return 'low'
  const sorted = [...frameMs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  return median <= HIGH_TIER_MS ? 'high' : 'low'
}

export function resolveTier(setting: QualitySetting, probed: Tier): Tier {
  return setting === 'auto' ? probed : setting
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenicQuality.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicQuality.ts src/scenicQuality.test.ts
git commit -m "feat: adaptive quality tiers for the 3D scenic view"
```

---

### Task 3: Pure UV-generating array builders (`scenicMeshes.ts`)

`buildLoopRibbon` and `buildCrossStrip` currently live inside `Scenic3D.vue` and generate no UVs, which is why the bake pass deletes UVs from everything else to make `mergeGeometries` agree. Textures need the opposite. Extract the geometry maths as pure functions returning plain arrays, so it is testable without three.js, then wrap them.

**Files:**

- Create: `src/scenicMeshes.ts`
- Create: `src/scenicMeshes.test.ts`

**Interfaces:**

- Consumes: `trackPoint`, `LAP_M`, `TRACK_IN`, `TRACK_OUT` from `./scenic`.
- Produces: `interface MeshArrays { position: number[]; uv: number[]; index: number[] }`, `ribbonArrays(o0: number, o1: number, y: number, repeatMetres: number, step?: number): MeshArrays`, `stripArrays(s: number, widthM: number, y: number, o0: number, o1: number): MeshArrays`.

- [ ] **Step 1: Write the failing test**

Create `src/scenicMeshes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ribbonArrays, stripArrays } from './scenicMeshes'
import { trackPoint, LAP_M, TRACK_IN, TRACK_OUT } from './scenic'

const BREAK_S = 120 // an arbitrary arc position on the first bend, for the strip cases

describe('ribbonArrays', () => {
  it('closes the loop: the last ring coincides with the first', () => {
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10)
    const n = r.position.length / 3
    for (let k = 0; k < 6; k++) {
      expect(r.position[k]).toBeCloseTo(r.position[(n - 2) * 3 + k]!, 6)
    }
  })

  it('emits two vertices per sample and a quad per gap', () => {
    const step = 2
    const rings = Math.ceil(LAP_M / step) + 1
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10, step)
    expect(r.position.length / 3).toBe(rings * 2)
    expect(r.uv.length / 2).toBe(rings * 2)
    expect(r.index.length).toBe((rings - 1) * 6)
  })

  it('advances u at the requested metres-per-repeat and spans v across the width', () => {
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10)
    // first ring: u = 0 on both edges, v = 0 then 1
    expect(r.uv[0]).toBeCloseTo(0, 6)
    expect(r.uv[1]).toBeCloseTo(0, 6)
    expect(r.uv[3]).toBeCloseTo(1, 6)
    // the ring at s = 20 m is two repeats along at 10 m per repeat
    const ringAt20 = 10 // s = i * 2 m, so i = 10
    expect(r.uv[ringAt20 * 4]).toBeCloseTo(2, 6)
  })

  it('places vertices on the track at the requested lateral offsets and height', () => {
    const y = 0.06
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, y, 10)
    const a = trackPoint(0, TRACK_IN)
    expect(r.position[0]).toBeCloseTo(a.x, 6)
    expect(r.position[1]).toBeCloseTo(y, 6)
    expect(r.position[2]).toBeCloseTo(a.z, 6)
  })

  it('every index is in range', () => {
    const r = ribbonArrays(TRACK_IN, TRACK_OUT, 0, 10)
    const n = r.position.length / 3
    for (const i of r.index) expect(i).toBeGreaterThanOrEqual(0)
    for (const i of r.index) expect(i).toBeLessThan(n)
  })
})

describe('stripArrays', () => {
  it('spans exactly the requested lateral offsets and arc width', () => {
    const s = BREAK_S
    const r = stripArrays(s, 0.5, 0.07, TRACK_IN, TRACK_OUT)
    expect(r.position.length / 3).toBe(4)
    expect(r.index.length).toBe(6)
    const a0 = trackPoint(s, TRACK_IN)
    const b1 = trackPoint(s + 0.5, TRACK_OUT)
    expect(r.position[0]).toBeCloseTo(a0.x, 6)
    expect(r.position[9]).toBeCloseTo(b1.x, 6)
  })

  it('carries a full 0..1 uv quad', () => {
    const r = stripArrays(0, 0.5, 0.07, TRACK_IN, TRACK_OUT)
    expect([...r.uv]).toEqual([0, 0, 0, 1, 1, 0, 1, 1])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicMeshes.test.ts`
Expected: FAIL — `Failed to resolve import "./scenicMeshes"`.

- [ ] **Step 3: Write the implementation**

Create `src/scenicMeshes.ts`. This task adds only the pure part; the three.js wrappers arrive in Task 4.

```ts
// Geometry array builders for the 3D scenic walk. These return plain vertex/uv/index
// arrays rather than three.js BufferGeometry so the maths is unit-testable without a
// WebGL context (Scenic3D.vue itself can never be tested — jsdom has no WebGL).
//
// UVs matter more than they look: the loop ribbons used to carry none, which forced the
// component's merge pass to DELETE uv from every primitive so mergeGeometries would
// accept a mixed batch. Textured surfaces need the opposite, so every builder here emits
// uv and the merge pass fills in zeros for anything still missing it.
import { trackPoint, LAP_M } from './scenic'

export interface MeshArrays {
  position: number[]
  uv: number[]
  index: number[]
}

// Closed ribbon around the whole loop between lateral offsets [o0, o1], sampled every
// `step` metres. `u` advances one unit per `repeatMetres` of arc so a tiled texture keeps
// a plausible physical scale instead of being stretched around all 400 m; `v` spans the
// width. Winding matches the original component's: face normals point +y.
export function ribbonArrays(
  o0: number,
  o1: number,
  y: number,
  repeatMetres: number,
  step = 2,
): MeshArrays {
  const n = Math.ceil(LAP_M / step)
  const position: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * LAP_M
    const a = trackPoint(s, o0)
    const b = trackPoint(s, o1)
    position.push(a.x, y, a.z, b.x, y, b.z)
    const u = s / repeatMetres
    uv.push(u, 0, u, 1)
    if (i > 0) {
      const k = (i - 1) * 2
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  return { position, uv, index }
}

// Short strip across the track at arc position s (finish line, lane staggers, relay and
// hurdle marks). One quad, one full 0..1 uv square.
export function stripArrays(
  s: number,
  widthM: number,
  y: number,
  o0: number,
  o1: number,
): MeshArrays {
  const a0 = trackPoint(s, o0)
  const a1 = trackPoint(s, o1)
  const b0 = trackPoint(s + widthM, o0)
  const b1 = trackPoint(s + widthM, o1)
  return {
    position: [a0.x, y, a0.z, a1.x, y, a1.z, b0.x, y, b0.z, b1.x, y, b1.z],
    uv: [0, 0, 0, 1, 1, 0, 1, 1],
    index: [0, 2, 1, 1, 2, 3],
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenicMeshes.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicMeshes.ts src/scenicMeshes.test.ts
git commit -m "feat: pure uv-generating geometry builders for the scenic track"
```

---

### Task 4: Wire the array builders in and fix the bake pass

The riskiest edit in the slice, done alone so it can be reviewed and reverted alone. **No visual change is expected from this task** — the scene should look identical afterwards. If it does not, the merge is wrong.

**Files:**

- Modify: `src/scenicMeshes.ts` (add the three.js wrappers)
- Modify: `src/Scenic3D.vue:205-251` (replace the local builders), `:391-431` (the bake pass)

**Interfaces:**

- Consumes: `ribbonArrays`, `stripArrays` from Task 3.
- Produces: `src/scenicMeshes.ts` additionally exporting `geometryFrom(arrays: MeshArrays): THREE.BufferGeometry`, `ensureUv(g: THREE.BufferGeometry): void`, `assertSameAttributes(geoms: THREE.BufferGeometry[], label: string): void`.

- [ ] **Step 1: Add the three.js wrappers to `src/scenicMeshes.ts`**

Append, with the import at the top of the file:

```ts
import * as THREE from 'three'
```

```ts
export function geometryFrom(a: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.position, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2))
  g.setIndex(a.index)
  g.computeVertexNormals()
  return g
}

// mergeGeometries silently produces garbage if the batch disagrees on which attributes
// exist. Everything we build carries uv; three.js primitives do too, but a future
// geometry might not — fill in zeros rather than deleting uv from the ones that have it.
export function ensureUv(g: THREE.BufferGeometry): void {
  if (g.getAttribute('uv')) return
  const count = g.getAttribute('position')!.count
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2))
}

// Fail loudly at build time instead of rendering a corrupted mesh. A mismatch here is
// the single most likely way this file breaks, and it is invisible without the check.
export function assertSameAttributes(geoms: THREE.BufferGeometry[], label: string): void {
  if (geoms.length < 2) return
  const key = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort().join(',')
  const first = key(geoms[0]!)
  for (const g of geoms) {
    if (key(g) !== first) {
      throw new Error(`scenic merge: attribute mismatch for "${label}" — ${key(g)} vs ${first}`)
    }
  }
}
```

- [ ] **Step 2: Replace the local builders in `src/Scenic3D.vue`**

Delete `buildLoopRibbon` (lines 205-225) and `buildCrossStrip` (lines 227-251) entirely. Add to the imports:

```ts
import {
  ribbonArrays,
  stripArrays,
  geometryFrom,
  ensureUv,
  assertSameAttributes,
} from './scenicMeshes'
```

Add local wrappers with the same signatures the call sites already use, so the ~20 call sites below need no edits beyond the new `repeatMetres` argument:

```ts
// texture tiling scale per surface, in metres of arc per texture repeat
const REPEAT = { track: 6, lane: 40, infield: 12, kerb: 8, mark: 1 }

function buildLoopRibbon(
  o0: number,
  o1: number,
  y: number,
  m: THREE.Material,
  repeatMetres = REPEAT.mark,
): THREE.Mesh {
  return new THREE.Mesh(geometryFrom(ribbonArrays(o0, o1, y, repeatMetres)), m)
}

function buildCrossStrip(
  s: number,
  widthM: number,
  y: number,
  m: THREE.Material,
  o0 = TRACK_IN,
  o1 = TRACK_OUT,
): THREE.Mesh {
  return new THREE.Mesh(geometryFrom(stripArrays(s, widthM, y, o0, o1)), m)
}
```

Then pass the right repeat at the three ribbon call sites that will carry a tiled texture in Task 7 (lines 270, 273, 285 today):

```ts
track(buildLoopRibbon(TRACK_IN - 30, TRACK_IN, 0.0, mat.infield, REPEAT.infield))
track(buildLoopRibbon(TRACK_IN, TRACK_OUT, 0.02, mat.track, REPEAT.track))
track(buildLoopRibbon(TRACK_IN - 0.2, TRACK_IN - 0.02, 0.08, mat.kerb, REPEAT.kerb))
```

The lane-line ribbons and every cross strip keep the default — they are flat paint and get no tiled map.

Also replace the hand-rolled waterfall geometry (lines 297-316) so it too carries UVs:

```ts
{
  const pts = waterfallPoints()
  const w = 0.14
  const position: number[] = []
  const uv: number[] = []
  const index: number[] = []
  pts.forEach((p, i) => {
    const a = trackPoint(p.s - w, p.o)
    const b = trackPoint(p.s + w, p.o)
    position.push(a.x, 0.065, a.z, b.x, 0.065, b.z)
    const u = i / (pts.length - 1)
    uv.push(u, 0, u, 1)
    if (i > 0) {
      const k = (i - 1) * 2
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  })
  track(new THREE.Mesh(geometryFrom({ position, uv, index }), mat.finish))
}
```

- [ ] **Step 3: Fix the bake pass**

In the bake block (lines 397-431), replace the UV deletion with UV filling, and add the assert before merging:

```ts
const g = (m.geometry as THREE.BufferGeometry).clone()
g.applyMatrix4(m.matrixWorld)
ensureUv(g) // was deleteAttribute('uv') — textured surfaces need uv, not none
const arr = byMat.get(material) ?? []
```

and:

```ts
    for (const [material, geoms] of byMat) {
      assertSameAttributes(geoms, material.name || material.type)
      const merged = mergeGeometries(geoms)
```

- [ ] **Step 4: Verify nothing changed visually**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS.

Then run the app and look at it. This step cannot be automated:

```bash
npm run dev
```

Open `http://localhost:5173/?demo`, switch to the 3D view, and walk a full lap. Expected: **pixel-for-pixel the same scene as before this task.** Specifically confirm the track band, all seven lane lines, the finish line, lane staggers, kerb, relay marks, hurdle ticks, the green break line and the waterfall curve are all still present and in the same places. A missing or scrambled surface means the merge is wrong — that is exactly what this task is isolated to catch.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicMeshes.ts src/Scenic3D.vue
git commit -m "refactor: generate uvs in scenic geometry instead of stripping them at merge"
```

---

### Task 5: `skyBodies()` — sun and moon positions

**Files:**

- Modify: `src/scenicSky.ts`
- Modify: `src/scenicSky.test.ts`

**Interfaces:**

- Consumes: `dayPhase`, `isNight`, `TIME_PHASES` (already in the module).
- Produces: `interface SkyBodies { sun: CelestialBody; moon: CelestialBody; starOpacity: number }`, `interface CelestialBody { azimuth: number; elevation: number; visible: boolean }`, `skyBodies(phase: number): SkyBodies`.

- [ ] **Step 1: Write the failing test**

Append to `src/scenicSky.test.ts` (and add `skyBodies` to its import list):

```ts
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

  it('moon is visible exactly when the sun is not', () => {
    for (let p = 0; p < 1; p += 0.01) {
      const b = skyBodies(p)
      expect(b.moon.visible).toBe(!b.sun.visible)
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
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicSky.test.ts`
Expected: FAIL — `skyBodies is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/scenicSky.ts`:

```ts
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
const MAX_ELEVATION = Math.PI * 0.42 // just shy of straight overhead

export function skyBodies(phase: number): SkyBodies {
  const p = ((phase % 1) + 1) % 1
  // one full circuit per cycle; elevation is a cosine peaking at SUN_PEAK_PHASE, so it
  // crosses zero a quarter-cycle either side and goes negative through the night band
  const azimuth = p * Math.PI * 2
  const elevation = Math.cos((p - SUN_PEAK_PHASE) * Math.PI * 2) * MAX_ELEVATION
  const sunUp = elevation > 0 && !isNight(p)
  // stars ramp over the 0.05-phase shoulder either side of the night band rather than
  // popping on at its edge
  const starOpacity = isNight(p) ? 1 : Math.max(0, Math.min(1, (p - 0.77) / 0.05))
  return {
    sun: { azimuth, elevation, visible: sunUp },
    moon: { azimuth: azimuth + Math.PI, elevation: -elevation, visible: !sunUp },
    starOpacity,
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenicSky.test.ts`
Expected: PASS.

If the "sun is below the horizon through the whole night band" case fails, `isNight`'s band and the cosine's zero crossings disagree — adjust `MAX_ELEVATION`'s phase term, not the test. The test encodes the requirement.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicSky.ts src/scenicSky.test.ts
git commit -m "feat: derive sun and moon position from the scenic day cycle"
```

---

### Task 6: Tone mapping, sun-driven light, and the tier probe

**Files:**

- Modify: `src/Scenic3D.vue`
- Modify: `src/SettingsSheet.vue` (Display section, after the time-of-day row at line 303-315)
- Modify: `src/App.vue` (near `scenicTime`, lines 472-473; and the `<Scenic3D>` element at 1365-1371)
- Modify: `src/i18n.ts` (`en` near line 208, `nl` near line 460)

**Interfaces:**

- Consumes: `skyBodies`, `SUN_PEAK_PHASE` from Task 5; `tierFromFrames`, `resolveTier`, `TIER_BUDGET`, `PROBE_FRAMES`, `Tier`, `QualitySetting` from Task 2.
- Produces: `Scenic3D.vue` gains a `quality?: QualitySetting` prop. `App.vue` gains a `scenicQuality` ref persisted at `walkfit.scenic.quality`.

- [ ] **Step 1: Enable tone mapping in `src/Scenic3D.vue`**

After the renderer is constructed (line 83-85):

```ts
renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
// ACES compresses the highlights, which is what lets the palette be authored at real
// outdoor brightness instead of the muted values the old un-tone-mapped scene needed.
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
el.appendChild(renderer.domElement)
```

`outputColorSpace` is already `SRGBColorSpace` by default in three 0.185 — do not set it, and do not convert any existing hex value. Task 10 re-authors the palette against ACES.

- [ ] **Step 2: Drive the sun from `skyBodies`**

Add `skyBodies` to the `./scenicSky` import. The directional light needs an explicit target in the scene for the shadow camera (Task 8) to aim:

```ts
const hemi = new THREE.HemisphereLight(0xffffff, 0x30363f, 0.9)
const sun = new THREE.DirectionalLight(0xffffff, 1)
const sunTarget = new THREE.Object3D()
scene.add(hemi, sun, sunTarget)
sun.target = sunTarget
const SUN_DIST = 120
```

In `update(d)`, replace nothing yet — add the positioning right after `const sky = skyAt(phase, weather)`:

```ts
const bodies = skyBodies(phase)
// keep the light rig centred on the walker so its shadow box stays useful
sunTarget.position.set(camera.position.x, 0, camera.position.z)
sun.position.set(
  camera.position.x + Math.cos(bodies.sun.azimuth) * Math.cos(bodies.sun.elevation) * SUN_DIST,
  Math.max(2, Math.sin(bodies.sun.elevation) * SUN_DIST),
  camera.position.z + Math.sin(bodies.sun.azimuth) * Math.cos(bodies.sun.elevation) * SUN_DIST,
)
```

The `Math.max(2, …)` floor keeps the light above the ground plane at night, when elevation is negative — the scene is lit by ambient then, and a light below the floor would light nothing.

- [ ] **Step 3: Add the tier probe**

Add the prop and imports:

```ts
import { tierFromFrames, resolveTier, PROBE_FRAMES } from './scenicQuality'
import type { Tier, QualitySetting } from './scenicQuality'
```

`TIER_BUDGET` is deliberately **not** imported yet — nothing in this task reads it, and an unused import fails lint. Task 7 adds it.

```ts
const props = defineProps<{
  distance: number
  speed: number
  weatherSeed?: number
  timeOfDay?: TimeOfDay
  quality?: QualitySetting
}>()
```

Inside `onMounted`, before the scene is built:

```ts
// Start on the cheap tier and upgrade once if the machine turns out to be fast. Never
// downgrade mid-session: a tier flip during a walk is more jarring than a few dropped
// frames, and the walker cannot do anything about it either way.
let tier: Tier = props.quality === 'high' ? 'high' : 'low'
const probeSamples: number[] = []
let probeDone = props.quality !== 'auto' && props.quality !== undefined
```

and in `frame(now)`, right after `last = now`:

```ts
if (!probeDone) {
  probeSamples.push(dt * 1000)
  if (probeSamples.length >= PROBE_FRAMES) {
    probeDone = true
    const next = resolveTier(props.quality ?? 'auto', tierFromFrames(probeSamples))
    if (next !== tier) applyTier(next)
  }
}
```

`applyTier` for now only records the choice; Tasks 7-9 give it work to do:

```ts
function applyTier(next: Tier) {
  tier = next
}
```

Do **not** introduce a `budget` variable in this task. `TIER_BUDGET` is imported for `applyTier`'s future use but has no reader yet, so reference it directly at the one place that needs it in this task and let Task 7 add the cached `budget` local when there is something to read from it. TypeScript strict plus the ESLint config will reject an assigned-but-never-read local, and an `eslint-disable` here would be papering over a wiring step that is simply not finished until Task 7.

- [ ] **Step 4: Wire the setting through `App.vue`, `SettingsSheet.vue` and `i18n.ts`**

In `src/App.vue`, next to `scenicTime` (line 472):

```ts
const scenicQuality = ref(localStorage.getItem('walkfit.scenic.quality') || 'auto')
watch(scenicQuality, (v) => localStorage.setItem('walkfit.scenic.quality', v))
```

Pass it to the component (line 1365):

```html
<Scenic3D
  :distance="state.distance"
  :speed="state.speed"
  :weather-seed="weatherSeed"
  :time-of-day="scenicTime as never"
  :quality="scenicQuality as never"
  @unsupported="scenicUnsupported"
/>
```

Pass it into the settings sheet the same way `scenicTime` is passed (find the `<SettingsSheet>` element and add `v-model:scenic-quality="scenicQuality"` alongside the existing `v-model:scenic-time`).

In `src/SettingsSheet.vue`, add the model next to line 89's `viewMode`:

```ts
const scenicQuality = defineModel<string>('scenicQuality', { required: true })
```

and a row in the `display` section, immediately after the time-of-day row (line 315):

```html
<div class="set-row">
  <span>{{ t('settings.quality') }}</span>
  <select v-model="scenicQuality" class="set-select">
    <option value="auto">{{ t('settings.qualityAuto') }}</option>
    <option value="low">{{ t('settings.qualityLow') }}</option>
    <option value="high">{{ t('settings.qualityHigh') }}</option>
  </select>
</div>
```

In `src/i18n.ts`, add to the `en` table near line 208 and the `nl` table near line 460:

```ts
  'settings.quality': '3D quality',
  'settings.qualityAuto': 'Auto (match this device)',
  'settings.qualityLow': 'Performance',
  'settings.qualityHigh': 'Quality',
```

```ts
  'settings.quality': '3D-kwaliteit',
  'settings.qualityAuto': 'Auto (past bij dit apparaat)',
  'settings.qualityLow': 'Prestaties',
  'settings.qualityHigh': 'Kwaliteit',
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: PASS, and `check-bundle-size` still green.

Then `npm run dev`, open `?demo`, switch to 3D. Expected: the scene is noticeably different — tone mapping flattens the highlights, and the sun now moves, so walking far enough to cross into sunset visibly changes the light direction. Settings → Display shows the new 3D quality control.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/Scenic3D.vue src/App.vue src/SettingsSheet.vue src/i18n.ts
git commit -m "feat: aces tone mapping, sun-driven light and a quality tier probe"
```

---

### Task 7: Procedural textures

**Files:**

- Modify: `src/scenicMeshes.ts` (texture factories)
- Modify: `src/Scenic3D.vue` (material table, `applyTier`, disposal)

**Interfaces:**

- Consumes: `worldHash` from `./scenic`; `Tier`/`TIER_BUDGET` from `./scenicQuality`.
- Produces: `src/scenicMeshes.ts` exporting `tartanTexture(size)`, `grassTexture(size, hue)`, `barkTexture(size)`, `foliageTexture(size)`, `concreteTexture(size)`, all returning `THREE.CanvasTexture`; and `surface(tier, opts)` returning a `THREE.Material`.

- [ ] **Step 1: Add the texture factories to `src/scenicMeshes.ts`**

```ts
import { worldHash } from './scenic'

// Every surface texture is generated at runtime into a canvas — no asset files, so the
// offline service worker precache is unaffected and the bundle does not grow. All noise
// comes from worldHash, so a given size always produces the identical texture.
function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  return [c, c.getContext('2d')!]
}

function finish(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// red tartan: base colour, fine rubber granules, faint roll marks along the lap
export function tartanTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#9c4238'
  ctx.fillRect(0, 0, size, size)
  const grains = size * size * 0.12
  for (let i = 0; i < grains; i++) {
    const x = worldHash(i * 3 + 1) * size
    const y = worldHash(i * 3 + 2) * size
    const v = worldHash(i * 3 + 3)
    ctx.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,190,170,0.12)'
    ctx.fillRect(x, y, 1.5, 1.5)
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.05)'
  ctx.lineWidth = 1
  for (let i = 0; i < 12; i++) {
    const y = (i / 12) * size + worldHash(i + 900) * 4
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(size, y)
    ctx.stroke()
  }
  return finish(c)
}

// grass / infield: value noise plus blade streaks. `hue` shifts the two green surfaces
// apart so ground and infield do not read as one continuous plane.
export function grassTexture(size: number, hue: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = `hsl(${hue}, 28%, 22%)`
  ctx.fillRect(0, 0, size, size)
  const cells = Math.max(16, size / 8)
  for (let i = 0; i < cells * cells; i++) {
    const x = (i % cells) * (size / cells)
    const y = Math.floor(i / cells) * (size / cells)
    const v = worldHash(i * 7 + 11)
    ctx.fillStyle = `hsla(${hue + (v - 0.5) * 14}, 30%, ${18 + v * 12}%, 0.7)`
    ctx.fillRect(x, y, size / cells, size / cells)
  }
  ctx.strokeStyle = 'rgba(160,200,140,0.10)'
  for (let i = 0; i < size * 1.5; i++) {
    const x = worldHash(i * 5 + 31) * size
    const y = worldHash(i * 5 + 32) * size
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (worldHash(i * 5 + 33) - 0.5) * 3, y - 3)
    ctx.stroke()
  }
  return finish(c)
}

// trunk striation
export function barkTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#5d4634'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < size / 2; i++) {
    const x = worldHash(i * 4 + 51) * size
    ctx.fillStyle = worldHash(i * 4 + 52) < 0.5 ? 'rgba(0,0,0,0.22)' : 'rgba(210,180,150,0.10)'
    ctx.fillRect(x, 0, 1 + worldHash(i * 4 + 53) * 2, size)
  }
  return finish(c)
}

// leaf-cluster noise for the crowns
export function foliageTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#3f7d3a'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < size * 2; i++) {
    const x = worldHash(i * 6 + 71) * size
    const y = worldHash(i * 6 + 72) * size
    const r = 2 + worldHash(i * 6 + 73) * (size / 24)
    const v = worldHash(i * 6 + 74)
    ctx.fillStyle = `rgba(${40 + v * 40}, ${100 + v * 60}, ${40 + v * 30}, 0.55)`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  return finish(c)
}

// off-white concrete with panel joints — kerb now, grandstand in slice 2
export function concreteTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#e8ecf2'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < size * size * 0.04; i++) {
    ctx.fillStyle = `rgba(120,130,145,${0.04 + worldHash(i + 131) * 0.06})`
    ctx.fillRect(worldHash(i * 2 + 132) * size, worldHash(i * 2 + 133) * size, 2, 2)
  }
  ctx.strokeStyle = 'rgba(110,120,135,0.35)'
  ctx.lineWidth = Math.max(1, size / 256)
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath()
    ctx.moveTo(0, f * size)
    ctx.lineTo(size, f * size)
    ctx.stroke()
  }
  return finish(c)
}

// Lambert on the cheap tier (it accepts a map and costs far less), Standard on the
// expensive one where roughness response is worth paying for.
export function surface(
  tier: Tier,
  opts: {
    color: number
    map?: THREE.Texture
    roughness?: number
    side?: THREE.Side
    flatShading?: boolean
  },
): THREE.Material {
  const base = {
    color: opts.color,
    map: opts.map,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
  }
  return tier === 'high'
    ? new THREE.MeshStandardMaterial({ ...base, roughness: opts.roughness ?? 0.9, metalness: 0 })
    : new THREE.MeshLambertMaterial(base)
}
```

Add `Tier` to the imports of `scenicMeshes.ts`:

```ts
import type { Tier } from './scenicQuality'
```

- [ ] **Step 2: Build the material table from the factories in `src/Scenic3D.vue`**

Replace the `flat`/`mat` block (lines 129-150). Textures are built at the tier's resolution and their `anisotropy` set from the renderer's capability:

```ts
function makeTextures(size: number) {
  const aniso = Math.min(4, renderer!.capabilities.getMaxAnisotropy())
  const t = {
    tartan: tartanTexture(size),
    grass: grassTexture(size, 108),
    infield: grassTexture(size, 96),
    bark: barkTexture(size),
    foliage: foliageTexture(size),
    concrete: concreteTexture(size),
  }
  for (const tex of Object.values(t)) tex.anisotropy = aniso
  t.tartan.repeat.set(1, 1)
  t.grass.repeat.set(60, 60) // one big 700 m plane, so tile it hard
  return t
}
// Task 6 deliberately left this out because nothing read it yet; it has a reader now.
let budget = TIER_BUDGET[tier]
let tex = makeTextures(budget.textureSize)

const mat = {
  trunk: surface(tier, { color: 0xffffff, map: tex.bark, roughness: 0.95 }),
  crown1: surface(tier, { color: 0xffffff, map: tex.foliage, roughness: 1, flatShading: true }),
  crown2: surface(tier, { color: 0xc8e0a8, map: tex.foliage, roughness: 1, flatShading: true }),
  pine: surface(tier, { color: 0x8fb890, map: tex.foliage, roughness: 1, flatShading: true }),
  rock: surface(tier, { color: 0x777d87, roughness: 0.85, flatShading: true }),
  pole: surface(tier, { color: 0x4a505b, roughness: 0.6 }),
  floodOn: new THREE.MeshBasicMaterial({ color: 0xfff2c8 }),
  kerb: surface(tier, {
    color: 0xffffff,
    map: tex.concrete,
    roughness: 0.9,
    side: THREE.DoubleSide,
  }),
  breakLine: new THREE.MeshBasicMaterial({ color: 0x3ba55d, side: THREE.DoubleSide }),
  relay: new THREE.MeshBasicMaterial({ color: 0xd8b638, side: THREE.DoubleSide }),
  hurdle: new THREE.MeshBasicMaterial({ color: 0x2e7d4f, side: THREE.DoubleSide }),
  grass: surface(tier, { color: 0xffffff, map: tex.grass, roughness: 1 }),
  // The loop ribbons reverse travel direction halfway around, so a fixed triangle
  // winding faces down on one straight and up on the other — DoubleSide instead of
  // per-segment winding gymnastics (they're flat strips only ever seen from above).
  infield: surface(tier, {
    color: 0xffffff,
    map: tex.infield,
    roughness: 1,
    side: THREE.DoubleSide,
  }),
  track: surface(tier, {
    color: 0xffffff,
    map: tex.tartan,
    roughness: 0.85,
    side: THREE.DoubleSide,
  }),
  laneLine: new THREE.MeshBasicMaterial({ color: 0xdfe4ea, side: THREE.DoubleSide }),
  finish: new THREE.MeshBasicMaterial({ color: 0xf2f5f9, side: THREE.DoubleSide }),
}
```

Note the `color: 0xffffff` on every mapped material — the map supplies the colour, and a tinted base would multiply it twice. `crown2` and `pine` keep a tint on purpose so the three foliage types stay distinguishable from one shared texture.

Add `TIER_BUDGET` to the `./scenicQuality` import (Task 6 left it out because nothing read it):

```ts
import { tierFromFrames, resolveTier, PROBE_FRAMES, TIER_BUDGET } from './scenicQuality'
```

and the mesh imports:

```ts
import {
  ribbonArrays,
  stripArrays,
  geometryFrom,
  ensureUv,
  assertSameAttributes,
  tartanTexture,
  grassTexture,
  barkTexture,
  foliageTexture,
  concreteTexture,
  surface,
} from './scenicMeshes'
```

- [ ] **Step 3: Re-generate textures on tier upgrade**

Extend `applyTier`:

```ts
function applyTier(next: Tier) {
  tier = next
  budget = TIER_BUDGET[tier]
  // regenerate at the new resolution and swap the maps in place — the materials and
  // meshes stay, only the texture objects change, so the baked geometry is untouched
  const old = tex
  tex = makeTextures(budget.textureSize)
  const remap: [THREE.Material, THREE.Texture][] = [
    [mat.trunk, tex.bark],
    [mat.crown1, tex.foliage],
    [mat.crown2, tex.foliage],
    [mat.pine, tex.foliage],
    [mat.kerb, tex.concrete],
    [mat.grass, tex.grass],
    [mat.infield, tex.infield],
    [mat.track, tex.tartan],
  ]
  for (const [m, t] of remap) {
    const mm = m as THREE.Material & { map?: THREE.Texture | null }
    mm.map = t
    mm.needsUpdate = true
  }
  Object.values(old).forEach((t) => t.dispose())
}
```

`budget` is now read, so the lint warning from Task 6 resolves.

- [ ] **Step 4: Dispose the textures**

In `cleanup`, alongside the existing disposals:

```ts
Object.values(tex).forEach((t) => t.dispose())
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: PASS.

`npm run dev`, `?demo`, 3D view. Expected: the track reads as rubber granules rather than flat red, the grass has variation, trunks are striated. Check both Settings → 3D quality → Performance and → Quality: both render, Quality is visibly sharper up close.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/scenicMeshes.ts src/Scenic3D.vue
git commit -m "feat: procedural canvas textures for the scenic track surfaces"
```

---

### Task 8: Shadows

**Files:**

- Modify: `src/scenicMeshes.ts` (blob-shadow texture)
- Modify: `src/Scenic3D.vue`

**Interfaces:**

- Consumes: `TIER_BUDGET[tier].shadowMap`; `sun`, `sunTarget` from Task 6.
- Produces: `src/scenicMeshes.ts` exporting `blobShadowTexture(size: number): THREE.CanvasTexture`.

- [ ] **Step 1: Add the blob-shadow texture to `src/scenicMeshes.ts`**

```ts
// Fallback ground contact for the cheap tier, which runs no shadow map at all: a soft
// dark disc laid under each prop. It does not track the sun — that is the honest trade.
export function blobShadowTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.45)')
  g.addColorStop(0.6, 'rgba(0,0,0,0.18)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
```

- [ ] **Step 2: Configure the shadow map in `src/Scenic3D.vue`**

After the renderer setup:

```ts
// Fixed-size shadow box re-centred on the walker each frame. Fitting it to the whole
// 400 m loop would spend nearly all the map's resolution on geometry behind you.
const SHADOW_BOX = 60 // metres either side of the camera
function enableShadows() {
  renderer!.shadowMap.enabled = true
  renderer!.shadowMap.type = THREE.PCFSoftShadowMap
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const cam = sun.shadow.camera
  cam.left = -SHADOW_BOX
  cam.right = SHADOW_BOX
  cam.top = SHADOW_BOX
  cam.bottom = -SHADOW_BOX
  cam.near = 1
  cam.far = SUN_DIST * 2
  cam.updateProjectionMatrix()
  sun.shadow.bias = -0.0006
}
```

Call it from `applyTier` and once at mount if the starting tier already allows it:

```ts
if (budget.shadowMap && !renderer!.shadowMap.enabled) enableShadows()
```

Put that line at the end of `applyTier`, and repeat it once after the initial `budget` assignment so an explicit `quality: 'high'` setting gets shadows without waiting for a probe that will never run.

- [ ] **Step 3: Set cast/receive flags**

The bake pass produces one mesh per material, so the flags go on the merged meshes. In the bake block, where merged meshes are added:

```ts
for (const [material, geoms] of byMat) {
  assertSameAttributes(geoms, material.name || material.type)
  const merged = mergeGeometries(geoms)
  geoms.forEach((g) => g.dispose())
  if (!merged) continue
  disposables.push(merged)
  const m = new THREE.Mesh(merged, material)
  // everything in the scenery ring both casts and receives; the flat painted
  // markings only receive, or their 4 cm lift casts a visible false shadow
  const painted =
    material === mat.laneLine ||
    material === mat.finish ||
    material === mat.relay ||
    material === mat.hurdle ||
    material === mat.breakLine
  m.castShadow = !painted
  m.receiveShadow = true
  scene.add(m)
}
```

And on the ground plane, which is added before the bake and is not merged:

```ts
ground.receiveShadow = true
```

- [ ] **Step 4: Add blob shadows for the cheap tier**

Where props are built (`for (const p of surroundings()) scene.add(buildProp(p))`), append a blob under each non-flood prop when the tier has no shadow map. Add to `buildProp`, just before the `return g`:

```ts
if (!TIER_BUDGET[tier].shadowMap && p.type !== 'flood') {
  const blob = new THREE.Mesh(blobGeo, blobMat)
  blob.rotation.x = -Math.PI / 2
  blob.position.y = 0.03
  blob.scale.setScalar(1.6)
  g.add(blob)
}
```

with, next to the other shared geometry:

```ts
const blobTex = blobShadowTexture(128)
const blobGeo = new THREE.PlaneGeometry(1, 1)
const blobMat = new THREE.MeshBasicMaterial({
  map: blobTex,
  transparent: true,
  depthWrite: false,
})
```

Because the blobs are decided at build time and the scene is baked once, a mid-session upgrade from low to high leaves them in place under real shadows. That is acceptable and deliberate — rebuilding the whole baked world on an upgrade is far more disruptive than a slightly dark patch, and the upgrade happens within the first two seconds. Note it in a comment so a future reader does not "fix" it.

Dispose them in `cleanup`:

```ts
blobTex.dispose()
blobGeo.dispose()
blobMat.dispose()
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: PASS.

`npm run dev`, `?demo`, 3D, Settings → 3D quality → Quality. Expected: trees cast shadows onto the grass and track, and the shadows swing round and lengthen as the walk crosses from dawn toward sunset (fastest to check by pinning Settings → 3D time of day to dawn, then sunset). On Performance, trees sit on soft dark discs instead. Confirm no shadow acne on the track band; if there is, adjust `sun.shadow.bias`, not the geometry heights.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/scenicMeshes.ts src/Scenic3D.vue
git commit -m "feat: sun shadows on the quality tier, blob shadows on the performance tier"
```

---

### Task 9: Sky bodies — sun disc, moon, stars, clouds

**Files:**

- Modify: `src/scenicMeshes.ts` (glow, star and cloud textures)
- Modify: `src/Scenic3D.vue`

**Interfaces:**

- Consumes: `skyBodies` from Task 5; `TIER_BUDGET[tier].stars` / `.clouds`.
- Produces: `src/scenicMeshes.ts` exporting `glowTexture(size)`, `starPositions(count, radius): Float32Array`, `cloudTexture(size)`.

- [ ] **Step 1: Add the factories to `src/scenicMeshes.ts`**

```ts
// soft radial disc used for both the sun (bright, additive) and the moon (pale)
export function glowTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.18)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

// Deterministic star field on the upper hemisphere of a sphere of `radius`. Points below
// about 8° elevation are skipped — they would sit inside the fog band and just smear.
export function starPositions(count: number, radius: number): Float32Array {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const azimuth = worldHash(i * 2 + 401) * Math.PI * 2
    const elevation = 0.14 + worldHash(i * 2 + 402) * (Math.PI / 2 - 0.14)
    out[i * 3] = Math.cos(azimuth) * Math.cos(elevation) * radius
    out[i * 3 + 1] = Math.sin(elevation) * radius
    out[i * 3 + 2] = Math.sin(azimuth) * Math.cos(elevation) * radius
  }
  return out
}

// fbm-ish cloud alpha: a few octaves of blurred blobs, tiled
export function cloudTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  for (let octave = 0; octave < 3; octave++) {
    const blobs = 40 >> octave
    const r = (size / 6) * (octave + 1)
    ctx.globalAlpha = 0.16 / (octave + 1)
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < blobs; i++) {
      const x = worldHash(i * 3 + octave * 97 + 501) * size
      const y = worldHash(i * 3 + octave * 97 + 502) * size
      ctx.beginPath()
      ctx.arc(x, y, r * (0.4 + worldHash(i * 3 + octave * 97 + 503)), 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
```

- [ ] **Step 2: Build the sky objects in `src/Scenic3D.vue`**

After the dome is created:

```ts
const SKY_R = 250 // just inside the 260 dome
const glowTex = glowTexture(128)
const sunSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xfff4dd,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }),
)
sunSprite.scale.setScalar(46)
const moonSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: glowTex, color: 0xcfd8ea, depthWrite: false, fog: false }),
)
moonSprite.scale.setScalar(26)
scene.add(sunSprite, moonSprite)

const starGeo = new THREE.BufferGeometry()
starGeo.setAttribute(
  'position',
  new THREE.BufferAttribute(starPositions(TIER_BUDGET[tier].stars, SKY_R), 3),
)
const starMat = new THREE.PointsMaterial({
  color: 0xdfe6ff,
  size: 1.6,
  sizeAttenuation: false,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  fog: false,
})
const stars = new THREE.Points(starGeo, starMat)
scene.add(stars)

// clouds: a second dome shell just inside the sky dome, high tier only
let clouds: THREE.Mesh | null = null
let cloudTex: THREE.CanvasTexture | null = null
function addClouds() {
  if (clouds) return
  cloudTex = cloudTexture(512)
  cloudTex.repeat.set(3, 2)
  const g = new THREE.SphereGeometry(248, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2.2)
  clouds = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.5,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  )
  disposables.push(g)
  scene.add(clouds)
}
if (TIER_BUDGET[tier].clouds) addClouds()
```

Add `addClouds()` and a star-count rebuild to `applyTier`:

```ts
if (budget.clouds) addClouds()
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions(budget.stars, SKY_R), 3))
```

The sprites, points and cloud shell must be excluded from the bake, which currently keeps only `dome` and lights. Extend that filter:

```ts
const skyObjects: THREE.Object3D[] = [dome, sunSprite, moonSprite, stars]
if (clouds) skyObjects.push(clouds)
const staticRoots = scene.children.filter(
  (c) => !skyObjects.includes(c) && !(c as THREE.Light).isLight && c !== sunTarget,
)
```

This is easy to get wrong: leaving a sprite in `staticRoots` bakes it into a merged mesh and it disappears. Verify visually in Step 4.

- [ ] **Step 3: Drive them per frame**

In `update(d)`, after the `bodies` block from Task 6:

```ts
const place = (o: THREE.Object3D, b: { azimuth: number; elevation: number }) => {
  o.position.set(
    camera.position.x + Math.cos(b.azimuth) * Math.cos(b.elevation) * SKY_R,
    Math.sin(b.elevation) * SKY_R,
    camera.position.z + Math.sin(b.azimuth) * Math.cos(b.elevation) * SKY_R,
  )
}
place(sunSprite, bodies.sun)
place(moonSprite, bodies.moon)
sunSprite.visible = bodies.sun.visible
moonSprite.visible = bodies.moon.visible
starMat.opacity = bodies.starOpacity
stars.visible = bodies.starOpacity > 0.01
stars.position.set(camera.position.x, 0, camera.position.z)
if (clouds) {
  clouds.position.set(camera.position.x, 0, camera.position.z)
  clouds.rotation.y = d * 0.0004 // drift with walked distance, like everything else
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: PASS.

`npm run dev`, `?demo`, 3D. Walk through Settings → 3D time of day: **dawn** shows a low sun near the horizon, **day** a high one, **sunset** low on the other side, **night** the moon plus stars and no sun. On Quality, clouds drift overhead; on Performance there are none. Confirm nothing vanished after the bake — sun, moon and stars must all still be present, which is the failure mode of getting the `staticRoots` filter wrong.

- [ ] **Step 5: Dispose**

In `cleanup`:

```ts
glowTex.dispose()
sunSprite.material.dispose()
moonSprite.material.dispose()
starGeo.dispose()
starMat.dispose()
cloudTex?.dispose()
;(clouds?.material as THREE.Material | undefined)?.dispose()
```

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/scenicMeshes.ts src/Scenic3D.vue
git commit -m "feat: sun disc, moon, stars and drifting clouds in the scenic sky"
```

---

### Task 10: Bright palette and HUD legibility

The last task, because it is the one that needs everything else in place to judge.

**Files:**

- Modify: `src/scenicSky.ts` (`SKY_KEYS`)
- Modify: `src/scenicSky.test.ts` (one added case)
- Modify: `src/App.vue` (HUD scrim, canvas vignette)
- Regenerate: `e2e/smoke.spec.ts-snapshots/wizard.png` (only if it actually shifted)

**Interfaces:**

- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `src/scenicSky.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicSky.test.ts`
Expected: FAIL — `expected 1.1 to be greater than 2`.

- [ ] **Step 3: Re-author `SKY_KEYS`**

In `src/scenicSky.ts`, replace the keyframe table. Update its leading comment too — the old one explained the muting, which is no longer the policy:

```ts
// Keyframes around the cycle; lerped between. Authored at real outdoor brightness for
// ACES tone mapping (which compresses the highlights), rather than the muted values the
// old un-tone-mapped renderer needed to avoid clashing with the dark app chrome. That
// clash is now handled where it belongs — the HUD pills carry their own scrim and the
// canvas has a vignette (App.vue) — instead of by dimming the world.
const SKY_KEYS: SkyKey[] = [
  { at: 0.0, sky: 0x54486a, fog: 0xa8788a, sunIntensity: 1.6, sunColor: 0xffb08a, ambient: 0.8 }, // dawn
  { at: 0.18, sky: 0x5f95d6, fog: 0xa8c4e0, sunIntensity: 2.3, sunColor: 0xfff2dd, ambient: 1.1 }, // morning
  { at: 0.45, sky: 0x6ba8e8, fog: 0xb9d4ee, sunIntensity: 2.6, sunColor: 0xffffff, ambient: 1.2 }, // day
  { at: 0.62, sky: 0x6b8fc4, fog: 0xc0a9a8, sunIntensity: 2.1, sunColor: 0xffe0b0, ambient: 1.0 }, // late
  { at: 0.75, sky: 0x6d4270, fog: 0xc4707a, sunIntensity: 1.3, sunColor: 0xff9a5c, ambient: 0.7 }, // sunset
  { at: 0.87, sky: 0x161a2e, fog: 0x24283c, sunIntensity: 0.2, sunColor: 0x9ab0ff, ambient: 0.3 }, // night
  { at: 1.0, sky: 0x54486a, fog: 0xa8788a, sunIntensity: 1.6, sunColor: 0xffb08a, ambient: 0.8 }, // wraps to dawn
]
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, including the pre-existing `skyAt` cases from Task 1 (day is still brighter than night, the wrap still matches dawn).

- [ ] **Step 5: Retune the HUD in `src/App.vue`**

Add a vignette over the 3D canvas. In the `.scene3d-wrap` rule (line 1959), add a pseudo-element:

```css
.scene3d-wrap {
  position: relative;
}
/* A bright sky is now possible (render-quality slice 1), so the HUD needs its own
   contrast rather than relying on a dim world. Darkens only the top and bottom bands,
   where the header stats and the control pill sit. */
.scene3d-wrap::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    rgba(8, 10, 14, 0.42) 0%,
    rgba(8, 10, 14, 0) 22%,
    rgba(8, 10, 14, 0) 72%,
    rgba(8, 10, 14, 0.5) 100%
  );
}
```

Then find the `.imm-*` HUD pill rules in the immersive block (from line 2667) and raise the scrim: wherever a pill sets a translucent dark `background`, increase its alpha by roughly 0.15 (for example `rgba(18, 21, 27, 0.55)` becomes `rgba(18, 21, 27, 0.7)`). Do not restyle the pills otherwise — this is a contrast fix, not a redesign.

- [ ] **Step 6: Judge it on real hardware**

This is not automatable and is the risk the spec called out. `npm run dev`, `?demo`, 3D view, and step through all four fixed times of day with a workout running so the `.imm-workout` ribbon is populated. Every HUD number must be readable at each of dawn, day, sunset and night. If day is too bright, lower `renderer.toneMappingExposure` toward 0.85 rather than dimming `SKY_KEYS` again — exposure is one number and does not undo the palette work.

- [ ] **Step 7: Regenerate the e2e baseline if it shifted**

Run: `npm run e2e`

If `wizard.png` fails, the scrim change reached the wizard screen. Regenerate in the pinned container — **never on the host or inside the devcontainer**, whose fonts differ from CI:

```bash
docker run --rm -v "$PWD":/work -w /work -e CI=1 mcr.microsoft.com/playwright:v1.61.1-noble \
  bash -c "npm ci && npm run e2e:update"
```

Then re-run `npm run e2e` to confirm green. If `wizard.png` passed the first time, skip this step and do not regenerate — an unnecessary baseline churn is noise in the diff.

- [ ] **Step 8: Full verification and commit**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run e2e`
Expected: all PASS, including the bundle-size guard.

```bash
npm run format
git add src/scenicSky.ts src/scenicSky.test.ts src/App.vue e2e
git commit -m "feat: bright daylight palette with a retuned hud scrim"
```

---

### Task 11: Update `CLAUDE.md`

The scenic paragraph in `CLAUDE.md` describes the architecture this slice changed. Leaving it stale is how the next person reintroduces the UV bug.

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Layout section**

Add entries for the four new modules next to the existing `src/scenic.ts` bullet, matching the surrounding style:

- `src/scenicSky.ts` — day/night cycle, weather, palette and `skyBodies()` (sun/moon position, star opacity), split out of `scenic.ts`. Unit-tested in `src/scenicSky.test.ts`.
- `src/scenicQuality.ts` — adaptive quality tiers: a median-of-60-frames probe picks `low`/`high`, `walkfit.scenic.quality` overrides it. Gates shadows, texture size, star count, clouds, and (slice 3) pacer count.
- `src/scenicMeshes.ts` — pure vertex/uv/index array builders plus the three.js mesh and procedural `CanvasTexture` factories, extracted from `Scenic3D.vue`.

- [ ] **Step 2: Rewrite the UV sentence in the scenic paragraph**

The paragraph currently explains the loop-ribbon materials and the bake. Add, in the same voice:

> Every geometry builder emits UVs and the bake pass **fills in zeros** for anything missing them (`ensureUv`) — it used to do the opposite, deleting `uv` from the primitives so `mergeGeometries` would accept a mixed batch, which textured surfaces cannot live with. `assertSameAttributes` throws on a mismatched batch, because a silent merge of disagreeing attribute sets renders as corruption rather than an error.

- [ ] **Step 3: Add the new localStorage key**

Add `walkfit.scenic.quality` (`auto` | `low` | `high`) to the `localStorage` keys list, next to `walkfit.scenic.time`.

- [ ] **Step 4: Commit**

```bash
npm run format
git add CLAUDE.md
git commit -m "docs: record the scenic render-quality architecture in CLAUDE.md"
```

---

## Definition of done

- The 3D view is tone-mapped, textured and shadowed on a desktop; textured with blob shadows on a phone.
- Dawn and sunset cast visibly raking shadows across the track.
- Sun, moon, stars and (on Quality) clouds are in the sky, at the right times.
- Settings → Display offers Auto / Performance / Quality, persisted.
- HUD text is legible against every time of day.
- `npm run lint`, `format:check`, `typecheck`, `test`, `build`, the bundle-size guard and `npm run e2e` all pass.
- No new dependency in `package.json`.
