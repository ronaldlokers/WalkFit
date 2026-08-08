# Scenic Club-Track Venue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn WalkFit's 3D track from a ring in a void into a place someone could walk to — one covered grandstand on the home straight, a perimeter fence, a clubhouse, real athletics furniture on the infield, flags, and a skyline on the horizon.

**Architecture:** A new pure module `src/scenicVenue.ts` returns venue parts in the same `{type, s, o, ...}` shape `surroundings()` already uses, so the component's existing prop builder and merge-by-material bake absorb them with no special-casing. `Scenic3D.vue` gains one builder branch per part type. Everything is static, so it all goes through the bake and costs a handful of draw calls.

**Tech Stack:** Vue 3 `<script setup lang="ts">`, TypeScript strict, three.js 0.185, Vitest.

## Global Constraints

- **No new dependencies.** All geometry is generated; every texture is a runtime `CanvasTexture`. No asset files, so the offline PWA precache is unaffected.
- **Bundle guard:** `scripts/check-bundle-size.mjs` fails if the main chunk exceeds 250 kB. three.js must stay in the lazy `Scenic3D` chunk. `src/scenicVenue.ts` must stay three-free.
- **Prettier:** no semicolons, single quotes, print width 100.
- **Extensionless relative imports** (`from './scenic'`).
- **TypeScript strict.** No `any`.
- **Conventional commits**, lowercase imperative subject. **Never commit to `main`.**
- **Every commit must pass** `npm run lint && npm run format:check && npm run typecheck && npm test`.
- `npm run build` may fail with EACCES — `test-results/` is root-owned from an earlier container run. Do NOT sudo; build with `npx vite build --outDir /tmp/wf-venue` and report the main chunk size.
- **Spec:** `docs/superpowers/specs/2026-08-07-scenic-realism-2-venue-design.md`.
- Baseline: **254 tests**, `main` at `a43ae01`.

## Hard-won constraints from slices 1 and 3 — read before writing any code

These each cost a fix round. They are not style preferences.

1. **Everything static must be added to the scene BEFORE the bake block**, which merges by material and removes the source objects. Live objects (pacers, rabbit, avatar, sky) are added after it. Venue parts are static, so they go **before** — same place `surroundings()` is consumed today.
2. **A comment that describes intent is not a test.** Nearly every defect in the previous two slices was a comment asserting one thing while the arithmetic underneath did another. Where this plan states a geometric property (a clearance, a footprint), there is a test pinning it.
3. **Texture `u` repeats must divide the thing they tile**, or the pattern misaligns at the seam. `REPEAT` values divide `LAP_M`; a fence ribbon around the loop obeys the same rule.
4. **`ribbonArrays` spans `v` from 0 to 1 across a ribbon's width regardless of width.** If you tile a ribbon texture, scale `v` by the real width via `texture.repeat.set(1, width / repeatMetres)` or it smears.

## File Structure

| File                      | Status | Responsibility                                             |
| ------------------------- | ------ | ---------------------------------------------------------- |
| `src/scenicVenue.ts`      | create | Pure: where every venue part sits. **No three.js import.** |
| `src/scenicVenue.test.ts` | create | Tests for the above.                                       |
| `src/scenicMeshes.ts`     | modify | Add the venue's procedural textures.                       |
| `src/Scenic3D.vue`        | modify | Build the venue parts into meshes, before the bake.        |
| `CLAUDE.md`               | modify | Record the module and its invariants.                      |

---

### Task 1: The venue layout (`scenicVenue.ts`)

**Files:**

- Create: `src/scenicVenue.ts`
- Create: `src/scenicVenue.test.ts`

**Interfaces:**

- Consumes: `TRACK_IN`, `TRACK_OUT`, `LAP_M`, `STRAIGHT_M`, `worldHash` from `./scenic`.
- Produces: `type VenueType`, `interface VenuePart`, `stadium(): VenuePart[]`, plus the placement constants `STAND_S0`, `STAND_S1`, `STAND_O`, `FENCE_O`, `GATE_S0`, `GATE_S1`, `SKYLINE_R`.

- [ ] **Step 1: Write the failing test**

