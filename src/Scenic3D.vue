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
import {
  trackPoint,
  LAP_M,
  LANE_W,
  LANES,
  TRACK_IN,
  TRACK_OUT,
  surroundings,
  dayPhase,
  skyAt,
} from './scenic'
import type { Prop } from './scenic'

const props = defineProps<{ distance: number; speed: number }>()
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
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
    emit('unsupported')
    return
  }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, FOG_FAR + 60)
  scene.fog = new THREE.Fog(0x000000, 60, FOG_FAR)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x30363f, 0.9)
  const sun = new THREE.DirectionalLight(0xffffff, 1)
  sun.position.set(-40, 60, 30)
  scene.add(hemi, sun)

  // Sky dome: vertex-color gradient from fog color at the horizon to sky color overhead,
  // following the camera. Kills the hard seam where fogged ground meets a flat background.
  const domeGeo = new THREE.SphereGeometry(260, 24, 12)
  const domeColors = new THREE.Float32BufferAttribute(
    new Float32Array(domeGeo.attributes.position!.count * 3),
    3,
  )
  domeGeo.setAttribute('color', domeColors)
  const dome = new THREE.Mesh(
    domeGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }),
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
  const flat = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true })
  const mat = {
    trunk: flat(0x5d4634),
    crown1: flat(0x3f7d3a),
    crown2: flat(0x59923e),
    pine: flat(0x2c5d33),
    rock: flat(0x777d87),
    pole: flat(0x4a505b),
    floodOn: new THREE.MeshBasicMaterial({ color: 0xfff2c8 }), // unlit — reads as lit at night
    grass: new THREE.MeshLambertMaterial({ color: 0x2f4a2b }),
    // The loop ribbons reverse travel direction halfway around, so a fixed triangle
    // winding faces down on one straight and up on the other — DoubleSide instead of
    // per-segment winding gymnastics (they're flat strips only ever seen from above).
    infield: new THREE.MeshLambertMaterial({ color: 0x355530, side: THREE.DoubleSide }),
    track: new THREE.MeshLambertMaterial({ color: 0x9c4238, side: THREE.DoubleSide }), // red tartan
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
    return g
  }

  // Closed ribbon around the whole loop between lateral offsets [o0, o1], sampled every
  // 2 m. Winding chosen so face normals point +y (visible from above; FrontSide culling).
  function buildLoopRibbon(o0: number, o1: number, y: number, m: THREE.Material): THREE.Mesh {
    const step = 2
    const n = Math.ceil(LAP_M / step)
    const pts: number[] = []
    const idx: number[] = []
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * LAP_M
      const a = trackPoint(s, o0)
      const b = trackPoint(s, o1)
      pts.push(a.x, y, a.z, b.x, y, b.z)
      if (i > 0) {
        const k = (i - 1) * 2
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    return new THREE.Mesh(g, m)
  }

  // Short strip across the track at arc position s (start/finish line).
  function buildCrossStrip(s: number, widthM: number, y: number, m: THREE.Material): THREE.Mesh {
    const a0 = trackPoint(s, TRACK_IN)
    const a1 = trackPoint(s, TRACK_OUT)
    const b0 = trackPoint(s + widthM, TRACK_IN)
    const b1 = trackPoint(s + widthM, TRACK_OUT)
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [a0.x, y, a0.z, a1.x, y, a1.z, b0.x, y, b0.z, b1.x, y, b1.z],
        3,
      ),
    )
    g.setIndex([0, 2, 1, 1, 2, 3])
    g.computeVertexNormals()
    return new THREE.Mesh(g, m)
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
  track(buildLoopRibbon(TRACK_IN - 30, TRACK_IN, 0.0, mat.infield))
  // the red track band with white lane lines (lines sit 4 cm above the surface —
  // less separation z-fights into shimmer on the far side of the loop)
  track(buildLoopRibbon(TRACK_IN, TRACK_OUT, 0.02, mat.track))
  for (let lane = 0; lane <= LANES; lane++) {
    const o = TRACK_IN + lane * LANE_W
    track(buildLoopRibbon(o - 0.03, o + 0.03, 0.06, mat.laneLine))
  }
  // start/finish line at s = 0
  track(buildCrossStrip(0, 0.5, 0.07, mat.finish))

  for (const p of surroundings()) scene.add(buildProp(p))

  // --- camera + sky per frame ---
  let display = props.distance // smoothed distance the camera actually sits at
  function update(d: number) {
    const p = trackPoint(d)
    camera.position.set(p.x, EYE_HEIGHT, p.z)
    const ahead = trackPoint(d + 10)
    camera.lookAt(ahead.x, EYE_HEIGHT - 0.2, ahead.z)
    const sky = skyAt(dayPhase(d))
    scene.fog!.color.setHex(sky.fog)
    paintDome(sky.sky, sky.fog)
    dome.position.set(camera.position.x, 0, camera.position.z)
    sun.intensity = sky.sunIntensity
    sun.color.setHex(sky.sunColor)
    hemi.intensity = sky.ambient
    renderer!.render(scene, camera)
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let last = performance.now()
  function frame(now: number) {
    if (disposed) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const target = props.distance
    if (Math.abs(target - display) > LAP_M / 4) display = target // view (re)opened — snap
    // advance at belt speed, gently corrected toward the true integrated distance
    display += ((props.speed * 1000) / 3600) * dt + (target - display) * dt * 1.5
    update(display)
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

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth
    const h = el.clientHeight
    if (!w || !h || !renderer) return
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
    document.removeEventListener('visibilitychange', onVisibility)
    ro.disconnect()
    scene.clear()
    disposables.forEach((g) => g.dispose())
    domeGeo.dispose()
    dome.material.dispose()
    Object.values(geo).forEach((g) => g.dispose())
    Object.values(mat).forEach((m) => m.dispose())
    renderer?.dispose()
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
