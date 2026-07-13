<script setup lang="ts">
// First-person 3D scenic walk (#51). Lazy-loaded (this file pulls in three.js, so App.vue
// imports it with defineAsyncComponent — the chunk only downloads when scenic is opened).
// All world *decisions* (what exists at metre z) live in scenic.ts; this component only
// turns them into meshes and moves the camera. Camera z follows the walked distance and
// interpolates toward it at roughly belt speed, so motion is smooth despite the ~4 Hz
// distance updates from the treadmill ticker.
import { onMounted, onBeforeUnmount, watch, ref } from 'vue'
import * as THREE from 'three'
import {
  pathX,
  biomeAt,
  chunkProps,
  CHUNK_M,
  signpostsIn,
  dayPhase,
  skyAt,
  worldHash,
} from './scenic'
import type { Prop } from './scenic'

const props = defineProps<{ distance: number; speed: number }>()
const emit = defineEmits<{ unsupported: [] }>()

const host = ref<HTMLDivElement | null>(null)

const VIEW_AHEAD_M = 240 // build chunks this far ahead (fog hides the edge)
const VIEW_BEHIND_M = 40
const EYE_HEIGHT = 1.6
const PATH_W = 2.4

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
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, VIEW_AHEAD_M + 40)
  scene.fog = new THREE.Fog(0x000000, 35, VIEW_AHEAD_M - 10)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x30363f, 0.9)
  const sun = new THREE.DirectionalLight(0xffffff, 1)
  sun.position.set(-40, 60, 30)
  scene.add(hemi, sun)

  // Sky dome: vertex-color gradient from fog color at the horizon to sky color overhead,
  // following the camera. Kills the hard seam where fully-fogged ground meets a
  // flat-color background.
  const domeGeo = new THREE.SphereGeometry(260, 24, 12) // inside the camera far plane
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

  // --- shared geometries/materials (unit-size; per-mesh scale) ---
  const geo = {
    trunk: new THREE.CylinderGeometry(0.12, 0.18, 1, 5),
    crown: new THREE.IcosahedronGeometry(0.9, 0),
    cone: new THREE.ConeGeometry(0.8, 1.4, 6),
    rock: new THREE.IcosahedronGeometry(0.5, 0),
    box: new THREE.BoxGeometry(1, 1, 1),
    roof: new THREE.ConeGeometry(0.95, 0.7, 4),
    pole: new THREE.CylinderGeometry(0.05, 0.05, 1, 5),
    bulb: new THREE.SphereGeometry(0.14, 6, 5),
    reed: new THREE.CylinderGeometry(0.02, 0.04, 1, 4),
  }
  const flat = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true })
  const mat = {
    trunk: flat(0x5d4634),
    crown1: flat(0x3f7d3a),
    crown2: flat(0x59923e),
    pine: flat(0x2c5d33),
    rock: flat(0x777d87),
    wall: flat(0xb8a98c),
    roof: flat(0x8c4f3f),
    pole: flat(0x4a505b),
    bulb: new THREE.MeshBasicMaterial({ color: 0xffd98a }), // glows at night (unlit)
    reed: flat(0xb0a35e),
    edge: new THREE.MeshBasicMaterial({ color: 0x2ed573 }), // accent path edges, unlit
    water: new THREE.MeshLambertMaterial({ color: 0x2b5e8a }),
    sign: flat(0x9a8a6a),
  }
  const groundMats = new Map<number, THREE.MeshLambertMaterial>()
  const pathMats = new Map<number, THREE.MeshLambertMaterial>()
  const cached = (map: Map<number, THREE.MeshLambertMaterial>, color: number) => {
    let m = map.get(color)
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color })
      map.set(color, m)
    }
    return m
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
      for (let i = 0; i < 3; i++) {
        const layer = new THREE.Mesh(geo.cone, mat.pine)
        layer.scale.setScalar(1.5 - i * 0.35)
        layer.position.y = 1.6 + i * 1.0
        g.add(layer)
      }
      g.add(trunk)
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
    } else if (p.type === 'reed') {
      for (let i = 0; i < 3; i++) {
        const r = new THREE.Mesh(geo.reed, mat.reed)
        r.scale.y = 1.1 + worldHash(p.seed * 97 + i) * 0.6
        r.position.set((i - 1) * 0.18, r.scale.y / 2, worldHash(p.seed * 31 + i) * 0.3)
        r.rotation.z = (worldHash(p.seed * 53 + i) - 0.5) * 0.25
        g.add(r)
      }
    } else if (p.type === 'lamp') {
      const pole = new THREE.Mesh(geo.pole, mat.pole)
      pole.scale.y = 3.4
      pole.position.y = 1.7
      const bulb = new THREE.Mesh(geo.bulb, mat.bulb)
      bulb.position.y = 3.5
      g.add(pole, bulb)
    } else {
      // house
      const w = 3 + p.seed * 2.5
      const body = new THREE.Mesh(geo.box, mat.wall)
      body.scale.set(w, 2.6, w * 0.8)
      body.position.y = 1.3
      const roof = new THREE.Mesh(geo.roof, mat.roof)
      roof.scale.set(w * 0.85, 1.6, w * 0.7)
      roof.position.y = 3.4
      roof.rotation.y = Math.PI / 4
      g.add(body, roof)
      g.rotation.y = (p.seed - 0.5) * 0.6
    }
    g.position.set(p.x, 0, p.z)
    if (p.type !== 'house') g.scale.setScalar(p.scale)
    return g
  }

  function signTexture(km: number): THREE.CanvasTexture {
    const c = document.createElement('canvas')
    c.width = 128
    c.height = 64
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#efe7d5'
    ctx.fillRect(0, 0, 128, 64)
    ctx.fillStyle = '#1c222b'
    ctx.font = 'bold 34px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${km} km`, 64, 34)
    return new THREE.CanvasTexture(c)
  }

  // Path ribbon + accent edges for one chunk: quad strips following pathX, sampled
  // every 4 m. Built per chunk (geometry disposed with it).
  function buildRibbon(z0: number, z1: number, width: number, y: number, m: THREE.Material) {
    const step = 4
    const pts: number[] = []
    const idx: number[] = []
    let n = 0
    for (let z = z0; z <= z1 + 0.01; z += step) {
      const x = pathX(z)
      pts.push(x - width / 2, y, z, x + width / 2, y, z)
      if (n > 0) {
        const a = (n - 1) * 2
        // winding chosen so face normals point +y (visible from above; FrontSide culling)
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
      n++
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    return new THREE.Mesh(g, m)
  }

  function buildChunk(ci: number): THREE.Group {
    const g = new THREE.Group()
    const z0 = ci * CHUNK_M
    const z1 = z0 + CHUNK_M
    const biome = biomeAt(z0)

    const ground = new THREE.Mesh(geo.box, cached(groundMats, biome.ground))
    ground.scale.set(420, 0.1, CHUNK_M) // wide enough that its side edges stay past the fog
    ground.position.set(pathX(z0 + CHUNK_M / 2), -0.06, z0 + CHUNK_M / 2)
    g.add(ground)

    if (biome.water) {
      const water = new THREE.Mesh(geo.box, mat.water)
      water.scale.set(70, 0.06, CHUNK_M)
      water.position.set(pathX(z0 + CHUNK_M / 2) - 40, -0.02, z0 + CHUNK_M / 2)
      g.add(water)
    }

    g.add(buildRibbon(z0, z1, PATH_W, 0.02, cached(pathMats, biome.path)))
    // accent-green edge lines along both sides of the walkway
    const left = buildRibbon(z0, z1, 0.12, 0.03, mat.edge)
    left.position.x = -PATH_W / 2
    const right = buildRibbon(z0, z1, 0.12, 0.03, mat.edge)
    right.position.x = PATH_W / 2
    g.add(left, right)

    for (const p of chunkProps(ci)) g.add(buildProp(p))

    for (const s of signpostsIn(z0, z1)) {
      const post = new THREE.Mesh(geo.pole, mat.sign)
      post.scale.y = 2.2
      post.position.set(pathX(s.z) + 2.2, 1.1, s.z)
      const board = new THREE.Mesh(geo.box, new THREE.MeshBasicMaterial({ map: signTexture(s.km) }))
      board.scale.set(1.5, 0.75, 0.08)
      board.position.set(pathX(s.z) + 2.2, 2.1, s.z)
      board.rotation.y = Math.PI // face the walker approaching from -z
      g.add(post, board)
    }
    return g
  }

  const chunks = new Map<number, THREE.Group>()
  function syncChunks(d: number) {
    const lo = Math.max(0, Math.floor((d - VIEW_BEHIND_M) / CHUNK_M))
    const hi = Math.floor((d + VIEW_AHEAD_M) / CHUNK_M)
    for (let i = lo; i <= hi; i++) {
      if (!chunks.has(i)) {
        const c = buildChunk(i)
        chunks.set(i, c)
        scene.add(c)
      }
    }
    for (const [i, c] of chunks) {
      if (i < lo || i > hi) {
        scene.remove(c)
        // dispose per-chunk geometry (ribbons, sign textures); shared geos/mats stay
        c.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            if (!Object.values(geo).includes(o.geometry as never)) o.geometry.dispose()
            const m = o.material as THREE.Material & { map?: THREE.Texture }
            if (m.map) {
              m.map.dispose()
              m.dispose()
            }
          }
        })
        chunks.delete(i)
      }
    }
  }

  // --- camera + sky per frame ---
  let display = props.distance // smoothed distance the camera actually sits at
  function update(d: number) {
    syncChunks(d)
    camera.position.set(pathX(d), EYE_HEIGHT, d)
    const ahead = d + 14
    camera.lookAt(pathX(ahead), EYE_HEIGHT - 0.25, ahead)
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
    if (Math.abs(target - display) > 30) display = target // view (re)opened — snap
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
    for (const c of chunks.values()) {
      scene.remove(c)
      c.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose()
      })
    }
    scene.remove(dome)
    domeGeo.dispose()
    dome.material.dispose()
    Object.values(geo).forEach((g) => g.dispose())
    Object.values(mat).forEach((m) => m.dispose())
    groundMats.forEach((m) => m.dispose())
    pathMats.forEach((m) => m.dispose())
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