Create `src/scenicVenue.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stadium, STAND_O, FENCE_O, GATE_S0, GATE_S1, SKYLINE_R } from './scenicVenue'
import { TRACK_IN, TRACK_OUT, LAP_M } from './scenic'

describe('stadium', () => {
  it('is deterministic', () => {
    expect(stadium()).toEqual(stadium())
  })

  it('never puts anything on the track', () => {
    // the track band is [TRACK_IN, TRACK_OUT]; infield furniture is inside TRACK_IN,
    // everything else is outside TRACK_OUT. Nothing may sit in the running lanes.
    for (const p of stadium()) {
      const onTrack = p.o > TRACK_IN && p.o < TRACK_OUT
      expect(`${p.type} at o=${p.o.toFixed(2)}`).toBe(
        onTrack ? `${p.type} must not sit on the track` : `${p.type} at o=${p.o.toFixed(2)}`,
      )
    }
  })

  it('keeps the grandstand clear of the track and inside the fence', () => {
    const stand = stadium().find((p) => p.type === 'stand')!
    expect(stand.o).toBeGreaterThan(TRACK_OUT)
    expect(STAND_O).toBeLessThan(FENCE_O)
  })

  it('puts every infield part inside the inner kerb', () => {
    const infield = stadium().filter((p) => p.o < TRACK_IN)
    expect(infield.length).toBeGreaterThan(0)
    for (const p of infield) {
      expect(`${p.type} at o=${p.o.toFixed(2)}`).toBe(
        p.o < TRACK_IN ? `${p.type} at o=${p.o.toFixed(2)}` : `${p.type} must be inside the kerb`,
      )
    }
  })

  it('opens the fence gate away from the grandstand', () => {
    // walking through a gate that is behind the stand would be invisible; more to the
    // point, a gate cut where the stand sits would clip through it
    const stand = stadium().find((p) => p.type === 'stand')!
    const standEnd = stand.s + stand.span!
    const overlaps = GATE_S0 < standEnd && GATE_S1 > stand.s
    expect(`gate ${GATE_S0}-${GATE_S1} vs stand ${stand.s}-${standEnd}`).toBe(
      overlaps
        ? 'gate must not overlap the stand'
        : `gate ${GATE_S0}-${GATE_S1} vs stand ${stand.s}-${standEnd}`,
    )
  })

  it('puts the skyline beyond everything else', () => {
    for (const p of stadium()) expect(SKYLINE_R).toBeGreaterThan(p.o)
  })

  it('gives every swept part a positive span that fits inside the lap', () => {
    for (const p of stadium()) {
      if (p.span === undefined) continue
      expect(p.span).toBeGreaterThan(0)
      expect(p.span).toBeLessThanOrEqual(LAP_M)
    }
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/scenicVenue.test.ts`
Expected: FAIL — cannot resolve `./scenicVenue`.

- [ ] **Step 3: Write the implementation**

Create `src/scenicVenue.ts`:

```ts
// Where the club track's furniture sits. Pure and three.js-free, like its siblings:
// Scenic3D.vue turns these answers into meshes, and everything here is STATIC, so it all
// flows through the component's merge-by-material bake and costs a handful of draw calls.
//
// Scale is deliberately a club track, not a stadium bowl: one covered stand on the home
// straight, and open horizon on the other three sides so the day/night sky and the
// existing scenery ring stay visible.
import { TRACK_IN, TRACK_OUT, STRAIGHT_M, LAP_M, BEND_R, worldHash } from './scenic'

export type VenueType =
  | 'stand'
  | 'fence'
  | 'fencePost'
  | 'clubhouse'
  | 'flagpole'
  | 'pitch'
  | 'jumpPit'
  | 'jumpRunway'
  | 'highJump'
  | 'shotCircle'
  | 'skyline'

export interface VenuePart {
  type: VenueType
  s: number // arc position along the loop
  o: number // lateral offset; positive is outward, negative is into the infield
  scale: number
  seed: number
  span?: number // arc length, for parts swept along the track (stand, fence)
}

// The midpoint of the back straight, directly opposite the stand. Derived from the track
// geometry rather than hardcoded — an earlier slice shipped duplicated constants twice.
const BACK_STRAIGHT_MID = STRAIGHT_M + Math.PI * BEND_R + STRAIGHT_M / 2

// The home straight runs s = 0 to STRAIGHT_M. The stand covers it, inset a little at
// each end so it does not run into the bends.
export const STAND_S0 = 4
export const STAND_S1 = STRAIGHT_M - 4
export const STAND_O = TRACK_OUT + 6
// Fence sits outside the stand, with a gate cut on the far side of the loop.
export const FENCE_O = TRACK_OUT + 14
export const GATE_S0 = BACK_STRAIGHT_MID + 10
export const GATE_S1 = BACK_STRAIGHT_MID + 26
// Distant silhouette ring. Beyond the fog in mist, which is correct — it should fade.
export const SKYLINE_R = 400

export function stadium(): VenuePart[] {
  const out: VenuePart[] = []
  const part = (type: VenueType, s: number, o: number, seed = 0, span?: number): void => {
    out.push({ type, s, o, scale: 1, seed, span })
  }

  // --- outside the track ---
  part('stand', STAND_S0, STAND_O, 0, STAND_S1 - STAND_S0)
  part('clubhouse', STAND_S0 + 20, STAND_O + 12)
  for (let i = 0; i < 3; i++) {
    part('flagpole', STAND_S0 + 14 + i * 3, STAND_O + 9, worldHash(i * 13 + 5))
  }
  part('fence', 0, FENCE_O, 0, LAP_M)
  // posts every 4 m, skipping the gate
  for (let s = 0; s < LAP_M; s += 4) {
    if (s >= GATE_S0 && s <= GATE_S1) continue
    part('fencePost', s, FENCE_O, worldHash(s))
  }
  part('skyline', 0, SKYLINE_R)

  // --- infield furniture, all inside the kerb ---
  part('pitch', 0, TRACK_IN - 22)
  part('jumpRunway', STAND_S0 + 30, TRACK_IN - 4)
  part('jumpPit', STAND_S0 + 30, TRACK_IN - 12)
  part('highJump', BACK_STRAIGHT_MID - 20, TRACK_IN - 8)
  part('shotCircle', BACK_STRAIGHT_MID + 6, TRACK_IN - 6)

  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/scenicVenue.test.ts`
