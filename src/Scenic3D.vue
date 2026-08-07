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
} from './scenic'
import type { Prop } from './scenic'
import {
  ribbonArrays,
  stripArrays,
  geometryFrom,
  ensureUv,
  assertSameAttributes,
  REPEAT,
  tartanTexture,
  grassTexture,
  barkTexture,
  foliageTexture,
  concreteTexture,
  surface,
  blobShadowTexture,
} from './scenicMeshes'
import {
  dayPhase,
  skyAt,
  skyBodies,
  weatherFor,
  WEATHER_FOG,
  TIME_PHASES,
  isNight,
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
}>()
const emit = defineEmits<{ unsupported: [] }>()

const host = ref<HTMLDivElement | null>(null)

const EYE_HEIGHT = 1.6
const FOG_FAR = 230

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
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, FOG_FAR + 60)
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

  const hemi = new THREE.HemisphereLight(0xffffff, 0x30363f, 0.9)
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

  // Sky dome: vertex-color gradient from fog color at the horizon to sky color overhead,
  // following the camera. Kills the hard seam where fogged ground meets a flat background.
  // toneMapped:false is load-bearing — three.js applies fog AFTER tone mapping, so real
  // fogged geometry fades to the raw hex. If the dome were tone mapped it would no longer
  // match the fog it is painted to blend into, and the seam would come back.
  const domeGeo = new THREE.SphereGeometry(260, 24, 12)
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

  // --- shared geometries/materials ---
  const geo = {
    trunk: new THREE.CylinderGeometry(0.12, 0.18, 1, 5),
    crown: new THREE.IcosahedronGeometry(0.9, 0),
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
    crown1: surface({ color: 0xffffff, map: tex.foliage, roughness: 1, flatShading: true }),
    crown2: surface({ color: 0xc8e0a8, map: tex.foliage, roughness: 1, flatShading: true }),
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
  }

  function buildProp(p: Prop): THREE.Object3D {
    const g = new THREE.Group()
    if (p.type === 'tree') {
      const trunk = new THREE.Mesh(geo.trunk, mat.trunk)
      trunk.scale.set(1, 2.2, 1)
      trunk.position.y = 1.1
      const crown = new THREE.Mesh(geo.crown, p.seed < 0.5 ? mat.crown1 : mat.crown2)
      crown.position.y = 2.6
      crown.scale.setScalar(1.4)
      g.add(trunk, crown)
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
    if (!TIER_BUDGET[tier].shadowMap && p.type !== 'flood') {
      const blob = new THREE.Mesh(blobGeo, blobMat)
      blob.rotation.x = -Math.PI / 2
      blob.position.y = 0.03
      blob.scale.setScalar(1.6)
      g.add(blob)
    }
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
  const disposables: THREE.BufferGeometry[] = []
  const track = (mesh: THREE.Mesh) => {
    disposables.push(mesh.geometry as THREE.BufferGeometry)
    scene.add(mesh)
    return mesh
  }

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
    const m = new THREE.MeshBasicMaterial({ map: digitTexture(ln.lane), transparent: true })
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
    const boardMat = new THREE.MeshBasicMaterial({ map: signTexture(sign.label) })
    signMats.push(boardMat)
    const board = new THREE.Mesh(geo.head, boardMat)
    board.scale.set(0.9, 1.5, 0.5)
    board.position.set(at.x, 2.5, at.z)
    // face the walker approaching from lower s (board's +z looks at that point)
    const facing = trackPoint(sign.s - 10, TRACK_OUT + 1.6)
    board.lookAt(facing.x, 2.5, facing.z)
    scene.add(board)
  }

  for (const p of surroundings()) scene.add(buildProp(p))

  // Bake the static world into one mesh per material (#62): the loop ribbons, cross
  // strips, and ~50 scenery groups otherwise cost ~350 draw calls per frame on a scene
  // that never changes. The dome and lights stay live.
  {
    scene.updateMatrixWorld(true)
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>()
    // sunTarget is a plain Object3D, not a Light, so it would otherwise be swept into
    // staticRoots and removed — after which its matrixWorld freezes and the directional
    // light aims at the origin instead of following the walker.
    const staticRoots = scene.children.filter(
      (c) => c !== dome && !(c as THREE.Light).isLight && c !== sunTarget,
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
      if (!merged) continue
      disposables.push(merged)
      const m = new THREE.Mesh(merged, material)
      if (material === blobMat) blobMesh = m
      // everything in the scenery ring both casts and receives; the flat painted
      // markings only receive, or their 4 cm lift casts a visible false shadow
      const painted =
        material === mat.laneLine ||
        material === mat.finish ||
        material === mat.relay ||
        material === mat.hurdle ||
        material === mat.breakLine
      // Flat ground ribbons must not cast: they are DoubleSide, so they write their own
      // depth into the shadow map and self-shadow into acne, and the kerb's 6 cm lift
      // throws a false stripe across the track at low sun angles. Nothing is under them.
      const flatGround = material === mat.track || material === mat.infield || material === mat.kerb
      m.castShadow = !painted && !flatGround
      m.receiveShadow = true
      scene.add(m)
    }
  }

  // --- camera + sky per frame ---
  let display = props.distance // smoothed distance the camera actually sits at
  let lastDomeKey = -1 // repaint the ~350 dome vertex colors only when the sky changed (#62)
  function update(d: number) {
    const p = trackPoint(d)
    camera.position.set(p.x, EYE_HEIGHT, p.z)
    const ahead = trackPoint(d + 10)
    camera.lookAt(ahead.x, EYE_HEIGHT - 0.2, ahead.z)
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
    sun.intensity = sky.sunIntensity
    sun.color.setHex(sky.sunColor)
    hemi.intensity = sky.ambient
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
    if (budget.shadowMap && !renderer!.shadowMap.enabled) enableShadows()
    else if (!budget.shadowMap && renderer!.shadowMap.enabled) {
      // downgrade: stop paying for the depth pre-pass, and bring the blobs back
      renderer!.shadowMap.enabled = false
      sun.castShadow = false
    }
    if (blobMesh) blobMesh.visible = !budget.shadowMap
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let last = performance.now()
  let lastRendered = Infinity // skip GPU work while the belt is stopped and nothing moved (#62)
  function frame(now: number) {
    if (disposed) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
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
    if (Math.abs(display - lastRendered) > 0.003) {
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
    stopDistanceWatch = watch(
      () => props.distance,
      (d) => {
        display = d
        update(d)
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

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth
    const h = el.clientHeight
    if (!w || !h || !renderer) return
    // DPR can change under us (window dragged to another monitor, zoom) — re-check it
    // here rather than only at mount, or the canvas goes blurry/oversampled (#60)
    const dpr = Math.min(window.devicePixelRatio, 2)
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr)
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
    blobTex.dispose()
    blobGeo.dispose()
    blobMat.dispose()
    Object.values(geo).forEach((g) => g.dispose())
    Object.values(mat).forEach((m) => m.dispose())
    Object.values(tex).forEach((t) => t.dispose())
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
