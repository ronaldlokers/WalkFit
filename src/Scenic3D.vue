<script setup lang="ts">
// First/third-person 3D walk around the 400 m athletics track (#51, #220). Lazy-loaded (this file
// pulls in three.js, so App.vue imports it with defineAsyncComponent — the chunk only
// downloads when scenic is opened). All world *decisions* (track geometry, scenery
// placement, sky cycle) live in scenic.ts; this component only turns them into meshes.
// The camera walks the lane-1 line (loop world → the whole scene is static, no
// streaming) and interpolates toward the walked distance at roughly belt speed, so
// motion stays smooth despite the ~4 Hz distance updates from the treadmill ticker.
import { onMounted, onBeforeUnmount, watch, ref } from 'vue'
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
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
  strideLength,
  limbSwing,
  cameraMotion,
  FOV_BASE_DEG,
  FOV_EPSILON_DEG,
} from './scenicLife'
import type { Pacer } from './scenicLife'
import { avatarStyleConfig, cameraViewConfig, playerGait } from './scenicPlayer'
import type { AvatarStyle, CameraView } from './scenicPlayer'
import { loadScenicManifest } from './scenicAssets'
import type { ScenicAssetCache as ScenicAssetCacheType } from './scenicAssetLoader'
import { scenicParkPlacements } from './scenicPark'
import {
  stadium,
  PART_SIZES,
  SKYLINE_R,
  grassTufts,
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
  normalFromTexture,
  tuftGeometry,
  tuftTexture,
  contactShade,
  treeLineTexture,
  TREELINE_GROUND_V,
  sandTexture,
  tileUv,
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
  daylight,
} from './scenicSky'
import type { TimeOfDay } from './scenicSky'
import { tierFromFrames, resolveTier, PROBE_FRAMES, TIER_BUDGET } from './scenicQuality'
import type { Tier, QualitySetting } from './scenicQuality'

const props = defineProps<{
  distance: number
  speed: number
  active?: boolean // treadmill is actually moving; separates idle pose from selected speed
  weatherSeed?: number // per-walk weather pick (#72); omitted = clear
  timeOfDay?: TimeOfDay // Settings override; 'auto' follows walked distance
  quality?: QualitySetting
  steps?: number
  rabbitDistance?: number | null // target-pace rabbit (#realism slice 3); null/omitted = none
  motion?: boolean // head bob / sway / bend lean (#realism slice 4); omitted = on
  cameraView?: CameraView // Scenic v3 player camera; omitted preserves first person
  avatarStyle?: AvatarStyle // local outfit palette; omitted uses sky
}>()
const emit = defineEmits<{ unsupported: [] }>()

const host = ref<HTMLDivElement | null>(null)