Expected: PASS, 7 tests. Suite total 254 → 261.

If the "never puts anything on the track" case fails, move the offending part — do not relax the assertion. Nothing may sit in the running lanes.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/scenicVenue.ts src/scenicVenue.test.ts
git commit -m "feat: club track venue layout"
```

---

### Task 2: Venue textures

**Files:**

- Modify: `src/scenicMeshes.ts`

**Interfaces:**

- Consumes: the existing `canvas()`/`finish()` helpers and `worldHash`.
- Produces: `chainLinkTexture(size)`, `seatingTexture(size)`, `pitchLinesTexture(size)`, `skylineTexture(size)`, `sandTexture(size)`.

- [ ] **Step 1: Add the factories**

Append to `src/scenicMeshes.ts`, next to the other texture factories. Each uses the file's existing `canvas()` and `finish()` helpers — read them first; `finish()` sets `RepeatWrapping` and `SRGBColorSpace`.

```ts
// Chain-link: an alpha texture, so the fence reads as mesh rather than a wall.
export function chainLinkTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(150, 158, 170, 0.85)'
  ctx.lineWidth = Math.max(1, size / 128)
  const cell = size / 8
  for (let i = -8; i < 16; i++) {
    ctx.beginPath()
    ctx.moveTo(i * cell, 0)
    ctx.lineTo(i * cell + size, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(i * cell, size)
    ctx.lineTo(i * cell + size, 0)
    ctx.stroke()
  }
  return finish(c)
}

// Stepped terracing with seat rows — read at a distance, so bands rather than seats.
export function seatingTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#8d93a0'
  ctx.fillRect(0, 0, size, size)
  const rows = 8
  for (let r = 0; r < rows; r++) {
    const y = (r / rows) * size
    ctx.fillStyle = r % 2 === 0 ? '#3f6fa8' : '#4a7cb8'
    ctx.fillRect(0, y, size, (size / rows) * 0.62)
    ctx.fillStyle = 'rgba(30, 36, 46, 0.35)'
    ctx.fillRect(0, y + (size / rows) * 0.62, size, Math.max(1, size / 128))
  }
  return finish(c)
}

// Football pitch markings: touchlines, halfway, centre circle, two penalty boxes.
export function pitchLinesTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#2f5230'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(236, 242, 248, 0.8)'
  ctx.lineWidth = Math.max(2, size / 200)
  const m = size * 0.06
  ctx.strokeRect(m, m, size - 2 * m, size - 2 * m)
  ctx.beginPath()
  ctx.moveTo(m, size / 2)
  ctx.lineTo(size - m, size / 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * 0.12, 0, Math.PI * 2)
  ctx.stroke()
  const bw = size * 0.34
  const bh = size * 0.14
  ctx.strokeRect(size / 2 - bw / 2, m, bw, bh)
  ctx.strokeRect(size / 2 - bw / 2, size - m - bh, bw, bh)
  return finish(c)
}

