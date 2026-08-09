<script setup lang="ts">
// First-person 3D walk around the 400 m athletics track (#51). Lazy-loaded (this file
// pulls in three.js, so App.vue imports it with defineAsyncComponent — the chunk only
// downloads when scenic is opened). All world *decisions* (track geometry, scenery
// placement, sky cycle) live in scenic.ts; this component only turns them into meshes.
// The camera walks the lane-1 line (loop world → the whole scene is static, no
// streaming) and interpolates toward the walked distance at roughly belt speed, so
// motion stays smooth despite the ~4 Hz distance updates from the treadmill ticker.
import { onMounted, onBeforeUnmount, watch, ref } from 'vue'
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
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
  laneDistanceToS,
  laneMeasurementO,
  DOME_R,
  CAMERA_FAR,
  curvatureEased,
} from './scenic'
import type { Prop } from './scenic'
import {
  pacers,
  stepPhase,
  strideLength,
  gaitCycleM,
  cameraMotion,
  FOV_BASE_DEG,
  FOV_EPSILON_DEG,
} from './scenicLife'
import type { Pacer } from './scenicLife'
import {
  stadium,
  PART_SIZES,
  SKYLINE_R,
  GATE_S0,
  GATE_S1,
  venueClearO,
  STAND_ROWS,
  STAND_ROW_DEPTH,
  STAND_ROW_RISE,
  STAND_ROOF_W,
} from './scenicVenue'
import type { VenuePart } from './scenicVenue'
import {
  ribbonArrays,
  stripArrays,
  geometryFrom,
  ensureUv,
  assertSameAttributes,
  REPEAT,
  tartanTexture,
  grassTexture,
  canopyTexture,
  barkTexture,
  foliageTexture,
  concreteTexture,
  surface,
  blobShadowTexture,
  glowTexture,
  starPositions,
  cloudTexture,
  runnerParts,
  chainLinkTexture,
  seatingTexture,
  pitchLinesTexture,
  skylineTexture,
  treeLineTexture,
  TREELINE_GROUND_V,
  sandTexture,
} from './scenicMeshes'
import {
  dayPhase,
  skyAt,
  skyBodies,
  weatherFor,
  WEATHER_FOG,
  TIME_PHASES,
  isNight,
  cloudColor,
  backdropTint,
  paintLevel,
} from './scenicSky'
import type { TimeOfDay } from './scenicSky'
import { tierFromFrames, resolveTier, PROBE_FRAMES, TIER_BUDGET } from './scenicQuality'
import type { Tier, QualitySetting } from './scenicQuality'

const props = defineProps<{
  distance: number
  speed: number
  weatherSeed?: number // per-walk weather pick (#72); omitted = clear
  timeOfDay?: TimeOfDay // Settings override; 'auto' follows walked distance
  quality?: QualitySetting
  steps?: number
  rabbitDistance?: number | null // target-pace rabbit (#realism slice 3); null/omitted = none
  motion?: boolean // head bob / sway / bend lean (#realism slice 4); omitted = on
}>()
const emit = defineEmits<{ unsupported: [] }>()

const host = ref<HTMLDivElement | null>(null)

const EYE_HEIGHT = 1.6
// The perimeter fence's height. Used in three places (ribbon vertex, chain-link texture
// v-repeat, post length) — a single source so changing it can't silently smear the uv.
const FENCE_H = 2

let renderer: THREE.WebGLRenderer | null = null
let raf = 0
let disposed = false
// Assigned by onMounted once the scene exists; lifecycle hooks themselves must be
// registered at setup level (registering them inside onMounted is a Vue error).
let cleanup: (() => void) | null = null
onBeforeUnmount(() => {
  disposed = true
  cleanup?.()
})