// Colour grade. This is the cheapest large step toward the look of a game that ships a
// colour pipeline: a touch of saturation and contrast around mid grey, plus a corner
// falloff. Kept deliberately mild — the palette is already authored for ACES, so this is a
// finishing pass, not a rescue.
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSaturation: { value: 1.28 },
    uContrast: { value: 1.09 },
    uVignette: { value: 0.22 },
    // How much of the grade to apply, 0..1. Driven from the daylight factor: contrast
    // around mid grey and a corner falloff both take away from the darks, and a night
    // frame has almost nothing BUT darks — applied at full strength after sunset they
    // crushed the track, the fence and the stand into one black field.
    uGrade: { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uVignette;
    uniform float uGrade;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, mix(1.0, uSaturation, uGrade));
      c = (c - 0.5) * mix(1.0, uContrast, uGrade) + 0.5;
      // radial falloff from the centre, squared so the corners darken and the middle is
      // left alone rather than the whole frame being dimmed
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - uVignette * uGrade * d * d * 2.0;
      gl_FragColor = vec4(max(c, 0.0), tex.a);
    }
  `,
}

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
  // Start the Scenic v3 asset boundary even while the manifest is empty. Loading failures
  // deliberately leave the procedural venue intact; an art/CDN/cache failure must never
  // blank treadmill controls or force the 2D fallback reserved for missing WebGL.
  let assetCache: ScenicAssetCacheType | null = null
  void loadScenicManifest(document.baseURI)
    .then(async (manifest) => {
      if (disposed || !manifest.assets.some((asset) => asset.path.endsWith('.glb'))) return
      // GLTFLoader and SkeletonUtils add ~70 kB minified. Keep them in their own dynamic
      // chunk and do not parse it until a manifest actually contains a model.
      const { ScenicAssetCache } = await import('./scenicAssetLoader')
      if (disposed) return
      const cache = new ScenicAssetCache(manifest, document.baseURI)
      const tree = await cache.instantiate('kenney-tree-detailed')
      if (disposed) {
        await cache.dispose()
        return
      }
      assetCache = cache
      if (tree) {
        // Keep the first asset compatible with manifests produced before the placement
        // list existed; the data-driven list below is authoritative for new kits.
        const placement = scenicParkPlacements().find(
          (candidate) => candidate.assetId === 'kenney-tree-detailed',
        )
        if (placement) {
          const at = trackPoint(placement.s, placement.o)
          tree.scene.position.set(at.x, 0, at.z)
          tree.scene.rotation.y = placement.rotation
          tree.scene.scale.setScalar(placement.scale)
          tree.scene.traverse((object) => {
            const mesh = object as THREE.Mesh
            if (mesh.isMesh) {
              mesh.castShadow = true
              mesh.receiveShadow = true
            }
          })
          scene.add(tree.scene)
        }
      }
      // Each clone shares the cache's source GPU resources. A failed or missing asset is
      // simply skipped, leaving the procedural venue visible and interactive.
      for (const placement of scenicParkPlacements()) {
        if (placement.assetId === 'kenney-tree-detailed') continue
        const instance = await cache.instantiate(placement.assetId)
        if (!instance || disposed) continue
        const at = trackPoint(placement.s, placement.o)
        instance.scene.position.set(at.x, 0, at.z)
        instance.scene.rotation.y = placement.rotation
        instance.scene.scale.setScalar(placement.scale)
        instance.scene.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (mesh.isMesh) {
            mesh.castShadow = true
            mesh.receiveShadow = true
          }
        })
        scene.add(instance.scene)
      }
    })
    .catch(() => {})
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
  let tier: Tier = props.quality === 'high' || props.quality === 'ultra' ? props.quality : 'low'
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

  // Shadow box re-centred on the walker each frame, sized by the tier. Fitting it to the
  // whole 400 m loop would spend nearly all the map's resolution on geometry behind you —
  // and shrinking the box is the cheapest way to buy texels per metre, which is what makes
  // a contact edge crisp rather than a soft smear.
  function enableShadows(size: number, boxM: number) {
    renderer!.shadowMap.enabled = true
    // PCFSoftShadowMap was removed in three r185 and now only warns before falling back
    // to PCFShadowMap. Select the supported map explicitly so opening 3D stays warning-free.
    renderer!.shadowMap.type = THREE.PCFShadowMap
    sun.castShadow = true
    sun.shadow.mapSize.set(size, size)
    // three keeps the depth target until the map is disposed, so a tier change that only
    // changes mapSize would otherwise keep rendering at the old resolution.
    sun.shadow.map?.dispose()
    sun.shadow.map = null
    const cam = sun.shadow.camera
    cam.left = -boxM
    cam.right = boxM
    cam.top = boxM
    cam.bottom = -boxM
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
  const domeGeo = new THREE.SphereGeometry(DOME_R, 32, 16)
  // The gradient is evaluated per FRAGMENT, not interpolated between ~350 vertices. A
  // vertex gradient on a 24x12 sphere bands visibly across a clear sky, and it cannot carry
  // a sun halo at all: the halo is a few degrees wide and would land between vertices.
  const domeUniforms = {
    uSky: { value: new THREE.Color(0x6ba8e8) },
    uFog: { value: new THREE.Color(0xb9d4ee) },
    uSunColor: { value: new THREE.Color(0xffffff) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunUp: { value: 1 }, // 0 below the horizon: no halo on a night sky
  }
  const domeMat = new THREE.ShaderMaterial({
    uniforms: domeUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // toneMapped:false is load-bearing — three applies fog AFTER tone mapping, so real
    // fogged geometry fades to the raw hex. Tone mapping the dome would stop it matching
    // the fog it exists to blend into, and the ground/sky seam would come back.
    toneMapped: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSky;
      uniform vec3 uFog;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uSunUp;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        // Rayleigh-ish: the horizon is the longest path through the atmosphere, so it
        // carries the most scattering. pow() biases the ramp toward the horizon rather
        // than putting the midpoint at 45 degrees, which is what a linear ramp does and
        // why the old dome read as a flat backdrop.
        float h = pow(clamp(dir.y, 0.0, 1.0), 0.42);
        vec3 col = mix(uFog, uSky, h);
        // Mie: a tight disc for the sun itself and a broad glow around it, both fading out
        // as the sun sets so a set sun cannot leave a bright patch on the horizon.
        float c = max(dot(dir, normalize(uSunDir)), 0.0);
        float halo = pow(c, 220.0) * 0.55 + pow(c, 12.0) * 0.22 + pow(c, 3.0) * 0.06;
        col += uSunColor * halo * uSunUp;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
  const dome = new THREE.Mesh(domeGeo, domeMat)
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
  const maxStars = Math.max(...Object.values(TIER_BUDGET).map((candidate) => candidate.stars))
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions(maxStars, SKY_R), 3))
  starGeo.setDrawRange(0, TIER_BUDGET[tier].stars)
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

  const cAmbient = new THREE.Color()
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
  function makeTextures(size: number, withNormals: boolean) {
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
    // Normal maps come LAST so each one inherits its source's final repeat — derived
    // before the repeats above are set, every normal would tile at 1:1 while its colour map
    // tiled at 80:1, and the lighting would slide across the surface it belongs to.
    // Only the surfaces with real microrelief get one; a chain-link alpha or a painted
    // marking has no height to encode.
    const normals = withNormals
      ? {
          tartan: normalFromTexture(t.tartan, 2.5),
          infield: normalFromTexture(t.infield, 1.6),
          grass: normalFromTexture(t.grass, 1.6),
          concrete: normalFromTexture(t.concrete, 2),
          seating: normalFromTexture(t.seating, 2),
          sand: normalFromTexture(t.sand, 2.5),
        }
      : null
    if (normals) for (const n of Object.values(normals)) n.anisotropy = aniso
    return { ...t, normals }
  }
  // Task 6 deliberately left this out because nothing read it yet; it has a reader now.
  let budget = TIER_BUDGET[tier]
  // an explicit quality: 'high' setting must get shadows immediately — the probe that
  // would otherwise call this (via applyTier) never runs when the tier isn't 'auto'.
  if (budget.shadowMapSize) enableShadows(budget.shadowMapSize, budget.shadowBoxM)
  let tex = makeTextures(budget.textureSize, budget.normalMaps)

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
      normalMap: tex.normals?.concrete,
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    breakLine: new THREE.MeshBasicMaterial({ color: 0x3ba55d, side: THREE.DoubleSide }),
    relay: new THREE.MeshBasicMaterial({ color: 0xd8b638, side: THREE.DoubleSide }),
    hurdle: new THREE.MeshBasicMaterial({ color: 0x2e7d4f, side: THREE.DoubleSide }),
    grass: surface({
      color: 0xffffff,
      map: tex.grass,
      normalMap: tex.normals?.grass,
      normalScale: 0.6,
      roughness: 1,
    }),
    // The loop ribbons reverse travel direction halfway around, so a fixed triangle
    // winding faces down on one straight and up on the other — DoubleSide instead of
    // per-segment winding gymnastics (they're flat strips only ever seen from above).
    infield: surface({
      color: 0xffffff,
      map: tex.infield,
      normalMap: tex.normals?.infield,
      normalScale: 0.6,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
    track: surface({
      color: 0xffffff,
      map: tex.tartan,
      normalMap: tex.normals?.tartan,
      roughness: 0.85,
      side: THREE.DoubleSide,
    }),
    laneLine: new THREE.MeshBasicMaterial({ color: 0xdfe4ea, side: THREE.DoubleSide }),
    finish: new THREE.MeshBasicMaterial({ color: 0xf2f5f9, side: THREE.DoubleSide }),
    seating: surface({
      color: 0xffffff,
      map: tex.seating,
      normalMap: tex.normals?.seating,
      roughness: 0.9,
    }),
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
    sand: surface({
      color: 0xffffff,
      map: tex.sand,
      normalMap: tex.normals?.sand,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
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
  // How far you can see, relative to clear air. The two camera-following backdrops are
  // fog:false — real fog at their distance would saturate and erase them — so weather has
  // to reach them by hand, or a "mist" walk fades the trees 40 m away while leaving a
  // pin-sharp city on the horizon behind them.
  const clarity = fogBand.far / WEATHER_FOG.clear.far
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

  // Surfaces that lie flat on the ground: every vertex is at y = 0, so contact shading
  // would darken the whole thing uniformly instead of shading it.
  const FLAT_ON_GROUND = new Set<THREE.Material>([
    mat.grass,
    mat.infield,
    mat.track,
    mat.kerb,
    mat.pitch,
    mat.sand,
  ])

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
      // Contact darkening, baked once into the merged buffer. Skipped for the ground
      // surfaces (their vertices all sit at y = 0, so they would come out uniformly dark
      // rather than shaded) and for anything unlit, which ignores vertex colours anyway.
      const std = material as THREE.MeshStandardMaterial
      if (budget.contactShading && std.isMeshStandardMaterial && !FLAT_ON_GROUND.has(material)) {
        contactShade(merged)
        if (!std.vertexColors) {
          std.vertexColors = true
          std.needsUpdate = true
        }
      }
      disposables.push(merged)
      const m = new THREE.Mesh(merged, material)
      if (material === blobMat) {
        blobMesh = m
        // Session may mount straight onto Quality (shadows on) — hide the fake ground
        // contact discs immediately instead of waiting for a later applyTier() call.
        blobMesh.visible = !budget.shadowMapSize
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

  // --- post-processing: bloom + grading, ultra tier only ---
  // Built lazily, because the addons are only worth their bytes and their two extra
  // fullscreen passes on a machine that asked for them. A phone never gets here: at DPR 3
  // a fullscreen pass is the first thing that costs frames rather than watts.
  //
  // Colour handling note: three skips tone mapping in the material shaders whenever it is
  // rendering into a render target, and OutputPass applies it at the end instead. Fog and
  // the sky dome therefore still agree with each other — both arrive at OutputPass in the
  // same space — so the ground/sky seam the dome exists to hide stays hidden.
  let composer: EffectComposer | null = null
  let bloomPass: UnrealBloomPass | null = null
  // ShaderPass clones the uniform objects it is handed, so per-frame writes have to go to
  // the PASS's own uniforms — writing to GRADE_SHADER.uniforms updates nothing.
  let gradePass: ShaderPass | null = null
  function buildComposer() {
    if (composer) return
    composer = new EffectComposer(renderer!)
    composer.setPixelRatio(renderer!.getPixelRatio())
    composer.setSize(el.clientWidth || 1, el.clientHeight || 1)
    composer.addPass(new RenderPass(scene, camera))
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(el.clientWidth || 1, el.clientHeight || 1),
      0.2, // strength: a sheen on the brightest things, not a glow over everything
      0.6, // radius
      0.92, // threshold: only sunlit white and the floodlights clear this
    )
    composer.addPass(bloomPass)
    // Tone mapping and the sRGB conversion both live here once a composer is in play, and
    // the grade goes AFTER them, not before. Everything upstream of OutputPass is scene
    // referred and linear, where a contrast pivot at 0.5 is meaningless: a night frame sits
    // around 0.002-0.02, so (c - 0.5) * k + 0.5 drove every pixel of it negative and the
    // clamp turned the whole thing black. Measured, not guessed — mean frame luminance fell
    // from 23.6 to 1.5 with the pass in the wrong place.
    composer.addPass(new OutputPass())
    gradePass = new ShaderPass(GRADE_SHADER)
    composer.addPass(gradePass)
  }
  function disposeComposer() {
    composer?.dispose()
    bloomPass?.dispose()
    composer = null
    bloomPass = null
    gradePass = null
  }
  if (budget.post) buildComposer()

  // --- grass tufts: one InstancedMesh, added after the bake so it is never merged ---
  // Static geometry, but it animates (wind), so it cannot join the static world. One draw
  // call regardless of count.
  let tufts: THREE.InstancedMesh | null = null
  let tuftGeo: THREE.BufferGeometry | null = null
  let tuftTex: THREE.CanvasTexture | null = null
  const windUniform = { value: 0 }
  // An InstancedMesh's instance count is fixed at construction, so allocate for the
  // hungriest tier and draw a prefix of it — `tufts.count` is what actually gets rendered.
  const MAX_TUFTS = Math.max(...Object.values(TIER_BUDGET).map((b) => b.tufts))
  function addTufts(count: number) {
    if (tufts || !count) return
    tuftGeo = tuftGeometry()
    tuftTex = tuftTexture(256)
    const m = new THREE.MeshStandardMaterial({
      map: tuftTex,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    })
    // Wind, injected rather than written as a custom shader: this keeps three's own
    // lighting, fog and shadow chunks, which a from-scratch ShaderMaterial would have to
    // reimplement. Sway scales with uv.y so the roots stay planted and only the tips move.
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = windUniform
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWind;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           #ifdef USE_INSTANCING
             vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
           #else
             vec3 iPos = vec3(0.0);
           #endif
           float gust = sin(uWind * 1.7 + iPos.x * 0.35 + iPos.z * 0.29)
                      + 0.4 * sin(uWind * 3.1 + iPos.z * 0.7);
           transformed.x += gust * 0.09 * uv.y;
           transformed.z += gust * 0.05 * uv.y;`,
        )
    }
    tufts = new THREE.InstancedMesh(tuftGeo, m, count)
    tufts.castShadow = false // a blade's own shadow is not worth a depth pass
    tufts.receiveShadow = true
    const mtx = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const scl = new THREE.Vector3()
    const pos = new THREE.Vector3()
    grassTufts(count).forEach((t, i) => {
      const at = trackPoint(t.s, t.o)
      pos.set(at.x, 0, at.z)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.seed * Math.PI * 2)
      scl.setScalar(0.65 + t.scale * 0.5)
      tufts!.setMatrixAt(i, mtx.compose(pos, q, scl))
    })
    tufts.instanceMatrix.needsUpdate = true
    tufts.count = TIER_BUDGET[tier].tufts
    scene.add(tufts)
  }
  if (budget.tufts) addTufts(MAX_TUFTS)

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

  // --- your player rig (live, never baked) ---
  // First person keeps only the torso for its cast shadow; third person reveals the full
  // split-limb rig. It deliberately shares the NPC geometry and cadence model so the two
  // populations cannot drift into different proportions or animation timing.
  const avatarKit = new THREE.MeshStandardMaterial({
    color: avatarStyleConfig(props.avatarStyle ?? 'sky').kit,
    roughness: 0.8,
  })
  const avatarGroup = new THREE.Group()
  const avatarBody = new THREE.Mesh(pacerBodyGeo, avatarKit)
  avatarBody.castShadow = true
  avatarGroup.add(avatarBody)
  const avatarHead = new THREE.Mesh(pacerHeadGeo, skinMat)
  avatarHead.castShadow = true
  avatarGroup.add(avatarHead)
  const mkAvatarLimb = (g: THREE.BufferGeometry, x: number, y: number) => {
    const m = new THREE.Mesh(g, avatarKit)
    m.position.set(x, y, 0)
    m.castShadow = true
    avatarGroup.add(m)
    return m
  }
  const avatarArmL = mkAvatarLimb(pacerArmGeo, -0.22, 1.42)
  const avatarArmR = mkAvatarLimb(pacerArmGeo, 0.22, 1.42)
  const avatarLegL = mkAvatarLimb(pacerLegGeo, -0.09, 0.86)
  const avatarLegR = mkAvatarLimb(pacerLegGeo, 0.09, 0.86)
  scene.add(avatarGroup)

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
    const view = cameraViewConfig(props.cameraView ?? 'first')
    // Sway is a lateral offset in the world model's own terms, so it goes straight through
    // every trackPoint. Third person follows from behind on the same surveyed path; this
    // gives collision-safe framing on the open lane without a renderer-side physics system.
    const avatarAt = trackPoint(d, motion.dx)
    const cameraAt = trackPoint(d - view.followM, motion.dx)
    const cameraBob = motion.dy * view.motionScale
    camera.position.set(cameraAt.x, view.heightM + cameraBob, cameraAt.z)
    const ahead = trackPoint(d + view.lookAheadM, motion.dx)
    camera.lookAt(ahead.x, view.targetHeightM + cameraBob, ahead.z)
    const gait = playerGait(props.active ?? false, props.speed)
    const swing = limbSwing(d, stride)
    avatarGroup.position.set(avatarAt.x, 0, avatarAt.z)
    avatarGroup.rotation.y = Math.atan2(-avatarAt.tx, -avatarAt.tz)
    avatarHead.visible = view.showAvatar
    avatarArmL.visible = view.showAvatar
    avatarArmR.visible = view.showAvatar
    avatarLegL.visible = view.showAvatar
    avatarLegR.visible = view.showAvatar
    armL.visible = view.showViewmodelArms
    armR.visible = view.showViewmodelArms
    // rotateZ is applied AFTER lookAt every frame, and lookAt rebuilds the quaternion from
    // scratch, so the roll replaces itself each frame rather than accumulating.
    if (motion.roll !== 0) camera.rotateZ(motion.roll * view.motionScale)
    if (Math.abs(camera.fov - motion.fov) > FOV_EPSILON_DEG) {
      camera.fov = motion.fov
      camera.updateProjectionMatrix()
    }
    armL.rotation.x = swing * gait.armSwing
    armR.rotation.x = -swing * gait.armSwing
    avatarArmL.rotation.x = -swing * gait.armSwing
    avatarArmR.rotation.x = swing * gait.armSwing
    avatarLegL.rotation.x = swing * gait.legSwing
    avatarLegR.rotation.x = -swing * gait.legSwing
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
    domeUniforms.uSky.value.setHex(sky.sky)
    domeUniforms.uFog.value.setHex(sky.fog)
    domeUniforms.uSunColor.value.setHex(sky.sunColor)
    domeUniforms.uSunDir.value.set(
      Math.cos(bodies.sun.azimuth) * Math.cos(bodies.sun.elevation),
      Math.sin(bodies.sun.elevation),
      Math.sin(bodies.sun.azimuth) * Math.cos(bodies.sun.elevation),
    )
    // Fades over the last few degrees rather than switching off, or the halo pops out at
    // the exact frame the sun crosses the horizon.
    domeUniforms.uSunUp.value = Math.max(0, Math.min(1, bodies.sun.elevation / 0.12))
    dome.position.set(camera.position.x, 0, camera.position.z)
    skylineMesh.position.set(camera.position.x, 30, camera.position.z)
    // pull it toward the horizon colour so it recedes in fog and darkens at night
    skylineMat.color.setHex(sky.fog)
    skylineMat.opacity = 0.35 + 0.65 * clarity
    treeLineMesh.position.set(
      camera.position.x,
      TREELINE_H * (TREELINE_GROUND_V - 0.5),
      camera.position.z,
    )
    // Less haze than the skyline gets — it is nearer, so it keeps more of its own colour —
    // but the same darkness handling, since neither backdrop is lit by the scene.
    treeLineMat.color.setHex(backdropTint(sky, phase, 0.35 + 0.5 * (1 - clarity)))
    // 0.3 floor rather than 0: some saturation still helps a night frame, it is the
    // contrast and the vignette that cannot be afforded there.
    if (gradePass) gradePass.uniforms.uGrade!.value = 0.3 + 0.7 * daylight(phase)
    windUniform.value = sessionSeconds
    const level = paintLevel(phase)
    for (const [m, base] of painted) m.color.setHex(base).multiplyScalar(level)
    sun.intensity = sky.sunIntensity
    sun.color.setHex(sky.sunColor)
    hemi.intensity = sky.ambient
    // Ambient comes FROM the sky, so it carries the sky's colour: warm at dawn and sunset,
    // blue at midday. Pinned to white it lit a dawn track with noon-coloured fill, which is
    // what left the ground looking grey under a pink sky. Only PART of the way, though —
    // taking the fog colour outright multiplies the fill by a colour that has almost no
    // luminance at night, and the whole ground went black.
    hemi.color.setHex(0xffffff).lerp(cAmbient.setHex(sky.fog), 0.55)
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
      const swing = limbSwing(p.d, 0.6 + 0.045 * p.speed)
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
      const rabbitSwing = limbSwing(rd, 0.72)
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
    if (composer) composer.render()
    else renderer!.render(scene, camera)
  }

  function applyTier(next: Tier) {
    tier = next
    budget = TIER_BUDGET[tier]
    // regenerate at the new resolution and swap the maps in place — the materials and
    // meshes stay, only the texture objects change, so the baked geometry is untouched
    const old = tex
    tex = makeTextures(budget.textureSize, budget.normalMaps)
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
    // Normal maps follow their colour map through the tier change, and must be cleared when
    // the new tier has none — left pointing at the disposed set, the surface renders with a
    // dead texture; left pointing at the OLD tier's set, a downgrade keeps paying for it.
    const normalRemap: [THREE.Material, THREE.Texture | null][] = [
      [mat.track, tex.normals?.tartan ?? null],
      [mat.infield, tex.normals?.infield ?? null],
      [mat.grass, tex.normals?.grass ?? null],
      [mat.kerb, tex.normals?.concrete ?? null],
      [mat.seating, tex.normals?.seating ?? null],
      [mat.sand, tex.normals?.sand ?? null],
    ]
    for (const [m, n] of normalRemap) {
      const mm = m as THREE.MeshStandardMaterial
      mm.normalMap = n
      mm.needsUpdate = true
    }
    // pitchLines is excluded here too — old.pitchLines and tex.pitchLines are the SAME
    // memoized object (see makeTextures), so disposing it would kill the texture
    // mat.pitch is still using.
    Object.entries(old).forEach(([k, t]) => {
      if (k === 'pitchLines' || t === null) return
      if (k === 'normals')
        Object.values(t as Record<string, THREE.Texture>).forEach((n) => n.dispose())
      else (t as THREE.Texture).dispose()
    })
    if (budget.shadowMapSize) enableShadows(budget.shadowMapSize, budget.shadowBoxM)
    else if (renderer!.shadowMap.enabled) {
      // downgrade: stop paying for the depth pre-pass, and bring the blobs back
      renderer!.shadowMap.enabled = false
      sun.castShadow = false
    }
    if (blobMesh) blobMesh.visible = !budget.shadowMapSize
    // addClouds() is idempotent, so this pair is safe on repeated toggles either way —
    // without the visible=false half, a Quality->Performance downgrade left the drifting
    // cloud shell on forever, contradicting "on Performance there are none" (same shape
    // as the shadow-disable bug fixed previously: a tier path written one-way).
    if (budget.clouds) addClouds()
    if (clouds) clouds.visible = budget.clouds
    // Built once at the largest count any tier asks for; a tier change only changes how
    // many of them draw, because an InstancedMesh cannot grow after construction.
    if (budget.post) buildComposer()
    else disposeComposer()
    if (budget.tufts) addTufts(MAX_TUFTS)
    if (tufts) {
      tufts.visible = budget.tufts > 0
      tufts.count = budget.tufts
    }
    // The stable max-sized buffer avoids allocating an orphaned GPU attribute on every
    // Settings toggle; tiers only change how many points are drawn.
    starGeo.setDrawRange(0, budget.stars)
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
  const stopCameraWatch = watch(
    () => props.cameraView,
    () => update(display),
  )
  const stopActiveWatch = watch(
    () => props.active,
    () => update(display),
  )
  const stopAvatarStyleWatch = watch(
    () => props.avatarStyle,
    (style) => {
      avatarKit.color.setHex(avatarStyleConfig(style ?? 'sky').kit)
      update(display)
    },
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
    composer?.setPixelRatio(renderer.getPixelRatio())
    composer?.setSize(w, h)
    bloomPass?.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    update(display)
  })
  ro.observe(el)

  update(display)
  startLoop()

  cleanup = () => {
    void assetCache?.dispose()
    stopLoop()
    stopDistanceWatch?.()
    stopQualityWatch()
    stopTimeWatch()
    stopCameraWatch()
    stopActiveWatch()
    stopAvatarStyleWatch()
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
    disposeComposer()
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
    Object.values(tex).forEach((t) => {
      if (!t) return
      if (t instanceof THREE.Texture) t.dispose()
      else Object.values(t).forEach((n) => n.dispose())
    })
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