// Rooftop silhouette for the distant ring — alpha above the roofline so sky shows through.
export function skylineTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = '#39414f'
  let x = 0
  let i = 0
  while (x < size) {
    const w = size * (0.02 + worldHash(i * 7 + 3) * 0.05)
    const h = size * (0.25 + worldHash(i * 7 + 4) * 0.5)
    ctx.fillRect(x, size - h, w, h)
    x += w
    i++
  }
  return finish(c)
}

// Long-jump sand.
export function sandTexture(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size)
  ctx.fillStyle = '#cbb68c'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < size * size * 0.05; i++) {
    ctx.fillStyle = `rgba(150, 132, 96, ${0.1 + worldHash(i + 71) * 0.15})`
    ctx.fillRect(worldHash(i * 2 + 72) * size, worldHash(i * 2 + 73) * size, 2, 2)
  }
  return finish(c)
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS, suite unchanged at 261 (no new tests here — these are three.js-dependent factories, verified visually in Task 3).

- [ ] **Step 3: Commit**

```bash
npm run format
git add src/scenicMeshes.ts
git commit -m "feat: procedural textures for the club track venue"
```

---

### Task 3: Build the venue

**Files:**

- Modify: `src/Scenic3D.vue`

**Interfaces:**

- Consumes: `stadium`, `VenuePart` from `./scenicVenue`; the Task 2 textures; `trackPoint`, `TRACK_IN`, `LAP_M` from `./scenic`; `surface` and `geometryFrom` from `./scenicMeshes`.
- Produces: nothing new.

- [ ] **Step 1: Add the venue textures and materials**

Extend `makeTextures` with the five new textures, at the tier's `size` like the others, EXCEPT the pitch markings which are always 1024 — at 256 px across a 100 m plane they are mush, and this is the one surface where physical scale makes the tier's texture budget unusable:

```ts
      chainLink: chainLinkTexture(size),
      seating: seatingTexture(size),
      pitchLines: pitchLinesTexture(1024), // always 1024: see above
      skyline: skylineTexture(size),
      sand: sandTexture(size),
```

and add them to `applyTier`'s `remap` list so a tier change swaps them too, EXCEPT `pitchLines` which never changes resolution — leave it out of `remap` and out of the regeneration, or it will be disposed and replaced by a 1024 copy pointlessly on every toggle. Add a comment saying why it is exempt.

Add materials next to the existing table:

```ts
    seating: surface({ color: 0xffffff, map: tex.seating, roughness: 0.9 }),
    fence: new THREE.MeshBasicMaterial({
      map: tex.chainLink,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false, // a mesh fence must not occlude what is behind it
    }),
    clubhouse: surface({ color: 0xd8cfc0, roughness: 0.85 }),
    roof: surface({ color: 0x7a4b3a, roughness: 0.8 }),
    pitch: surface({ color: 0xffffff, map: tex.pitchLines, roughness: 1, side: THREE.DoubleSide }),
    sand: surface({ color: 0xffffff, map: tex.sand, roughness: 1, side: THREE.DoubleSide }),
    mat: surface({ color: 0x2f5fa8, roughness: 0.9, side: THREE.DoubleSide }),
    skylineMat: new THREE.MeshBasicMaterial({
      map: tex.skyline,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: true, // it SHOULD fade into the distance — that is the depth cue
    }),
```

Note `fence` and `skylineMat` are `MeshBasicMaterial`, so they are unlit — correct for a distant silhouette and for thin mesh, both of which look wrong when shaded.

- [ ] **Step 2: Hoist the part sizes into `scenicVenue.ts` first**

Task 1's test carries a `sizes` table giving each infield part's `[widthAcrossTrack, lengthAlongTrack]`, and this task is about to build meshes to those same dimensions. Two literal copies in two files, agreeing only by convention, is exactly the drift the module's own `BACK_STRAIGHT_MID` comment warns about — if the renderer sizes the pitch differently, the footprint test keeps passing against stale numbers and says nothing.

Export one source of truth from `src/scenicVenue.ts`:

```ts
// Footprint of each sized part, as [widthAcrossTrack, lengthAlongTrack] in metres. The
// renderer builds meshes to these and scenicVenue.test.ts checks them against the kerb —
// one table, so a resize cannot pass the test while changing what is drawn.
export const PART_SIZES: Partial<Record<VenueType, [number, number]>> = {
  pitch: [40, 64],
  jumpRunway: [1.3, 30],
  jumpPit: [3, 8],
  highJump: [10, 8],
  shotCircle: [2.14, 2.14],
}
```

