# Scenic realism slice 2 — club track venue

Date: 2026-08-07
Status: approved, awaiting implementation plan
Parent: `2026-08-07-scenic-realism-0-overview-design.md`
Depends on: slice 1 (materials, texture factories, `scenicMeshes.ts`, tiers)

## Goal

The track stops being a ring in a void and becomes a place someone could walk to.
Scale is a **club track, not a stadium bowl**: one covered grandstand on the home
straight, a perimeter fence, a clubhouse, real infield furniture, and a distant
skyline. The horizon stays open on three sides so the day/night cycle and the
existing scenery ring remain visible — a closed bowl would occlude both and make
slice 1's sky work invisible.

## Design

### `scenicVenue.ts`

A new pure module exporting `stadium()`, returning props in the **same shape**
`surroundings()` already returns, so the existing prop builder and the
merge-by-material bake absorb them with no special-casing:

```ts
export type VenueType =
  | 'stand'
  | 'fence'
  | 'fencePost'
  | 'clubhouse'
  | 'flagpole'
  | 'pitchLines'
  | 'jumpPit'
  | 'jumpRunway'
  | 'highJump'
  | 'shotCircle'
  | 'skyline'

export interface VenuePart {
  type: VenueType
  s: number // arc position along the loop
  o: number // lateral offset (positive = outside the track)
  scale: number
  seed: number
  span?: number // arc length for swept parts (stand, fence)
}
export function stadium(): VenuePart[]
```

Everything is deterministic, as `surroundings()` already is.

### Parts

**Grandstand** — home straight, `s ≈ 0..84`, outside `TRACK_OUT + 6`. Eight
stepped rows, a roof on four columns, a back wall. Built as a single profile
extruded along the straight, so it is flat geometry with no curve to sample:
roughly 200 triangles. Concrete texture from slice 1. Seats are a repeating
texture on the step faces rather than individual meshes.

**Perimeter fence** — a loop ribbon at `TRACK_OUT + 12` carrying a repeating
chain-link alpha texture, plus posts every 4 m. The ribbon reuses
`ribbonArrays` from slice 1 with a per-metre UV repeat, so the mesh is one
draw call and the posts merge into another. A gate gap is left opposite the
grandstand.

**Clubhouse** — a single box with a pitched roof, behind the grandstand,
carrying a door/window texture. One mesh.

**Infield furniture** — the infield is currently a bare green ribbon, which is
the most obviously fake surface in the scene from any camera angle on the back
straight. It gains:

- football pitch line markings as a flat textured plane inside the inner kerb
- long-jump runway (a thin light strip) and sand pit (a lighter quad)
- high-jump apron and mat
- shot-put circle with its sector lines

All are flat quads or thin boxes lying on the infield plane, textured rather than
modelled. They must all sit inside `TRACK_IN`.

**Flags** — three poles by the clubhouse. The cloth is a 6-segment strip
displaced by a sine wave driven by **walked distance**, not wall-clock time, so
it stays deterministic and in sync with everything else in the scene. Eighteen
vertices, and one of the very few animated objects.

**Skyline** — a single cylinder shell at radius ≈ 400 m with an alpha-cut
rooftop-profile texture, fog-tinted so it sits back properly. One draw call, and
it removes the empty-horizon feel on all three open sides.

### Tier gating

None. After the bake, the whole venue is roughly three extra draw calls. The
tier only affects the _texture resolution_ these parts inherit from slice 1's
factories.

## Testing

`scenicVenue.test.ts`:

- the grandstand footprint never intersects `TRACK_OUT` (nothing overhangs the
  track)
- the fence radius clears the grandstand's outer extent
- every infield part lies strictly inside `TRACK_IN`
- the fence gate gap does not overlap the grandstand span
- `stadium()` is deterministic: two calls return deep-equal results
- the flag wave function is continuous and bounded

## Risks

1. **Occlusion of the scenery ring.** The grandstand sits between the walker and
   part of the existing 48-prop ring on the home straight. Check that the ring
   still reads on the bends and back straight rather than looking deleted.
2. **The skyline shell and the fog band.** `WEATHER_FOG.mist` has `far: 100`, so
   in mist the skyline is fully fogged out — correct, but verify it fades rather
   than clipping at the fog boundary.
3. **Infield textures at low tier.** Pitch markings at 256 px across a 100 m
   plane would be mush. Resolved: the infield-markings texture is generated at
   1024 px **on both tiers**, exempt from the tier's texture-resolution rule. It
   is one texture and the markings are the only surface where the physical scale
   makes 256 px unusable.

## Done when

- Walking the home straight, there is a grandstand to the right and a clubhouse
  behind it.
- The infield reads as an athletics infield, not a green disc.
- The horizon has a skyline on the open sides.
- Draw-call count after the bake has risen by no more than 4.
- Full CI suite passes.