onMounted(() => {
  const el = host.value!
  // WebGL probe before any three.js setup — no WebGL (e.g. jsdom, old machines) means
  // the parent should fall back to the track view.
  const probe = document.createElement('canvas')
  const probeCtx = (probe.getContext('webgl2') || probe.getContext('webgl')) as
    WebGLRenderingContext | WebGL2RenderingContext | null
  if (!probeCtx) {
    emit('unsupported')
    return
  }
  // Release the probe's context slot immediately — browsers allow only ~8-16 live WebGL
  // contexts, and leaking one per 2D↔3D toggle can evict the real renderer's (#60).
  probeCtx.getExtension('WEBGL_lose_context')?.loseContext()

  // Start on the cheap tier and upgrade once if the machine turns out to be fast. Never
  // downgrade mid-session: a tier flip during a walk is more jarring than a few dropped
  // frames, and the walker cannot do anything about it either way.
  let tier: Tier = props.quality === 'high' ? 'high' : 'low'
  const probeSamples: number[] = []
  let probeDone = props.quality !== 'auto' && props.quality !== undefined

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV_BASE_DEG, 1, 0.3, CAMERA_FAR)
  // per-walk weather (#72): deterministic from the session seed
  const weather = weatherFor(props.weatherSeed ?? 0)
  const fogBand = WEATHER_FOG[weather]
  scene.fog = new THREE.Fog(0x000000, fogBand.near, fogBand.far)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  // ACES compresses the highlights, which is what lets the palette be authored at real
  // outdoor brightness instead of the muted values the old un-tone-mapped scene needed.
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  el.appendChild(renderer.domElement)

  // The ground half is a stand-in for bounce light off the infield and the track, so it is
  // warm and well clear of black — at 0x30363f every underside in the scene (the grandstand
  // roof above all) rendered as a flat black void with no shape in it at all.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x6b6455, 0.9)
  const sun = new THREE.DirectionalLight(0xffffff, 1)
  const sunTarget = new THREE.Object3D()
  scene.add(hemi, sun, sunTarget)
  sun.target = sunTarget
  const SUN_DIST = 120

  // Fixed-size shadow box re-centred on the walker each frame. Fitting it to the whole
  // 400 m loop would spend nearly all the map's resolution on geometry behind you.
  const SHADOW_BOX = 60 // metres either side of the camera
  function enableShadows() {
    renderer!.shadowMap.enabled = true
    renderer!.shadowMap.type = THREE.PCFShadowMap
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const cam = sun.shadow.camera
    cam.left = -SHADOW_BOX
    cam.right = SHADOW_BOX
    cam.top = SHADOW_BOX
    cam.bottom = -SHADOW_BOX
    // Tight near/far around the sun's fixed distance (not 1..SUN_DIST*2): every bias unit
    // spends its precision on the box that actually matters instead of empty space, so a
    // much smaller bias still clears the self-shadow acne below.
    cam.near = SUN_DIST - 80
    cam.far = SUN_DIST + 80
    cam.updateProjectionMatrix()
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.03
  }

  // Declared ahead of the sky dome/bodies below because `addClouds()` (immediately
  // invoked on the high tier) and the static-world bake both push disposable geometry
  // into this array — a `const` further down would leave it in the temporal dead zone
  // for that first `addClouds()` call.
  const disposables: THREE.BufferGeometry[] = []
  const track = (mesh: THREE.Mesh) => {
    disposables.push(mesh.geometry as THREE.BufferGeometry)
    scene.add(mesh)
    return mesh
  }

  // Sky dome: vertex-color gradient from fog color at the horizon to sky color overhead,
  // following the camera. Kills the hard seam where fogged ground meets a flat background.
  // toneMapped:false is load-bearing — three.js applies fog AFTER tone mapping, so real
  // fogged geometry fades to the raw hex. If the dome were tone mapped it would no longer
  // match the fog it is painted to blend into, and the seam would come back.
  const domeGeo = new THREE.SphereGeometry(DOME_R, 24, 12)
  const domeColors = new THREE.Float32BufferAttribute(
    new Float32Array(domeGeo.attributes.position!.count * 3),
    3,
  )
  domeGeo.setAttribute('color', domeColors)
  const dome = new THREE.Mesh(
    domeGeo,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      toneMapped: false,
    }),
  )
  scene.add(dome)

  // Sky bodies: a sun/moon glow sprite each, a star field that fades in at night, and a
  // drifting cloud shell on the high tier. All four must dodge the static-world bake
  // below (see the `staticRoots` filter) or they get merged into a mesh and vanish.
  const SKY_R = 250 // just inside the DOME_R dome
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
    // raw framebuffer pixels: sizeAttenuation:false means three does NOT apply the
    // renderer's pixel ratio, so without this a DPR-2 screen renders 0.8 CSS px stars —
    // sub-pixel, shimmering/invisible on the phone-on-treadmill case this targets
    size: 1.6 * renderer.getPixelRatio(),
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
    cloudTex.repeat.set(4, 2)
    // thetaLength must reach past 90deg: at 81.8deg the shell's lower rim floated 8.2deg
    // above the horizon as a hard edge across the sky. Past vertical it tucks behind the
    // ground plane, which is opaque and depth-writing, so the seam is simply occluded.
    const g = new THREE.SphereGeometry(248, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.6)
    clouds = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.62,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    )
    disposables.push(g)
    scene.add(clouds)
  }
  if (TIER_BUDGET[tier].clouds) addClouds()

  const cLo = new THREE.Color()
  const cHi = new THREE.Color()
  const cMix = new THREE.Color()
  function paintDome(skyHex: number, fogHex: number) {
    cHi.setHex(skyHex)
    cLo.setHex(fogHex)
    const pos = domeGeo.attributes.position!
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, pos.getY(i) / 140))
      cMix.copy(cLo).lerp(cHi, t)
      domeColors.setXYZ(i, cMix.r, cMix.g, cMix.b)
    }
    domeColors.needsUpdate = true
  }
  // Hoisted out of update() (Fix 4): that function runs every rendered frame, so a
  // closure declared inside it was a fresh allocation per frame.
  const place = (o: THREE.Object3D, b: { azimuth: number; elevation: number }) => {
    o.position.set(
      camera.position.x + Math.cos(b.azimuth) * Math.cos(b.elevation) * SKY_R,
      Math.sin(b.elevation) * SKY_R,
      camera.position.z + Math.sin(b.azimuth) * Math.cos(b.elevation) * SKY_R,
    )
  }

  // --- shared geometries/materials ---
  const geo = {
    trunk: new THREE.CylinderGeometry(0.12, 0.18, 1, 5),
    crown: new THREE.IcosahedronGeometry(0.9, 0), // bushes only — trees use canopy cards
    // non-indexed to match the icosahedron bushes: mergeGeometries returns null for a
    // batch that mixes indexed and non-indexed geometry, and both share mat.crown2
    canopy: new THREE.PlaneGeometry(3.4, 3.4).toNonIndexed(),
    cone: new THREE.ConeGeometry(0.8, 1.4, 6),
    rock: new THREE.IcosahedronGeometry(0.5, 0),
    pole: new THREE.CylinderGeometry(0.09, 0.12, 1, 6),
    head: new THREE.BoxGeometry(1.6, 0.5, 0.25),
  }
  // Cheap-tier ground contact for props (Step 4 below) — shared across every prop that
  // gets one, so it costs one texture and one geometry, not one per tree.
  const blobTex = blobShadowTexture(128)
  const blobGeo = new THREE.PlaneGeometry(1, 1)
  const blobMat = new THREE.MeshBasicMaterial({
    map: blobTex,
    transparent: true,
    depthWrite: false,
  })
  // Set when the bake merges the blob discs into one mesh (below) — lets applyTier hide
  // them the instant real shadows come on, and bring them back if shadows go off again.
  let blobMesh: THREE.Mesh | null = null
  // pitchLines is generated once at 1024 regardless of tier (see makeTextures below) and
  // memoized here so a tier change reuses the same texture object instead of pointlessly
  // regenerating an identical 1024 copy every toggle.
  let pitchLinesTex: THREE.CanvasTexture | null = null
  function makeTextures(size: number) {
    const aniso = Math.min(4, renderer!.capabilities.getMaxAnisotropy())
    pitchLinesTex ??= pitchLinesTexture(1024)
    const t = {
      tartan: tartanTexture(size),
      // rough ground outside the fence is not a mown pitch, and at 60 repeats over the
      // 700 m plane its stripes tiled every 11.7 m into visible banding
      grass: grassTexture(size, 108, false),
      canopy1: canopyTexture(size, 104),
      canopy2: canopyTexture(size, 84),
      infield: grassTexture(size, 96),
      bark: barkTexture(size),
      foliage: foliageTexture(size),
      concrete: concreteTexture(size),
      chainLink: chainLinkTexture(size),
      seating: seatingTexture(size),
      // always 1024: at 256 px across a 100 m plane the pitch markings are mush, and this
      // is the one surface where physical scale makes the tier's texture budget unusable
      pitchLines: pitchLinesTex,
      skyline: skylineTexture(size),
      sand: sandTexture(size),
    }
    for (const tex of Object.values(t)) tex.anisotropy = aniso
    // `ribbonArrays` spans v from 0 to 1 across the ribbon's width however wide it is,
    // while REPEAT scales u only. Left alone, the 7.32 m track band and the 0.18 m kerb
    // would get wildly different u:v aspect ratios and the kerb would smear into streaks.
    // Scale v by the ribbon's real width so both axes tile at the same metres-per-repeat.
    // A fractional v repeat is fine: unlike u, v does not wrap around a closed loop, so
    // there is no seam for it to misalign at.
    t.tartan.repeat.set(1, (TRACK_OUT - TRACK_IN) / REPEAT.track)
    t.infield.repeat.set(1, 30 / REPEAT.infield) // infield ribbon spans 30 m inward
    t.concrete.repeat.set(1, 0.18 / REPEAT.kerb) // kerb: TRACK_IN-0.2 .. TRACK_IN-0.02
    t.grass.repeat.set(60, 60) // one big 700 m plane, so tile it hard
    // v spans the FENCE_H fence height at 4 m per u repeat; LAP_M / 4 = 100, a whole
    // number, so the chain-link meets itself at the seam. Set here (not once at
    // buildVenue time) so a tier change, which swaps in a fresh chainLink texture
    // instance, keeps it.
    t.chainLink.repeat.set(1, FENCE_H / 4)
    // The skyline canvas is transparent at the top and opaque at the bottom, and the
    // cylinder's v spans exactly 0..1 — with RepeatWrapping the sampler blends the two
    // across the seam and draws a dark hairline right around the sky at the rim.
    t.skyline.wrapT = THREE.ClampToEdgeWrapping
    t.skyline.needsUpdate = true
    return t
  }
  // Task 6 deliberately left this out because nothing read it yet; it has a reader now.
  let budget = TIER_BUDGET[tier]
  // an explicit quality: 'high' setting must get shadows immediately — the probe that
  // would otherwise call this (via applyTier) never runs when the tier isn't 'auto'.
  if (budget.shadowMap && !renderer!.shadowMap.enabled) enableShadows()
  let tex = makeTextures(budget.textureSize)

  const mat = {
    trunk: surface({ color: 0xffffff, map: tex.bark, roughness: 0.95 }),
    // alphaTest rather than transparent: an alpha-tested material still writes depth, so
    // crossed quads inside one canopy sort correctly against each other without the
    // per-fragment ordering artefacts a blended material would show from every angle.
    crown1: new THREE.MeshStandardMaterial({
      map: tex.canopy1,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    }),
    crown2: new THREE.MeshStandardMaterial({
      map: tex.canopy2,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    }),
    pine: surface({ color: 0x8fb890, map: tex.foliage, roughness: 1, flatShading: true }),
    rock: surface({ color: 0x777d87, roughness: 0.85, flatShading: true }),
    pole: surface({ color: 0x4a505b, roughness: 0.6 }),
    floodOn: new THREE.MeshBasicMaterial({ color: 0xfff2c8 }), // unlit — reads as lit at night
    kerb: surface({
      color: 0xffffff,
      map: tex.concrete,
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    breakLine: new THREE.MeshBasicMaterial({ color: 0x3ba55d, side: THREE.DoubleSide }),
    relay: new THREE.MeshBasicMaterial({ color: 0xd8b638, side: THREE.DoubleSide }),
    hurdle: new THREE.MeshBasicMaterial({ color: 0x2e7d4f, side: THREE.DoubleSide }),
    grass: surface({ color: 0xffffff, map: tex.grass, roughness: 1 }),
    // The loop ribbons reverse travel direction halfway around, so a fixed triangle
    // winding faces down on one straight and up on the other — DoubleSide instead of
    // per-segment winding gymnastics (they're flat strips only ever seen from above).
    infield: surface({
      color: 0xffffff,
      map: tex.infield,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
    track: surface({
      color: 0xffffff,
      map: tex.tartan,
      roughness: 0.85,
      side: THREE.DoubleSide,
    }),
    laneLine: new THREE.MeshBasicMaterial({ color: 0xdfe4ea, side: THREE.DoubleSide }),
    finish: new THREE.MeshBasicMaterial({ color: 0xf2f5f9, side: THREE.DoubleSide }),
    seating: surface({ color: 0xffffff, map: tex.seating, roughness: 0.9 }),
    fence: new THREE.MeshBasicMaterial({
      map: tex.chainLink,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false, // a mesh fence must not occlude what is behind it
    }),
    clubhouse: surface({ color: 0xd8cfc0, roughness: 0.85 }),
    roof: surface({ color: 0x8d5a45, roughness: 0.8 }),
    // The soffit is its own material: the roof's underside is the one large surface in the
    // venue that never sees the sun, so lit by the hemisphere term alone it renders as a
    // black slot over the terracing. A pale underside is also what real stands have — it
    // is there to bounce light back down onto the seats.
    soffit: surface({ color: 0xcfc6b4, roughness: 0.95 }),
    pitch: surface({ color: 0xffffff, map: tex.pitchLines, roughness: 1, side: THREE.DoubleSide }),
    sand: surface({ color: 0xffffff, map: tex.sand, roughness: 1, side: THREE.DoubleSide }),
    mat: surface({ color: 0x2f5fa8, roughness: 0.9, side: THREE.DoubleSide }),
    // Dedicated rather than reusing mat.seating (FrontSide) — a flag needs to read from
    // both sides, and flipping a shared material would also double-side the grandstand's
    // seating. A ninth material; the flags are the only user.
    flag: new THREE.MeshBasicMaterial({ color: 0xc23b3b, side: THREE.DoubleSide }),
  }
  // assertSameAttributes/mergeGeometries errors prefer material.name — without this every
  // merge batch reports as generic "MeshStandardMaterial", useless for diagnosing which one.
  Object.entries(mat).forEach(([k, m]) => (m.name = k))

  // A backdrop, not scenery: follows the camera like the dome, so it is always exactly
  // SKYLINE_R away and always inside the dome (DOME_R) and the far plane (CAMERA_FAR).
  // fog:false because at this distance linear fog would saturate and erase it — the tint
  // applied in update() carries the depth cue instead, without the all-or-nothing.
  // Tall enough to stand clearly above the treeline in front of it: at 55 m the roofline
  // sat level with the trees at 173 m, so the two rings read as one confused band.
  const skylineGeo = new THREE.CylinderGeometry(SKYLINE_R, SKYLINE_R, 82, 48, 1, true)
  const skylineMat = new THREE.MeshBasicMaterial({
    map: tex.skyline,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const skylineMesh = new THREE.Mesh(skylineGeo, skylineMat)
  scene.add(skylineMesh)
  disposables.push(skylineGeo)

  // Treeline: the same trick one ring closer, filling the band between the venue fence and
  // the buildings. Without it the ground simply stops at a hard grass/sky edge — the one
  // place the world visibly ends. Nearer than the skyline, so it is tinted less strongly
  // toward the fog colour and keeps more of its own green.
  // Height and centre must satisfy TREELINE_GROUND_V: the texture's ground line is at
  // v = 0.73, so with a 26 m cylinder the centre sits at 26 * (0.73 - 0.5) = 6 m.
  const TREELINE_H = 26
  const treeLineTex = treeLineTexture(1024)
  treeLineTex.repeat.set(6, 1)
  // v must NOT wrap: the texture's opaque ground band sits at the bottom, and with
  // RepeatWrapping the linear filter samples it across the seam and paints a dark hairline
  // along the cylinder's top rim — a line across the sky, right where nothing should be.
  treeLineTex.wrapT = THREE.ClampToEdgeWrapping
  const treeLineGeo = new THREE.CylinderGeometry(
    SKYLINE_R * 0.72,
    SKYLINE_R * 0.72,
    TREELINE_H,
    48,
    1,
    true,
  )
  const treeLineMat = new THREE.MeshBasicMaterial({
    map: treeLineTex,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const treeLineMesh = new THREE.Mesh(treeLineGeo, treeLineMat)
  scene.add(treeLineMesh)
  disposables.push(treeLineGeo)

  // Unlit painted surfaces, with the colour they are authored at — update() scales them by
  // the scene's light level every frame (see paintLevel). mat.floodOn is deliberately NOT
  // here: it is a lamp, not paint, and switching it on after dark is the whole point.
  const painted: [THREE.MeshBasicMaterial, number][] = []
  const dimsWithLight = (m: THREE.MeshBasicMaterial) => {
    painted.push([m, m.color.getHex()])
    return m
  }
  for (const m of [
    mat.breakLine,
    mat.relay,
    mat.hurdle,
    mat.laneLine,
    mat.finish,
    mat.fence,
    mat.flag,
  ]) {
    dimsWithLight(m)
  }

  // Double-sided materials that must still cast (see the bake's castShadow rule).
  const castsDespiteTwoSided = new Set<THREE.Material>([mat.crown1, mat.crown2])

  function buildProp(p: Prop): THREE.Object3D {
    const g = new THREE.Group()
    if (p.type === 'tree') {
      const trunk = new THREE.Mesh(geo.trunk, mat.trunk)
      trunk.scale.set(1, 2.2, 1)
      trunk.position.y = 1.1
      g.add(trunk)
      // Crossed billboards, not a solid crown: three quads through the same axis, each
      // carrying the canopy alpha. A convex mesh reads as a faceted ball from every angle
      // — the ragged outline is what makes a tree look like a tree, and only alpha can
      // give one. Fixed (not camera-facing) so the world can still be baked once.
      const canopy = p.seed < 0.5 ? mat.crown1 : mat.crown2
      for (let i = 0; i < 3; i++) {
        const card = new THREE.Mesh(geo.canopy, canopy)
        card.position.y = 2.7
        card.rotation.y = (i / 3) * Math.PI
        g.add(card)
      }
    } else if (p.type === 'pine') {
      const trunk = new THREE.Mesh(geo.trunk, mat.trunk)
      trunk.scale.set(1, 1.6, 1)
      trunk.position.y = 0.8
      g.add(trunk)
      for (let i = 0; i < 3; i++) {
        const layer = new THREE.Mesh(geo.cone, mat.pine)
        layer.scale.setScalar(1.5 - i * 0.35)
        layer.position.y = 1.6 + i * 1.0
        g.add(layer)
      }
    } else if (p.type === 'bush') {
      const b = new THREE.Mesh(geo.crown, mat.crown2)
      b.scale.set(0.9, 0.55, 0.9)
      b.position.y = 0.3
      g.add(b)
    } else if (p.type === 'rock') {
      const r = new THREE.Mesh(geo.rock, mat.rock)
      r.position.y = 0.25
      r.rotation.y = p.seed * Math.PI * 2
      g.add(r)
    } else {
      // floodlight mast: tall pole + light head, angled toward the track
      const pole = new THREE.Mesh(geo.pole, mat.pole)
      pole.scale.y = 12
      pole.position.y = 6
      const head = new THREE.Mesh(geo.head, mat.floodOn)
      head.position.y = 12.1
      g.add(pole, head)
    }
    const pt = trackPoint(p.s, p.o)
    g.position.set(pt.x, 0, pt.z)
    if (p.type === 'flood') {
      g.lookAt(0, 0, 0) // heads face the infield
    } else {
      g.rotation.y = p.seed * Math.PI * 2
      g.scale.setScalar(p.scale)
    }
    // Cheap tier runs no shadow map: fake ground contact with a static dark disc instead.
    // Built for every prop regardless of the tier the session eventually settles on — the
    // world is baked once, so the auto probe's low→high upgrade (or a later Settings
    // downgrade) can't add or remove geometry. The merged blob mesh is instead toggled
    // visible/invisible in applyTier to match whichever tier is actually active.
    if (p.type !== 'flood') {
      const blob = new THREE.Mesh(blobGeo, blobMat)
      blob.rotation.x = -Math.PI / 2
      blob.position.y = 0.03
      blob.scale.setScalar(1.6)
      g.add(blob)
    }
    return g
  }

  // Static venue furniture. Added BEFORE the bake, like the scenery ring — these never
  // move, so they merge by material and cost a handful of draw calls between them.
  function buildVenue(p: VenuePart): THREE.Object3D {
    const g = new THREE.Group()
    const at = trackPoint(p.s, p.o)
    // Same invariant the rest of the file keeps: anything allocated gets disposed, even
    // though the bake currently frees these before they ever reach the GPU.
    const keep = (m: THREE.Mesh): THREE.Mesh => {
      disposables.push(m.geometry as THREE.BufferGeometry)
      return m
    }
    // These reuse mat.track / mat.kerb, whose texture.repeat is tuned for the loop ribbons'
    // UVs. A PlaneGeometry (or CircleGeometry) spans 0..1, so without this the tile is
    // stretched tens of metres. Scaling the geometry's own uv attribute keeps the material
    // shared — a material per part would multiply the bake's draw calls.
    const tileUv = (g2: THREE.BufferGeometry, w: number, l: number, metresPerTile: number) => {
      const uv = g2.getAttribute('uv')
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * (w / metresPerTile), uv.getY(i) * (l / metresPerTile))
      }
      uv.needsUpdate = true
    }

    if (p.type === 'stand') {
      // Eight stepped rows swept along the home straight. Built as a box per row rather
      // than an extruded profile: the straight is straight, so boxes are exact here and
      // far simpler than sampling the loop. Dimensions come from scenicVenue.ts's
      // STAND_* constants (not local literals) — PART_SIZES.stand is derived from the
      // same constants, so this build and the fence-clearance test can never disagree.
      const len = p.span!
      const rows = STAND_ROWS
      for (let r = 0; r < rows; r++) {
        const step = keep(
          new THREE.Mesh(new THREE.BoxGeometry(STAND_ROW_DEPTH, STAND_ROW_RISE, len), mat.seating),
        )
        // set x directly rather than translateX — translate is applied in the object's
        // own rotated frame, and this group gets rotated to face the track below
        step.position.set(r * STAND_ROW_DEPTH, 0.22 + r * STAND_ROW_RISE, 0)
        g.add(step)
      }
      const backWall = keep(new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.2, len), mat.clubhouse))
      backWall.position.set(rows * STAND_ROW_DEPTH, 2.1, 0)
      g.add(backWall)
      const roof = keep(new THREE.Mesh(new THREE.BoxGeometry(STAND_ROOF_W, 0.25, len), mat.roof))
      const soffit = keep(
        new THREE.Mesh(new THREE.PlaneGeometry(STAND_ROOF_W, len).toNonIndexed(), mat.soffit),
      )
      soffit.rotation.x = Math.PI / 2 // faces down
      // Not STAND_ROOF_W / 2 — the roof is offset from the terracing's midpoint, not
      // centred on itself. Its outer edge (this position + half its width) is exactly
      // STAND_DEPTH, which is what the fence-clearance test checks.
      roof.position.set(rows * 0.55, 5.4, 0)
      soffit.position.set(rows * 0.55, 5.27, 0)
      g.add(roof, soffit)
      for (let i = 0; i < 4; i++) {
        const col = keep(
          new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 5.3, 6), mat.clubhouse),
        )
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
        pts.push(a.x, 0, a.z, a.x, FENCE_H, a.z)
        const u = s / 4
        uv.push(u, 0, u, 1)
        // Skip index emission for quads inside the gate span, leaving the vertices in
        // place so u continuity across the seam is untouched — only the posts stopping
        // at the gate left an unbroken mesh, which read as a fence someone stole the
        // posts from rather than an actual gate.
        if (i > 0 && !(s > GATE_S0 && s - step < GATE_S1)) {
          const k = (i - 1) * 2
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
        }
      }
      g.add(keep(new THREE.Mesh(geometryFrom({ position: pts, uv, index: idx }), mat.fence)))
    } else if (p.type === 'fencePost') {
      const post = keep(
        new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, FENCE_H + 0.1, 5), mat.pole),
      )
      post.position.set(at.x, (FENCE_H + 0.1) / 2, at.z)
      g.add(post)
    } else if (p.type === 'clubhouse') {
      const body = keep(new THREE.Mesh(new THREE.BoxGeometry(9, 3.4, 6), mat.clubhouse))
      body.position.set(at.x, 1.7, at.z)
      const roof = keep(new THREE.Mesh(new THREE.ConeGeometry(7, 2, 4), mat.roof))
      roof.position.set(at.x, 4.4, at.z)
      roof.rotation.y = Math.PI / 4
      g.add(body, roof)
    } else if (p.type === 'flagpole') {
      const pole = keep(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 7, 5), mat.pole))
      pole.position.set(at.x, 3.5, at.z)
      g.add(pole)
      const cloth = keep(new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), mat.flag))
      cloth.position.set(at.x, 6.2, at.z)
      cloth.rotation.y = Math.atan2(-at.tx, -at.tz)
      cloth.translateX(0.8)
      g.add(cloth)
    } else if (p.type === 'pitch') {
      const plane = keep(new THREE.Mesh(new THREE.PlaneGeometry(...PART_SIZES.pitch!), mat.pitch))
      plane.rotation.x = -Math.PI / 2
      plane.position.set(at.x, 0.01, at.z)
      g.add(plane)
    } else if (p.type === 'jumpRunway') {
      const run = keep(
        new THREE.Mesh(new THREE.PlaneGeometry(...PART_SIZES.jumpRunway!), mat.track),
      )
      tileUv(run.geometry, PART_SIZES.jumpRunway![0], PART_SIZES.jumpRunway![1], REPEAT.track)
      run.rotation.x = -Math.PI / 2
      run.position.set(at.x, 0.012, at.z)
      run.rotation.z = Math.atan2(-at.tx, -at.tz)
      g.add(run)
    } else if (p.type === 'jumpPit') {
      const pit = keep(new THREE.Mesh(new THREE.PlaneGeometry(...PART_SIZES.jumpPit!), mat.sand))
      pit.rotation.x = -Math.PI / 2
      pit.position.set(at.x, 0.012, at.z)
      pit.rotation.z = Math.atan2(-at.tx, -at.tz)
      g.add(pit)
    } else if (p.type === 'highJump') {
      const apron = keep(
        new THREE.Mesh(new THREE.PlaneGeometry(...PART_SIZES.highJump!), mat.track),
      )
      tileUv(apron.geometry, PART_SIZES.highJump![0], PART_SIZES.highJump![1], REPEAT.track)
      apron.rotation.x = -Math.PI / 2
      apron.position.set(at.x, 0.012, at.z)
      const bed = keep(new THREE.Mesh(new THREE.BoxGeometry(5, 0.6, 3), mat.mat))
      bed.position.set(at.x, 0.3, at.z)
      g.add(apron, bed)
    } else if (p.type === 'shotCircle') {
      // PART_SIZES.shotCircle is a [diameter, diameter] footprint; CircleGeometry wants a
      // radius.
      const ring = keep(
        new THREE.Mesh(new THREE.CircleGeometry(PART_SIZES.shotCircle![0] / 2, 20), mat.kerb),
      )
      tileUv(ring.geometry, PART_SIZES.shotCircle![0], PART_SIZES.shotCircle![1], REPEAT.kerb)
      ring.rotation.x = -Math.PI / 2
      ring.position.set(at.x, 0.013, at.z)
      g.add(ring)
    }
    // 'skyline' is deliberately unhandled here: it is built as a camera-following
    // backdrop above, not baked venue furniture — see the `stadium()` loop below, which
    // skips it before ever calling this function.
    return g
  }

  // Closed ribbon around the whole loop between lateral offsets [o0, o1]. Winding chosen
  // so face normals point +y (visible from above; FrontSide culling).
  function buildLoopRibbon(
    o0: number,
    o1: number,
    y: number,
    m: THREE.Material,
    repeatMetres = REPEAT.mark,
  ): THREE.Mesh {
    return new THREE.Mesh(geometryFrom(ribbonArrays(o0, o1, y, repeatMetres)), m)
  }

  // Short strip across the track at arc position s (finish line, lane staggers, relay and
  // hurdle marks).
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

  // --- static world, built once ---
  // (disposables/track declared earlier — addClouds() needs them before this point)

  // grass everywhere (single big plane), slightly below the track surface
  const groundGeo = new THREE.PlaneGeometry(700, 700)
  const ground = new THREE.Mesh(groundGeo, mat.grass)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.02
  scene.add(ground)
  disposables.push(groundGeo)

  // infield: a slightly lighter green fill inside the inner kerb
  track(buildLoopRibbon(TRACK_IN - 30, TRACK_IN, 0.0, mat.infield, REPEAT.infield))
  // the red track band with white lane lines (lines sit 4 cm above the surface —
  // less separation z-fights into shimmer on the far side of the loop)
  track(buildLoopRibbon(TRACK_IN, TRACK_OUT, 0.02, mat.track, REPEAT.track))
  for (let lane = 0; lane <= LANES; lane++) {
    const o = TRACK_IN + lane * LANE_W
    track(buildLoopRibbon(o - 0.03, o + 0.03, 0.06, mat.laneLine))
  }
  // common finish line at s = 0, plus the classic staggered start line per lane —
  // each lane's lap to the shared finish then measures exactly 400 m
  track(buildCrossStrip(0, 0.5, 0.07, mat.finish))
  for (const st of laneStaggers()) {
    track(buildCrossStrip(st.s, 0.4, 0.07, mat.finish, st.o0 + 0.06, st.o1 - 0.06))
  }
  // raised white kerb on the inside edge, like a real track's inner rail
  track(buildLoopRibbon(TRACK_IN - 0.2, TRACK_IN - 0.02, 0.08, mat.kerb, REPEAT.kerb))
  // relay exchange-zone limits: a yellow line across each lane at both ends of the
  // three 30 m zones around the 100/200/300 m marks
  for (const l of relayZoneLines()) {
    track(buildCrossStrip(l.s, 0.15, 0.06, mat.relay, l.o0 + 0.06, l.o1 - 0.06))
  }
  // 400 mH hurdle positions: small green ticks on the lane boundaries
  for (const t of hurdleTicks()) {
    track(buildCrossStrip(t.s, 0.28, 0.055, mat.hurdle, t.o - 0.14, t.o + 0.14))
  }
  // 1500 m waterfall start: curved white line across all lanes at the 100 m point,
  // bowing forward toward the outer lanes
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
  // dashed green break line at the 200 m point (end of the first bend)
  {
    const dashes = 9
    const span = TRACK_OUT - TRACK_IN
    for (let i = 0; i < dashes; i += 2) {
      const o0 = TRACK_IN + (i / dashes) * span
      const o1 = TRACK_IN + ((i + 1) / dashes) * span
      track(buildCrossStrip(BREAK_LINE_S, 0.3, 0.065, mat.breakLine, o0, o1))
    }
  }

  // painted lane numbers just past the finish line — white digits on the tartan,
  // glyph top pointing along the walking direction so they read upright on approach
  function digitTexture(n: number): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 96
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, 64, 96)
    ctx.fillStyle = 'rgba(240, 244, 249, 0.92)'
    ctx.font = 'bold 78px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), 32, 52)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const numberGeo = new THREE.PlaneGeometry(0.8, 1.2)
  const numberMats: THREE.MeshBasicMaterial[] = []
  for (const ln of laneNumbers()) {
    const p = trackPoint(ln.s, ln.o)
    const m = dimsWithLight(
      new THREE.MeshBasicMaterial({ map: digitTexture(ln.lane), transparent: true }),
    )
    numberMats.push(m)
    const digit = new THREE.Mesh(numberGeo, m)
    digit.rotation.x = -Math.PI / 2 // lie flat on the track, texture-up toward -z
    const wrap = new THREE.Group()
    wrap.add(digit)
    wrap.position.set(p.x, 0.045, p.z)
    wrap.rotation.y = Math.atan2(-p.tx, -p.tz) // align texture-up with walking direction
    scene.add(wrap)
  }

  // distance signposts beside the track every 100 m (the finish line is the 400 m mark)
  function signTexture(label: string): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 128
    c.height = 64
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#efe7d5'
    ctx.fillRect(0, 0, 128, 64)
    ctx.fillStyle = '#1c222b'
    ctx.font = 'bold 30px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 64, 34)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const signMats: THREE.MeshBasicMaterial[] = []
  for (const sign of distanceSigns()) {
    const at = trackPoint(sign.s, TRACK_OUT + 1.6)
    const post = new THREE.Mesh(geo.pole, mat.pole)
    post.scale.set(0.6, 2.4, 0.6)
    post.position.set(at.x, 1.2, at.z)
    scene.add(post)
    const boardMat = dimsWithLight(new THREE.MeshBasicMaterial({ map: signTexture(sign.label) }))
    signMats.push(boardMat)
    const board = new THREE.Mesh(geo.head, boardMat)
    board.scale.set(0.9, 1.5, 0.5)
    board.position.set(at.x, 2.5, at.z)
    // face the walker approaching from lower s (board's +z looks at that point)
    const facing = trackPoint(sign.s - 10, TRACK_OUT + 1.6)
    board.lookAt(facing.x, 2.5, facing.z)
    scene.add(board)
  }

  for (const p of surroundings()) scene.add(buildProp({ ...p, o: venueClearO(p.type, p.o) }))
  for (const p of stadium()) {
    // the skyline is built above as a camera-following backdrop, not baked venue
    // furniture — baking it here would double it up in the static merge.
    if (p.type === 'skyline') continue
    scene.add(buildVenue(p))
  }

  // Bake the static world into one mesh per material (#62): the loop ribbons, cross
  // strips, and ~50 scenery groups otherwise cost ~350 draw calls per frame on a scene
  // that never changes. The dome and lights stay live.
  {
    scene.updateMatrixWorld(true)
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>()
    // sunTarget is a plain Object3D, not a Light, so it would otherwise be swept into
    // staticRoots and removed — after which its matrixWorld freezes and the directional
    // light aims at the origin instead of following the walker. The sun/moon sprites,
    // star points and cloud shell are all live-updated per frame too (see update() below)
    // — left in staticRoots they would get merged into a mesh and silently vanish.
    const skyObjects: THREE.Object3D[] = [
      dome,
      sunSprite,
      moonSprite,
      stars,
      skylineMesh,
      treeLineMesh,
    ]
    if (clouds) skyObjects.push(clouds)
    const staticRoots = scene.children.filter(
      (c) => !skyObjects.includes(c) && !(c as THREE.Light).isLight && c !== sunTarget,
    )
    for (const root of staticRoots) {
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const material = m.material as THREE.Material
        const g = (m.geometry as THREE.BufferGeometry).clone()
        g.applyMatrix4(m.matrixWorld)
        ensureUv(g) // was deleteAttribute('uv') — textured surfaces need uv, not none
        const arr = byMat.get(material) ?? []
        arr.push(g)
        byMat.set(material, arr)
      })
    }
    for (const root of staticRoots) scene.remove(root)
    for (const [material, geoms] of byMat) {
      assertSameAttributes(geoms, material.name || material.type)
      const merged = mergeGeometries(geoms)
      geoms.forEach((g) => g.dispose())
      if (!merged) {
        throw new Error(
          `scenic merge: mergeGeometries returned null for "${material.name || material.type}"`,
        )
      }
      disposables.push(merged)
      const m = new THREE.Mesh(merged, material)
      if (material === blobMat) {
        blobMesh = m
        // Session may mount straight onto Quality (shadows on) — hide the fake ground
        // contact discs immediately instead of waiting for a later applyTier() call.
        blobMesh.visible = !budget.shadowMap
      }
      // DoubleSide surfaces must not cast: three flips shadowSide for them, so these flat
      // ribbons and painted markings write their own depth into the map and self-shadow
      // into acne. Deriving this from `side` rather than a hand-kept list means a new
      // marking cannot silently reintroduce it.
      const twoSided = (material as THREE.Material).side === THREE.DoubleSide
      // ...except the alpha-tested foliage cards, which are double-sided because a flat
      // quad has to be seen from behind, not because they are ground markings. Excluded
      // from the rule they would otherwise fall into, a tree stopped casting any shadow at
      // all the moment its crown became a billboard.
      m.castShadow = !twoSided || castsDespiteTwoSided.has(material)
      m.receiveShadow = true
      scene.add(m)
    }
  }

  // --- pacers (live, never baked) ---
  // scene.add here runs AFTER the bake block above, so these are never swept into
  // staticRoots — pacers move every frame and must not be merged into the static world.
  const {
    body: pacerBodyGeo,
    head: pacerHeadGeo,
    arm: pacerArmGeo,
    leg: pacerLegGeo,
  } = runnerParts()
  // One shared skin material across every rig: a head is not part of anyone's kit, and
  // sharing it keeps the head meshes from adding a material per pacer.
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc98d63, roughness: 0.75 })
  // The real maximum across every tier, not just 'high' — the per-frame loop below iterates
  // pacerRigs.length, so any future tier with a higher pacer count would silently never
  // render its extras if this only tracked one tier.
  const PACER_POOL = Math.max(...Object.values(TIER_BUDGET).map((b) => b.pacers))
  // Seeds come from the source of truth pacers() itself derives them from, not a second copy
  // of the formula — two copies agreeing by coincidence means changing one silently shows
  // every rig the wrong colour with no test failing.
  const seedSource = pacers(0, PACER_POOL)
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
    // Fixed per rig at construction, taken from pacers()'s own seed for index i, so the
    // colour a rig shows is the one its pacer would have asked for — no need to touch it
    // again every frame.
    kit.color.setHSL(seedSource[i]!.seed, 0.55, 0.5)
    const group = new THREE.Group()
    const mk = (g: THREE.BufferGeometry, x: number, y: number) => {
      const m = new THREE.Mesh(g, kit)
      m.position.set(x, y, 0)
      m.castShadow = true
      group.add(m)
      return m
    }
    mk(pacerBodyGeo, 0, 0)
    const head = new THREE.Mesh(pacerHeadGeo, skinMat)
    head.castShadow = true
    group.add(head)
    const armL = mk(pacerArmGeo, -0.22, 1.42)
    const armR = mk(pacerArmGeo, 0.22, 1.42)
    const legL = mk(pacerLegGeo, -0.09, 0.86)
    const legR = mk(pacerLegGeo, 0.09, 0.86)
    group.visible = false
    scene.add(group)
    pacerRigs.push({ group, armL, armR, legL, legR, kit })
  }

  // --- target-pace rabbit (live, never baked) ---
  // Same split-limb rig as the pacers above — a limb short enough to read as an arm
  // cannot reach the ground from the hip, hence separate pacerArmGeo/pacerLegGeo rather
  // than one shared geometry. Runs lane 2 so it is beside the walker rather than under
  // the camera.
  // It's an instrument, not scenery — the pacers may sink into the dusk, but this is
  // the app's only ahead/behind readout (paceGap has no caller, the 2D view draws no
  // rabbit), so it needs its own emissive term to stay legible after dark.
  const rabbitKit = new THREE.MeshStandardMaterial({
    color: 0x3ba55d,
    roughness: 0.7,
    emissive: 0x3ba55d,
  })
  const rabbitGroup = new THREE.Group()
  const mkRabbitLimb = (g: THREE.BufferGeometry, x: number, y: number) => {
    const m = new THREE.Mesh(g, rabbitKit)
    m.position.set(x, y, 0)
    m.castShadow = true
    rabbitGroup.add(m)
    return m
  }
  mkRabbitLimb(pacerBodyGeo, 0, 0)
  // The rabbit's head stays in kit colour, not skin: it is a pace instrument that has to
  // read as one solid emissive shape after dark, not a person.
  mkRabbitLimb(pacerHeadGeo, 0, 0)
  const rabbitArmL = mkRabbitLimb(pacerArmGeo, -0.22, 1.42)
  const rabbitArmR = mkRabbitLimb(pacerArmGeo, 0.22, 1.42)
  const rabbitLegL = mkRabbitLimb(pacerLegGeo, -0.09, 0.86)
  const rabbitLegR = mkRabbitLimb(pacerLegGeo, 0.09, 0.86)
  rabbitGroup.visible = false
  scene.add(rabbitGroup)

  // --- your own body (live, never baked) ---
  // The body exists only to cast your shadow — its geometry sits inside the camera's
  // 0.3 m near plane, so it is clipped away and never itself visible.
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

  // No ground blob for the walker on the low tier. Your feet sit outside the frustum by
  // construction (visible ground starts about 2.65 m out at eye height 1.6 m with a 60
  // degree FOV), so a disc under you renders nothing, and one far enough forward to be
  // visible reads as a mark on the track rather than as your shadow. The high tier's real
  // cast shadow works because shadows stretch AWAY from you into view when the sun is low.

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
  // Range over which the nearest-pacer label fades out rather than being clipped off.
  const LABEL_FADE_M = 14
  const LABEL_MAX_M = 24
  const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
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

  // --- camera + sky per frame ---
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let display = props.distance // smoothed distance the camera actually sits at
  let sessionSeconds = 0
  let lastDomeKey = -1 // repaint the ~350 dome vertex colors only when the sky changed (#62)
  function update(d: number) {
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
    // Settings can pin the time of day; 'auto' follows walked distance (#72)
    const tod = props.timeOfDay ?? 'auto'
    const phase = tod === 'auto' ? dayPhase(d) : TIME_PHASES[tod]
    // floodlights read as lit only after dark (#72) — one shared unlit material
    mat.floodOn.color.setHex(isNight(phase) ? 0xfff2c8 : 0x9aa0a8)
    const bodies = skyBodies(phase)
    // keep the light rig centred on the walker so its shadow box stays useful
    sunTarget.position.set(camera.position.x, 0, camera.position.z)
    sun.position.set(
      camera.position.x + Math.cos(bodies.sun.azimuth) * Math.cos(bodies.sun.elevation) * SUN_DIST,
      Math.max(2, Math.sin(bodies.sun.elevation) * SUN_DIST),
      camera.position.z + Math.sin(bodies.sun.azimuth) * Math.cos(bodies.sun.elevation) * SUN_DIST,
    )
    const sky = skyAt(phase, weather)
    scene.fog!.color.setHex(sky.fog)
    const domeKey = sky.sky * 0x1000000 + sky.fog
    if (domeKey !== lastDomeKey) {
      lastDomeKey = domeKey
      paintDome(sky.sky, sky.fog)
    }
    dome.position.set(camera.position.x, 0, camera.position.z)
    skylineMesh.position.set(camera.position.x, 30, camera.position.z)
    // pull it toward the horizon colour so it recedes in fog and darkens at night
    skylineMat.color.setHex(sky.fog)
    treeLineMesh.position.set(
      camera.position.x,
      TREELINE_H * (TREELINE_GROUND_V - 0.5),
      camera.position.z,
    )
    // Less haze than the skyline gets — it is nearer, so it keeps more of its own colour —
    // but the same darkness handling, since neither backdrop is lit by the scene.
    treeLineMat.color.setHex(backdropTint(sky, phase, 0.35))
    const level = paintLevel(phase)
    for (const [m, base] of painted) m.color.setHex(base).multiplyScalar(level)
    sun.intensity = sky.sunIntensity
    sun.color.setHex(sky.sunColor)
    hemi.intensity = sky.ambient
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
      // Lit by the same sun the ground is (cloudColor), so the shell reads as cloud by day
      // and sinks back into the sky after dark — a white shell would double the night sky's
      // luminance, the "weather brightens the night" mistake by a different route.
      ;(clouds.material as THREE.MeshBasicMaterial).color.setHex(cloudColor(sky, phase))
    }
    // Pacers: analytic positions, so no accumulated state to drift. Anything beyond the
    // current weather's fog distance is hidden rather than drawn — with eight on a 400 m
    // loop, typically three or four are actually visible.
    const wanted = TIER_BUDGET[tier].pacers
    const list = pacers(sessionSeconds, wanted)
    // Forward direction in the xz plane, from the same point the camera is looking at.
    // Used to reject pacers behind the walker — labelling someone you have already
    // overtaken puts a name tag on empty screen.
    const fwdX = ahead.x - camera.position.x
    const fwdZ = ahead.z - camera.position.z
    const fwdLen = Math.hypot(fwdX, fwdZ) || 1
    let nearestIdx = -1
    let nearestDist = Infinity
    for (let i = 0; i < pacerRigs.length; i++) {
      const rig = pacerRigs[i]!
      const p: Pacer | undefined = list[i]
      if (!p) {
        rig.group.visible = false
        continue
      }
      // Arc distance is measured along the lane's own surveyed line, but the body is DRAWN at
      // p.drawO — offset to one side of the lane centre, so when a faster pacer laps a slower
      // one in the same lane (which happens within about a minute) it reads as an overtake
      // rather than two meshes intersecting.
      const laneO = laneMeasurementO(p.lane)
      // p.d grows for the whole session and laneDistanceToS costs O(d) — wrap to one lap of
      // this lane first, which is equivalent because the track is a loop.
      const laneLap = LAP_M + 2 * Math.PI * laneO
      const at = trackPoint(laneDistanceToS(laneO, p.d % laneLap), p.drawO)
      const dx = at.x - camera.position.x
      const dz = at.z - camera.position.z
      const far = fogBand.far
      if (dx * dx + dz * dz > far * far) {
        rig.group.visible = false
        continue
      }
      rig.group.visible = true
      const dist = Math.hypot(dx, dz)
      // positive dot product = in front of the walker
      const forwardness = (dx * fwdX + dz * fwdZ) / fwdLen
      if (dist < 30 && forwardness > 0 && dist < nearestDist) {
        nearestDist = dist
        nearestIdx = i
      }
      rig.group.position.set(at.x, 0, at.z)
      // the tangent comes from trackPoint, not from the Pacer — a Pacer has no heading
      rig.group.rotation.y = Math.atan2(-at.tx, -at.tz)
      // limbs swing in antiphase, arms opposite legs, at the pacer's own cadence.
      // Arms swing LESS than legs, not more. From behind — the only angle a walker sees a
      // pacer from — a wide arm swing foreshortens into a splayed "cactus" pose instead of
      // reading as a pump alongside the torso.
      // Faster runners take LONGER steps, not just quicker ones — a fixed step length makes
      // the quick ones look like they are sprinting on the spot.
      const ph = stepPhase(p.d, gaitCycleM(0.6 + 0.045 * p.speed)) * Math.PI * 2
      const swing = Math.sin(ph)
      rig.legL.rotation.x = swing * 0.55
      rig.legR.rotation.x = -swing * 0.55
      rig.armL.rotation.x = -swing * 0.4
      rig.armR.rotation.x = swing * 0.4
    }
    // Target-pace rabbit: same split-limb rig and swing amplitudes as the pacers above.
    const rd = props.rabbitDistance
    if (rd == null) {
      rabbitGroup.visible = false
    } else {
      rabbitGroup.visible = true
      // The rabbit is an instrument, not scenery — it has to stay readable after dark.
      rabbitKit.emissiveIntensity = isNight(phase) ? 0.75 : 0.2
      const o = laneMeasurementO(2)
      // Draw at the lane centre like the pacers, or a lane-2 pacer overtaking the rabbit
      // intersects it — their draw slots are only 0.11 m apart, inside the torso radius.
      const rabbitDrawO = TRACK_IN + 1.5 * LANE_W
      const at = trackPoint(laneDistanceToS(o, rd % (LAP_M + 2 * Math.PI * o)), rabbitDrawO)
      rabbitGroup.position.set(at.x, 0, at.z)
      rabbitGroup.rotation.y = Math.atan2(-at.tx, -at.tz)
      // No target-speed prop reaches the rabbit here (only its distance does), so it swings
      // at the default walking gait cycle rather than a speed-scaled one like the pacers.
      const ph = stepPhase(rd, gaitCycleM(0.72)) * Math.PI * 2
      const rabbitSwing = Math.sin(ph)
      rabbitLegL.rotation.x = rabbitSwing * 0.55
      rabbitLegR.rotation.x = -rabbitSwing * 0.55
      rabbitArmL.rotation.x = -rabbitSwing * 0.4
      rabbitArmR.rotation.x = rabbitSwing * 0.4
    }
    if (nearestIdx >= 0) {
      const p = list[nearestIdx]!
      const rig = pacerRigs[nearestIdx]!
      drawLabel(`${p.kind} · ${p.speed.toFixed(1)} km/h`)
      labelSprite.position.set(rig.group.position.x, 2.1, rig.group.position.z)
      // A Sprite shrinks with distance, so a fixed world size is unreadable at 30 m and
      // overwhelming at 2 m. Grow it with range, clamped at both ends. The upper clamp is
      // deliberately modest: a label sized to stay crisp at 30 m projects onto the horizon
      // line, where it reads as a billboard hanging in the sky rather than a name over
      // someone's head. Past LABEL_FADE_M it fades out instead of growing further.
      const s = Math.min(1.5, Math.max(0.6, nearestDist / 12))
      labelSprite.scale.set(2.2 * s, 0.55 * s, 1)
      labelSprite.material.opacity = 1 - smoothstep(LABEL_FADE_M, LABEL_MAX_M, nearestDist)
      labelSprite.visible = labelSprite.material.opacity > 0.02
    } else {
      labelSprite.visible = false
    }
    renderer!.render(scene, camera)
  }

  function applyTier(next: Tier) {
    tier = next
    budget = TIER_BUDGET[tier]
    // regenerate at the new resolution and swap the maps in place — the materials and
    // meshes stay, only the texture objects change, so the baked geometry is untouched
    const old = tex
    tex = makeTextures(budget.textureSize)
    const remap: [THREE.Material, THREE.Texture][] = [
      [mat.trunk, tex.bark],
      [mat.crown1, tex.canopy1],
      [mat.crown2, tex.canopy2],
      [mat.pine, tex.foliage],
      [mat.kerb, tex.concrete],
      [mat.grass, tex.grass],
      [mat.infield, tex.infield],
      [mat.track, tex.tartan],
      [mat.seating, tex.seating],
      [mat.fence, tex.chainLink],
      [skylineMat, tex.skyline],
      [mat.sand, tex.sand],
      // pitchLines is intentionally NOT here: it never changes resolution (always 1024),
      // and makeTextures() hands back the same memoized texture object every call, so
      // mat.pitch.map already points at the current one — remapping it would be a no-op.
    ]
    for (const [m, t] of remap) {
      const mm = m as THREE.Material & { map?: THREE.Texture | null }
      mm.map = t
      mm.needsUpdate = true
    }
    // pitchLines is excluded here too — old.pitchLines and tex.pitchLines are the SAME
    // memoized object (see makeTextures), so disposing it would kill the texture
    // mat.pitch is still using.
    Object.entries(old).forEach(([k, t]) => {
      if (k !== 'pitchLines') t.dispose()
    })
    if (budget.shadowMap && !renderer!.shadowMap.enabled) enableShadows()
    else if (!budget.shadowMap && renderer!.shadowMap.enabled) {
      // downgrade: stop paying for the depth pre-pass, and bring the blobs back
      renderer!.shadowMap.enabled = false
      sun.castShadow = false
    }
    if (blobMesh) blobMesh.visible = !budget.shadowMap
    // addClouds() is idempotent, so this pair is safe on repeated toggles either way —
    // without the visible=false half, a Quality->Performance downgrade left the drifting
    // cloud shell on forever, contradicting "on Performance there are none" (same shape
    // as the shadow-disable bug fixed previously: a tier path written one-way).
    if (budget.clouds) addClouds()
    if (clouds) clouds.visible = budget.clouds
    starGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(starPositions(budget.stars, SKY_R), 3),
    )
    // Draw the change. update() is the only path to renderer.render(), and frame() skips it
    // while the belt is stopped, so without this the Settings control does nothing at all
    // until the walker moves.
    update(display)
  }

  let last = performance.now()
  let lastRendered = Infinity // skip GPU work while the belt is stopped and nothing moved (#62)
  let lastPacerRender = 0
  function frame(now: number) {
    if (disposed) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    sessionSeconds += dt
    if (!probeDone) {
      probeSamples.push(dt * 1000)
      if (probeSamples.length >= PROBE_FRAMES) {
        probeDone = true
        const next = resolveTier(props.quality ?? 'auto', tierFromFrames(probeSamples))
        if (next !== tier) applyTier(next)
      }
    }
    const target = props.distance
    if (Math.abs(target - display) > LAP_M / 4) display = target // view (re)opened — snap
    // advance at belt speed, gently corrected toward the true integrated distance
    display += ((props.speed * 1000) / 3600) * dt + (target - display) * dt * 1.5
    // The distance gate assumes a static scene when the belt is stopped — true before pacers
    // existed. They keep moving while you stand still, so force a redraw at ~30 Hz even when
    // the walked distance has not changed.
    const moved = Math.abs(display - lastRendered) > 0.003
    if (moved || sessionSeconds - lastPacerRender > 1 / 30) {
      lastPacerRender = sessionSeconds
      lastRendered = display
      update(display)
    }
    raf = requestAnimationFrame(frame)
  }

  function startLoop() {
    if (disposed || reducedMotion) return
    cancelAnimationFrame(raf)
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }
  function stopLoop() {
    cancelAnimationFrame(raf)
  }
  function onVisibility() {
    if (document.hidden) stopLoop()
    else startLoop()
  }
  document.addEventListener('visibilitychange', onVisibility)

  // GPU context loss (#60): without these handlers the rAF loop keeps rendering to a
  // dead context — frozen/black canvas for the rest of the session. preventDefault()
  // tells the browser we want a restore; if it never comes (or comes repeatedly), the
  // second loss falls back to the 2D track via `unsupported`.
  let contextLosses = 0
  function onContextLost(e: Event) {
    e.preventDefault()
    stopLoop()
    contextLosses++
    if (contextLosses > 1) emit('unsupported')
  }
  function onContextRestored() {
    if (disposed) return
    update(display)
    startLoop()
  }
  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)

  // reduced motion: no continuous animation loop — render discretely as distance ticks in.
  // watch() outside setup isn't auto-disposed, so keep the stop handle for cleanup.
  let stopDistanceWatch: (() => void) | null = null
  if (reducedMotion) {
    const t0 = performance.now()
    stopDistanceWatch = watch(
      () => [props.distance, props.rabbitDistance],
      () => {
        // no rAF loop here, so sessionSeconds has no other way to advance
        sessionSeconds = (performance.now() - t0) / 1000
        display = props.distance
        update(props.distance)
      },
    )
  }

  // Settings can change while the view is open. Without this the quality control appears
  // dead until the component remounts, because tier/probeDone are closure state captured
  // at mount. Switching back to 'auto' restarts the probe from scratch.
  const stopQualityWatch = watch(
    () => props.quality,
    (q) => {
      const setting = q ?? 'auto'
      probeSamples.length = 0
      probeDone = setting !== 'auto'
      if (probeDone && setting !== tier) applyTier(setting as Tier)
    },
  )

  // Same reason as stopQualityWatch: update() is the only path to renderer.render() and the
  // frame loop skips it while the belt is stopped, so without this a time-of-day change made
  // from Settings does nothing at all until the walker moves.
  const stopTimeWatch = watch(
    () => props.timeOfDay,
    () => update(display),
  )

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth
    const h = el.clientHeight
    if (!w || !h || !renderer) return
    // DPR can change under us (window dragged to another monitor, zoom) — re-check it
    // here rather than only at mount, or the canvas goes blurry/oversampled (#60)
    const dpr = Math.min(window.devicePixelRatio, 2)
    if (renderer.getPixelRatio() !== dpr) {
      renderer.setPixelRatio(dpr)
      starMat.size = 1.6 * dpr
    }
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    update(display)
  })
  ro.observe(el)

  update(display)
  startLoop()

  cleanup = () => {
    stopLoop()
    stopDistanceWatch?.()
    stopQualityWatch()
    stopTimeWatch()
    document.removeEventListener('visibilitychange', onVisibility)
    renderer?.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer?.domElement.removeEventListener('webglcontextrestored', onContextRestored)
    ro.disconnect()
    scene.clear()
    disposables.forEach((g) => g.dispose())
    signMats.forEach((m) => {
      m.map?.dispose()
      m.dispose()
    })
    numberGeo.dispose()
    numberMats.forEach((m) => {
      m.map?.dispose()
      m.dispose()
    })
    domeGeo.dispose()
    dome.material.dispose()
    glowTex.dispose()
    sunSprite.material.dispose()
    moonSprite.material.dispose()
    starGeo.dispose()
    starMat.dispose()
    cloudTex?.dispose()
    ;(clouds?.material as THREE.Material | undefined)?.dispose()
    blobTex.dispose()
    blobGeo.dispose()
    blobMat.dispose()
    skylineMat.dispose()
    treeLineTex.dispose()
    treeLineMat.dispose()
    Object.values(geo).forEach((g) => g.dispose())
    Object.values(mat).forEach((m) => m.dispose())
    Object.values(tex).forEach((t) => t.dispose())
    pacerBodyGeo.dispose()
    pacerHeadGeo.dispose()
    skinMat.dispose()
    pacerArmGeo.dispose()
    pacerLegGeo.dispose()
    pacerRigs.forEach((r) => r.kit.dispose())
    rabbitKit.dispose()
    avatarKit.dispose()
    armGeo.dispose()
    labelTex.dispose()
    labelSprite.material.dispose()
    renderer?.dispose()
    // dispose() alone leaves the context slot occupied until GC — force-release it so
    // repeated 2D↔3D toggles can't exhaust the browser's context budget (#60)
    renderer?.forceContextLoss()
    renderer?.domElement.remove()
    renderer = null
  }
})
</script>

<template>
  <div ref="host" class="scenic3d"></div>
</template>

<style scoped>
.scenic3d {
  width: 100%;
  aspect-ratio: 400 / 260;
  border-radius: 16px;
  overflow: hidden;
  background: #12151b;
}
.scenic3d :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
</style>