Update `src/scenicVenue.test.ts` to import `PART_SIZES` and delete its local copy — the test must keep passing unchanged otherwise. Then use it for every sized mesh below rather than repeating the numbers, e.g. `new THREE.PlaneGeometry(...PART_SIZES.pitch!)` with the plane's width argument taking the across-track figure.

Note `PlaneGeometry(width, height)` lays width along x and height along y; after `rotation.x = -Math.PI / 2` the height ends up along z. So `PlaneGeometry(across, along)` is the correct argument order once the plane is laid flat — confirm that against what you see rather than trusting it.

- [ ] **Step 3: Build each part**

Add a `buildVenue(p: VenuePart)` function next to `buildProp`, and call it for every part BEFORE the bake block — right after the `surroundings()` loop:

```ts
for (const p of stadium()) scene.add(buildVenue(p))
```

`buildVenue` itself:

```ts
// Static venue furniture. Added BEFORE the bake, like the scenery ring — these never
// move, so they merge by material and cost a handful of draw calls between them.
function buildVenue(p: VenuePart): THREE.Object3D {
  const g = new THREE.Group()
  const at = trackPoint(p.s, p.o)

  if (p.type === 'stand') {
    // Eight stepped rows swept along the home straight. Built as a box per row rather
    // than an extruded profile: the straight is straight, so boxes are exact here and
    // far simpler than sampling the loop.
    const len = p.span!
    const rows = 8
    for (let r = 0; r < rows; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.45, len), mat.seating)
      // set x directly rather than translateX — translate is applied in the object's
      // own rotated frame, and this group gets rotated to face the track below
      step.position.set(r * 1.1, 0.22 + r * 0.45, 0)
      g.add(step)
    }
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.2, len), mat.clubhouse)
    backWall.position.set(rows * 1.1, 2.1, 0)
    g.add(backWall)
    const roof = new THREE.Mesh(new THREE.BoxGeometry(rows * 1.2, 0.25, len), mat.roof)
    roof.position.set(rows * 0.55, 5.4, 0)
    g.add(roof)
    for (let i = 0; i < 4; i++) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 5.3, 6), mat.clubhouse)
      col.position.set(0, 2.65, -len / 2 + (len * (i + 0.5)) / 4)
      g.add(col)
    }
    // sweep it along the straight: the home straight runs from s=0 toward -z at x = +R
    const mid = trackPoint(p.s + len / 2, p.o)
    g.position.set(mid.x, 0, mid.z)
    g.rotation.y = Math.atan2(-mid.tx, -mid.tz)
  } else if (p.type === 'fence') {
    // A vertical loop ribbon, 2 m tall. NOT ribbonArrays — that builds a FLAT ribbon
    // between two lateral offsets, and a fence needs its second edge lifted in y, not
    // pushed sideways. LAP_M / 4 = 100, a whole number, so the chain-link meets itself
    // at the seam.
    const pts: number[] = []
    const uv: number[] = []
    const idx: number[] = []
    const step = 2
    const n = Math.ceil(LAP_M / step)
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * LAP_M
      const a = trackPoint(s, p.o)
      pts.push(a.x, 0, a.z, a.x, 2, a.z)
      const u = s / 4
      uv.push(u, 0, u, 1)
      if (i > 0) {
        const k = (i - 1) * 2
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
      }
    }
    g.add(new THREE.Mesh(geometryFrom({ position: pts, uv, index: idx }), mat.fence))
  } else if (p.type === 'fencePost') {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.1, 5), mat.pole)
    post.position.set(at.x, 1.05, at.z)
    g.add(post)
  } else if (p.type === 'clubhouse') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(9, 3.4, 6), mat.clubhouse)
    body.position.set(at.x, 1.7, at.z)
    const roof = new THREE.Mesh(new THREE.ConeGeometry(7, 2, 4), mat.roof)
    roof.position.set(at.x, 4.4, at.z)
    roof.rotation.y = Math.PI / 4
    g.add(body, roof)
  } else if (p.type === 'flagpole') {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7, 5), mat.pole)
    pole.position.set(at.x, 3.5, at.z)
    g.add(pole)
  } else if (p.type === 'pitch') {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(64, 40), mat.pitch)
    plane.rotation.x = -Math.PI / 2
    plane.position.set(at.x, 0.01, at.z)
    g.add(plane)
  } else if (p.type === 'jumpRunway') {
    const run = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 30), mat.track)
    run.rotation.x = -Math.PI / 2
    run.position.set(at.x, 0.012, at.z)
    run.rotation.z = Math.atan2(-at.tx, -at.tz)
    g.add(run)
  } else if (p.type === 'jumpPit') {
    const pit = new THREE.Mesh(new THREE.PlaneGeometry(3, 8), mat.sand)
    pit.rotation.x = -Math.PI / 2
    pit.position.set(at.x, 0.012, at.z)
    pit.rotation.z = Math.atan2(-at.tx, -at.tz)
    g.add(pit)
  } else if (p.type === 'highJump') {
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(10, 8), mat.track)
    apron.rotation.x = -Math.PI / 2
    apron.position.set(at.x, 0.012, at.z)
    const bed = new THREE.Mesh(new THREE.BoxGeometry(5, 0.6, 3), mat.mat)
    bed.position.set(at.x, 0.3, at.z)
    g.add(apron, bed)
  } else if (p.type === 'shotCircle') {
    const ring = new THREE.Mesh(new THREE.CircleGeometry(1.07, 20), mat.kerb)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(at.x, 0.013, at.z)
    g.add(ring)
  } else {
    // skyline: one cylinder shell at the horizon, alpha-cut to a rooftop profile
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(p.o, p.o, 55, 48, 1, true),
      mat.skylineMat,
    )
    shell.position.set(0, 20, 0)
    g.add(shell)
  }
  return g
}
```

