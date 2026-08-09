# Scenic v3 art direction and asset contract

## Target

Scenic v3 uses bright stylized realism: recognisable human proportions, believable outdoor
materials and lighting, deliberately simplified silhouettes, and saturated colour accents. It
should read like a polished fitness game at treadmill viewing distance—not a photorealistic
simulator, a collection of low-poly primitives, or a dark cinematic scene.

The first representative kit is a temperate urban park connected to the existing club track:
layered deciduous vegetation, warm brick and painted-metal architecture, asphalt and compacted
gravel paths, benches, lamps, signs, bins, barriers, and restrained flower colour. Reuse and
material variation should create density before unique models create download weight.

## Asset contract

- Runtime models use binary glTF (`.glb`). Textures use WebP initially; KTX2 is allowed once its
  transcoder is shipped and covered offline. Ambient loops use Ogg Vorbis.
- Every file lives below `public/scenic/` and appears in `manifest.json` with a `scenic/…`
  base-relative URL (required for the GitHub Pages repository subpath), its exact byte and
  triangle count, tier, HTTPS source, SPDX-style licence, and visible attribution.
- Accepted licences are CC0 1.0, CC BY 4.0, and original WalkFit work. CC BY assets must retain
  attribution in the manifest and future in-app credits screen.
- Do not import logos, trademarks, editorial-only models, non-commercial licences, or assets with
  ambiguous AI-training/source claims.
- Geometry is authored in metres, Y-up, +Z forward, with transforms applied and the ground at Y=0.
- PBR materials use base colour, roughness, metalness, normal, and alpha-mask where useful. Avoid
  transmission, clearcoat, displacement, and unique 4K maps for the initial mobile target.
- Shared environment materials should atlas compatible props. Character animation clips use the
  stable names `Idle`, `Walk`, `Brisk`, and `Jog`.

## Budgets

The repository rejects any single asset above 4 MiB and all scenic assets above 16 MiB. The
visible triangle budgets are 80k on Performance, 180k on Quality, and 350k on Ultra. These are
ceilings, not targets; draw calls, skinning cost, overdraw, texture memory, and live object count
still decide whether an asset belongs in a tier.

`all` assets are available on every tier. `high` assets augment `all` on Quality and Ultra;
`ultra` augments both. A higher tier must never be the only path to essential route geometry,
navigation, checkpoints, or safety information.

## Loading and fallback

Three.js loaders stay behind the lazy `Scenic3D.vue` boundary. Route chunks request manifest
assets through one loader/cache, clone scene graphs safely, stop animation mixers on disposal,
and release geometries, materials, and textures when their last pooled instance leaves.

The PWA precaches every manifest and supported asset format. If an asset is missing, corrupt, or
unsupported, the route remains walkable using procedural geometry; an art failure must never
blank the canvas or interrupt treadmill control.

## Review checklist

Before adding an asset, run `npm run assets:check`, the normal repository gates, an offline E2E
start, and a physical-GPU frame. Inspect it at phone and desktop framing, in day and night, and in
Performance and Quality. Record the source and licence before the binary enters Git history.