Set the fence texture's repeat so the chain-link tiles at a sane physical scale and does not smear vertically:

```ts
tex.chainLink.repeat.set(1, 2 / 4) // v spans the 2 m height at 4 m per u repeat
```

`LAP_M / 4 = 100`, a whole number, so the pattern meets itself at the seam.

- [ ] **Step 4: Verify the bake still holds**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS, 261.

Then `npm run dev`, `http://localhost:5173/?demo`, 3D view. Expected:

- A covered grandstand along the home straight, on your right as you walk it.
- A clubhouse behind it and three flagpoles beside it.
- A chain-link fence around the whole loop with a visible gate gap on the back straight.
- The infield reads as an athletics infield: pitch markings, a long-jump runway and sand pit, a high-jump apron and mat, a shot circle.
- A rooftop skyline on the horizon.
- **Draw calls must stay in the low tens.** Measure `renderer.info.render.calls` with a temporary log and report it; the venue should add no more than about 6. If it jumped into the hundreds, a venue material is escaping the bake — check every new material is shared rather than created per part. Remove the log before committing.
- Confirm the existing scenery ring is still visible on the bends and the back straight, rather than looking deleted behind the stand.

Save a screenshot of the grandstand from the home straight to:
`.superpowers/sdd/2026-08-07-scenic-venue/task-3-stand.png`

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/Scenic3D.vue
git commit -m "feat: build the club track venue"
```

---

### Task 4: Update `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the module to the Layout section**

Next to the other `scenic*` entries, matching their voice:

- `src/scenicVenue.ts` — **pure, three.js-free** club-track furniture: `stadium()` returns parts in the same shape `surroundings()` uses, so the component's prop builder and merge-by-material bake absorb them unchanged. Nothing may sit between `TRACK_IN` and `TRACK_OUT` (the running lanes) — a test pins it. Unit-tested in `src/scenicVenue.test.ts`.

- [ ] **Step 2: Add a line to the scenic paragraph**

> The venue is a **club track, not a stadium bowl**: one covered stand on the home straight, with open horizon on the other three sides so the day/night sky and the scenery ring stay visible. A closed bowl would occlude both. Venue parts are STATIC and so are added BEFORE the bake block, unlike the pacers, rabbit and avatar, which move and must be added after it.

- [ ] **Step 3: Commit**

```bash
npm run format
git add CLAUDE.md
git commit -m "docs: record the scenic venue module in CLAUDE.md"
```

---

## Definition of done

- Walking the home straight, a grandstand stands to the right with a clubhouse and flags behind it.
- A fence rings the track with one gate gap.
- The infield reads as an athletics infield rather than a green disc.
- A skyline sits on the horizon and fades correctly in mist.
- Draw calls after the bake rose by no more than ~6.
- Nothing sits in the running lanes.
- `lint`, `format:check`, `typecheck`, `test` and a scratch-dir `build` all pass; main chunk stays near 206 kB.
- No new dependency; `src/scenicVenue.ts` contains no three.js import.
