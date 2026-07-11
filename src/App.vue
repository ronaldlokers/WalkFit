<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useTreadmill, SPEED_MIN, SPEED_MAX, SPEED_STEP } from './treadmill.js'
import { useHeartRate } from './heartrate.js'
import { trainings, trainingStats, timeline } from './trainings.js'

const { state, connect, autoConnect: tmAutoConnect, disconnect, forget: forgetTreadmill, start, stop, setSpeed, resetStats } = useTreadmill()
const hr = useHeartRate()
const origin = window.location.origin
const stats = t => trainingStats(t)

// --- onboarding wizard ---
const wizardOpen = ref(true)
const wizardStep = ref(1)   // 1 treadmill · 2 heart rate · 3 mode · 4 pick training
function wizardWalk() { active.value = null; wizardOpen.value = false }
function wizardPick(t) { active.value = t; resetStats(); setSpeed(t.segments[0].speed); wizardOpen.value = false }

// --- settings ---
const settingsOpen = ref(false)
const debugOn = ref(localStorage.getItem('walkfit.debug') === '1')
watch(debugOn, v => localStorage.setItem('walkfit.debug', v ? '1' : '0'))

// --- heart rate zones ---
const maxHr = ref(Number(localStorage.getItem('walkfit.maxhr')) || 190)
watch(maxHr, v => localStorage.setItem('walkfit.maxhr', v))
const hrZone = computed(() => {
  const bpm = hr.state.bpm
  if (!bpm) return { z: 0, name: '—', color: '#8a93a3' }
  const p = (bpm / maxHr.value) * 100
  if (p < 60) return { z: 1, name: 'Warm up', color: '#6ab0ff' }
  if (p < 70) return { z: 2, name: 'Fat burn', color: '#2ed573' }
  if (p < 80) return { z: 3, name: 'Cardio', color: '#f5a623' }
  if (p < 90) return { z: 4, name: 'Hard', color: '#ff7f50' }
  return { z: 5, name: 'Max', color: '#ff4757' }
})
const hrSpark = computed(() => {
  const h = hr.state.history
  if (h.length < 2) return null
  const W = 100, H = 40
  const min = Math.min(...h), max = Math.max(...h)
  const rng = Math.max(1, max - min)
  const pts = h.map((v, i) =>
    `${((i / (h.length - 1)) * W).toFixed(1)},${(H - 0.1 * H - ((v - min) / rng) * 0.8 * H).toFixed(1)}`)
  return { line: pts.join(' '), area: `M0,${H} L${pts.join(' L')} L${W},${H} Z` }
})

// --- virtual loop geometry ---
const trackEl = ref(null)
const pathLen = ref(0)
const lapLength = 1000                // metres per virtual lap (fixed 1 km)
onMounted(() => {
  if (trackEl.value) pathLen.value = trackEl.value.getTotalLength()
  state.supported && connectAuto()   // silent reconnect to remembered devices
})
async function connectAuto() { await Promise.allSettled([tmAutoConnect(), hr.autoConnect()]) }
const laps = computed(() => Math.floor(state.distance / lapLength))
const lapFraction = computed(() => (state.distance % lapLength) / lapLength)
const marker = computed(() => {
  if (!trackEl.value || !pathLen.value) return { x: 0, y: 0 }
  const p = trackEl.value.getPointAtLength(lapFraction.value * pathLen.value)
  return { x: p.x, y: p.y }
})
const dashOffset = computed(() => pathLen.value * (1 - lapFraction.value))

// --- speed control ---
const speedInput = ref(state.targetSpeed)
watch(() => state.targetSpeed, v => { speedInput.value = v })
function applySpeed() { setSpeed(speedInput.value) }
function bump(delta) {
  speedInput.value = Math.min(SPEED_MAX, Math.max(SPEED_MIN,
    Math.round((speedInput.value + delta) / SPEED_STEP) * SPEED_STEP))
  setSpeed(speedInput.value)
}

// --- trainings ---
const menuOpen = ref(false)
const preview = ref(null)             // training shown in the menu detail
const active = ref(null)              // training currently running
const activeTl = computed(() => active.value ? timeline(active.value) : null)
const curSegIndex = computed(() => {
  if (!activeTl.value) return -1
  return activeTl.value.segs.findIndex(s => state.elapsed >= s.start && state.elapsed < s.end)
})
const curSeg = computed(() => curSegIndex.value >= 0 ? activeTl.value.segs[curSegIndex.value] : null)
const remaining = computed(() => activeTl.value ? Math.max(0, activeTl.value.total - state.elapsed) : 0)
const timeToNext = computed(() => curSeg.value ? Math.max(0, curSeg.value.end - state.elapsed) : 0)

// Drive the belt through the plan: set the target to the current segment's speed at
// each boundary. The Bluetooth layer enforces it until the belt actually reaches it,
// so the countdown-ignored first write is retried automatically.
watch(() => [state.elapsed, state.running, active.value], () => {
  if (!active.value) return
  const tl = activeTl.value
  if (state.running && state.elapsed >= tl.total) { finishTraining(); return }
  const seg = tl.segs.find(s => state.elapsed >= s.start && state.elapsed < s.end)
  if (seg && Math.abs(state.targetSpeed - seg.speed) >= 0.05) setSpeed(seg.speed)
})

async function startTraining(t) {
  active.value = t
  resetStats()
  menuOpen.value = false
  preview.value = null
  setSpeed(t.segments[0].speed)        // sets target for the start sequence
  if (state.connected) await start()
}
function endTraining() { active.value = null; stop() }
function finishTraining() { const t = active.value; active.value = null; stop(); if (t) alert(`${t.name} complete! ${(state.distance/1000).toFixed(2)} km walked.`) }

// --- chart geometry (shared) ---
const CH_W = 320, CH_H = 120
const gridLines = [2, 4, 6].map(s => ({ s, y: CH_H - (s / SPEED_MAX) * CH_H }))

function planPath(t) {
  const { segs, total } = timeline(t)
  const pts = []
  for (const s of segs) {
    const x0 = (s.start / total) * CH_W, x1 = (s.end / total) * CH_W
    const y = CH_H - (s.speed / SPEED_MAX) * CH_H
    pts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`)
  }
  return { line: pts.join(' '), area: `M0,${CH_H} L${pts.join(' L')} L${CH_W},${CH_H} Z` }
}
function miniPath(t) {
  const W = 100, H = 34
  const { segs, total } = timeline(t)
  const pts = []
  for (const s of segs) {
    const x0 = (s.start / total) * W, x1 = (s.end / total) * W
    const y = H - (s.speed / SPEED_MAX) * H
    pts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`)
  }
  return `M0,${H} L${pts.join(' L')} L${W},${H} Z`
}

const activePlan = computed(() => active.value ? planPath(active.value) : null)
const progressX = computed(() => activeTl.value ? Math.min(state.elapsed / activeTl.value.total, 1) * CH_W : 0)
const actualLine = computed(() => {
  if (!activeTl.value) return ''
  const total = activeTl.value.total
  return state.history.map((s, i) =>
    `${((Math.min(i, total) / total) * CH_W).toFixed(1)},${(CH_H - (Math.min(s, SPEED_MAX) / SPEED_MAX) * CH_H).toFixed(1)}`
  ).join(' ')
})

// free-walk chart (no training active)
const walkPoints = computed(() => {
  const h = state.history
  if (h.length < 2) return []
  return h.map((s, i) => ({ x: (i / (h.length - 1)) * CH_W, y: CH_H - (Math.min(s, SPEED_MAX) / SPEED_MAX) * CH_H }))
})
const walkLine = computed(() => walkPoints.value.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
const walkArea = computed(() => { const p = walkPoints.value; if (!p.length) return ''; return `M0,${CH_H} L${walkLine.value.split(' ').join(' L')} L${CH_W},${CH_H} Z` })
const peakSpeed = computed(() => state.history.length ? Math.max(...state.history) : 0)

// --- formatting ---
function mmss(sec) {
  sec = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
}
function segDur(min) {
  const sec = Math.round(min * 60)
  return sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}
const fmtDist = computed(() => state.distance >= 1000 ? (state.distance / 1000).toFixed(2) + ' km' : Math.round(state.distance) + ' m')
const pace = computed(() => {
  if (state.speed <= 0) return '—'
  const s = 3600 / state.speed
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} /km`
})
</script>

<template>
  <div class="app">
    <header>
      <div class="brand">
        <span class="dot" :class="{ on: state.connected, run: state.running }"></span>
        <h1>Walk<span>Fit</span></h1>
      </div>
      <div class="head-actions">
        <button class="btn ghost sm" @click="menuOpen = true; preview = null">Training</button>
        <span v-if="hr.state.connected" class="hr-badge" :title="hrZone.name">
          <svg v-if="hrSpark" class="hr-badge-spark" viewBox="0 0 100 40" preserveAspectRatio="none">
            <path class="hr-spark-area" :d="hrSpark.area" :style="{ fill: hrZone.color }" />
            <polyline class="hr-spark-line" :points="hrSpark.line" :style="{ stroke: hrZone.color }" />
          </svg>
          <span class="hr-badge-content">♥ {{ hr.state.bpm || '–' }}</span>
        </span>
        <button v-if="!state.connected" class="btn primary sm" :disabled="state.connecting" @click="connect">
          {{ state.connecting ? 'Connecting…' : 'Connect' }}
        </button>
        <button v-else class="btn ghost sm" @click="disconnect">Disconnect</button>
        <button class="cog" @click="settingsOpen = true" aria-label="Settings">⚙</button>
      </div>
    </header>

    <p v-if="!state.secure" class="warn">
      <b>Insecure context.</b> Web Bluetooth needs <code>https://</code> or <code>localhost</code>.
      You’re on <code>{{ origin }}</code> — reopen at <code>http://localhost:5173</code>.
    </p>
    <p v-else-if="!state.hasApi" class="warn">
      Web Bluetooth is disabled. <b>On Linux</b> enable
      <code>chrome://flags/#enable-experimental-web-platform-features</code> → Enabled → relaunch.
    </p>
    <p v-if="state.error" class="warn">{{ state.error }}</p>

    <!-- virtual loop -->
    <section class="track-wrap">
      <svg viewBox="0 0 400 260" class="track">
        <path class="track-band" d="M110,40 L290,40 A90,90 0 0 1 290,220 L110,220 A90,90 0 0 1 110,40 Z" />
        <path ref="trackEl" class="track-line" d="M110,40 L290,40 A90,90 0 0 1 290,220 L110,220 A90,90 0 0 1 110,40 Z" />
        <path class="track-progress" d="M110,40 L290,40 A90,90 0 0 1 290,220 L110,220 A90,90 0 0 1 110,40 Z"
          :stroke-dasharray="pathLen" :stroke-dashoffset="dashOffset" />
        <line class="startline" x1="110" y1="24" x2="110" y2="56" />
        <g :transform="`translate(${marker.x},${marker.y})`" class="runner">
          <circle class="halo" r="16" />
          <circle class="body" r="9" />
          <text y="1">🏃</text>
        </g>
        <text class="lap-num" x="200" y="120">{{ laps }}</text>
        <text class="lap-label" x="200" y="150">{{ laps === 1 ? 'lap' : 'laps' }} · 1 km loop</text>
      </svg>
    </section>

    <section class="action-row" :class="{ disabled: !state.connected }">
      <button class="btn go" @click="start" :disabled="!state.connected">▶ Start</button>
      <button class="btn halt" @click="stop" :disabled="!state.connected">■ Stop</button>
      <button class="btn ghost" @click="resetStats">Reset</button>
    </section>

    <section v-if="!active" class="controls" :class="{ disabled: !state.connected }">
      <div class="speed-row">
        <button class="btn round" @click="bump(-SPEED_STEP)" :disabled="!state.connected">−</button>
        <div class="speed-set">
          <span class="target">{{ speedInput.toFixed(1) }} <small>km/h target</small></span>
          <input type="range" :min="SPEED_MIN" :max="SPEED_MAX" :step="SPEED_STEP"
            v-model.number="speedInput" @change="applySpeed" :disabled="!state.connected" />
        </div>
        <button class="btn round" @click="bump(SPEED_STEP)" :disabled="!state.connected">+</button>
      </div>
    </section>

    <!-- training banner + profile, OR free-walk speed chart -->
    <section v-if="active" class="chart-wrap">
      <div class="train-banner">
        <div>
          <span class="train-name">{{ active.name }}</span>
          <span class="train-seg" v-if="curSeg">
            seg {{ curSegIndex + 1 }}/{{ activeTl.segs.length }} · now {{ curSeg.speed.toFixed(1) }} km/h
            · next in {{ mmss(timeToNext) }}
          </span>
        </div>
        <button class="btn halt sm" @click="endTraining">End</button>
      </div>
      <svg viewBox="0 0 320 120" class="chart">
        <rect class="done" x="0" y="0" :width="progressX" height="120" />
        <g v-for="g in gridLines" :key="g.s">
          <line class="grid" x1="0" :y1="g.y" x2="320" :y2="g.y" />
          <text class="grid-label" x="3" :y="g.y - 3">{{ g.s }}</text>
        </g>
        <path class="area" :d="activePlan.area" />
        <polyline class="plan" :points="activePlan.line" />
        <polyline v-if="actualLine" class="actual" :points="actualLine" />
        <line class="cursor" :x1="progressX" y1="0" :x2="progressX" y2="120" />
        <circle class="cursor-dot" :cx="progressX" cy="6" r="4" />
      </svg>
      <div class="train-foot">
        <span>{{ mmss(state.elapsed) }} / {{ mmss(activeTl.total) }}</span>
        <span>{{ mmss(remaining) }} left</span>
      </div>
    </section>

    <section v-else class="chart-wrap">
      <div class="chart-head">
        <span class="chart-title">Speed over time</span>
        <span class="chart-peak" v-if="peakSpeed">peak {{ peakSpeed.toFixed(1) }} km/h</span>
      </div>
      <svg viewBox="0 0 320 120" class="chart">
        <g v-for="g in gridLines" :key="g.s">
          <line class="grid" x1="0" :y1="g.y" x2="320" :y2="g.y" />
          <text class="grid-label" x="3" :y="g.y - 3">{{ g.s }} km/h</text>
        </g>
        <path v-if="walkArea" class="area" :d="walkArea" />
        <polyline v-if="walkLine" class="actual" :points="walkLine" />
      </svg>
      <p v-if="state.history.length < 2" class="chart-empty">Start walking, or pick a training.</p>
    </section>

    <p v-if="hr.state.error" class="warn">Heart rate: {{ hr.state.error }}</p>

    <!-- live stats -->
    <section class="stats">
      <div class="stat big">
        <span class="v">{{ state.speed.toFixed(1) }}</span><span class="u">km/h</span>
        <span class="k">current speed</span>
      </div>
      <div class="stat"><span class="v">{{ fmtDist }}</span><span class="k">distance</span></div>
      <div class="stat"><span class="v">{{ mmss(state.elapsed) }}</span><span class="k">time</span></div>
      <div class="stat"><span class="v">{{ pace }}</span><span class="k">pace</span></div>
    </section>


    <!-- controls -->

    <details v-if="debugOn" class="dbg" open>
      <summary>Debug: speed events</summary>
      <p class="dbg-now">elapsed {{ mmss(state.elapsed) }} · seg {{ curSegIndex }} · target {{ state.targetSpeed }} · rx {{ state.speed }}</p>
      <pre>{{ state.log.join('\n') }}</pre>
    </details>

    <!-- trainings menu -->
    <div v-if="menuOpen" class="overlay" @click.self="menuOpen = false">
      <div class="sheet">
        <div class="sheet-head">
          <button v-if="preview" class="x" @click="preview = null">‹</button>
          <h2>{{ preview ? preview.name : 'Training' }}</h2>
          <button class="x" @click="menuOpen = false">✕</button>
        </div>

        <div v-if="!preview" class="tlist">
          <button v-for="t in trainings" :key="t.id" class="tcard" @click="preview = t">
            <div class="tcard-main">
              <span class="tname">{{ t.name }}</span>
              <span class="tfocus">{{ t.focus }}</span>
              <span class="tmeta">{{ mmss(stats(t).minutes * 60) }} · {{ stats(t).distanceKm.toFixed(1) }} km · ~{{ stats(t).kcal }} kcal</span>
            </div>
            <svg class="mini" viewBox="0 0 100 34">
              <path :d="miniPath(t)" />
            </svg>
          </button>
        </div>

        <div v-else class="tdetail">
          <p class="tfocus">{{ preview.focus }}</p>
          <div class="detail-tiles">
            <div><span class="v">{{ mmss(stats(preview).minutes * 60) }}</span><span class="k">time</span></div>
            <div><span class="v">{{ stats(preview).distanceKm.toFixed(1) }}</span><span class="k">km</span></div>
            <div><span class="v">~{{ stats(preview).kcal }}</span><span class="k">kcal</span></div>
          </div>
          <svg viewBox="0 0 320 120" class="chart detail-chart">
            <g v-for="g in gridLines" :key="g.s">
              <line class="grid" x1="0" :y1="g.y" x2="320" :y2="g.y" />
              <text class="grid-label" x="3" :y="g.y - 3">{{ g.s }}</text>
            </g>
            <path class="area" :d="planPath(preview).area" />
            <polyline class="plan" :points="planPath(preview).line" />
          </svg>
          <ol class="seglist">
            <li v-for="(s, i) in preview.segments" :key="i">
              <span class="seg-i">{{ i + 1 }}</span>
              <span class="seg-sp">{{ s.speed.toFixed(1) }} km/h</span>
              <span class="seg-mn">{{ segDur(s.minutes) }}</span>
            </li>
          </ol>
          <div class="detail-actions">
            <button class="btn ghost" @click="preview = null">Back</button>
            <button class="btn go" @click="startTraining(preview)">Start training</button>
          </div>
          <p v-if="!state.connected" class="hint">Not connected — connect the treadmill first, or start it and connect after.</p>
        </div>
      </div>
    </div>

    <!-- onboarding wizard -->
    <div v-if="wizardOpen" class="overlay wizard-overlay">
      <div class="wizard">
        <div class="wiz-head">
          <div class="wiz-dots">
            <span v-for="n in 3" :key="n" :class="{ on: wizardStep >= n }"></span>
          </div>
          <button class="x" @click="wizardOpen = false" aria-label="Skip setup">✕</button>
        </div>

        <!-- 1: treadmill -->
        <div v-if="wizardStep === 1" class="wiz-step">
          <div class="wiz-icon">🏃</div>
          <h2>Connect your treadmill</h2>
          <p>Turn the belt on, then connect over Bluetooth.</p>
          <button v-if="!state.connected" class="btn go wiz-cta" :disabled="state.connecting" @click="connect">
            {{ state.connecting ? 'Connecting…' : 'Connect treadmill' }}
          </button>
          <p v-else class="wiz-ok">✓ {{ state.deviceName }} connected</p>
          <p v-if="state.error" class="warn">{{ state.error }}</p>
          <div class="wiz-nav">
            <span></span>
            <button class="btn ghost" @click="wizardStep = 2">{{ state.connected ? 'Next' : 'Skip' }}</button>
          </div>
        </div>

        <!-- 2: heart rate -->
        <div v-else-if="wizardStep === 2" class="wiz-step">
          <div class="wiz-icon">❤️</div>
          <h2>Connect heart rate</h2>
          <p>Optional. Broadcast HR from your Garmin or a chest strap to see live zones.</p>
          <button v-if="!hr.state.connected" class="btn go wiz-cta" :disabled="hr.state.connecting" @click="hr.connect">
            {{ hr.state.connecting ? 'Connecting…' : 'Connect sensor' }}
          </button>
          <p v-else class="wiz-ok">✓ {{ hr.state.deviceName }} connected</p>
          <p v-if="hr.state.error" class="warn">{{ hr.state.error }}</p>
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 1">Back</button>
            <button class="btn ghost" @click="wizardStep = 3">{{ hr.state.connected ? 'Next' : 'Skip' }}</button>
          </div>
        </div>

        <!-- 3: mode -->
        <div v-else-if="wizardStep === 3" class="wiz-step">
          <div class="wiz-icon">🎯</div>
          <h2>What today?</h2>
          <div class="mode-grid">
            <button class="mode-card" @click="wizardWalk">
              <span class="mode-emoji">🚶</span>
              <span class="mode-name">Free walk</span>
              <span class="mode-desc">Set your own pace</span>
            </button>
            <button class="mode-card" @click="wizardStep = 4">
              <span class="mode-emoji">📋</span>
              <span class="mode-name">Training</span>
              <span class="mode-desc">Guided weight-loss session</span>
            </button>
          </div>
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 2">Back</button>
            <span></span>
          </div>
        </div>

        <!-- 4: pick training -->
        <div v-else class="wiz-step">
          <h2>Choose a training</h2>
          <div class="tlist wiz-tlist">
            <button v-for="t in trainings" :key="t.id" class="tcard" @click="wizardPick(t)">
              <div class="tcard-main">
                <span class="tname">{{ t.name }}</span>
                <span class="tfocus">{{ t.focus }}</span>
                <span class="tmeta">{{ mmss(stats(t).minutes * 60) }} · {{ stats(t).distanceKm.toFixed(1) }} km · ~{{ stats(t).kcal }} kcal</span>
              </div>
              <svg class="mini" viewBox="0 0 100 34"><path :d="miniPath(t)" /></svg>
            </button>
          </div>
          <div class="wiz-nav">
            <button class="btn ghost" @click="wizardStep = 3">Back</button>
            <span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- settings -->
    <div v-if="settingsOpen" class="overlay" @click.self="settingsOpen = false">
      <div class="sheet">
        <div class="sheet-head">
          <h2>Settings</h2>
          <button class="x" @click="settingsOpen = false">✕</button>
        </div>
        <div class="settings">
          <h3>Treadmill</h3>
          <div class="set-row">
            <span>{{ state.connected ? state.deviceName : (state.remembered ? 'Remembered' : 'Not connected') }}</span>
            <div class="set-actions">
              <button v-if="!state.connected" class="btn ghost sm" :disabled="state.connecting" @click="connect">
                {{ state.connecting ? 'Connecting…' : 'Connect' }}
              </button>
              <button v-else class="btn ghost sm" @click="disconnect">Disconnect</button>
              <button v-if="state.remembered" class="btn ghost sm forget" @click="forgetTreadmill">Forget</button>
            </div>
          </div>

          <h3>Heart rate</h3>
          <div class="set-row">
            <span>{{ hr.state.connected ? hr.state.deviceName : (hr.state.remembered ? 'Remembered' : 'Not connected') }}</span>
            <div class="set-actions">
              <button v-if="!hr.state.connected" class="btn ghost sm" :disabled="hr.state.connecting" @click="hr.connect">
                {{ hr.state.connecting ? 'Connecting…' : 'Connect' }}
              </button>
              <button v-else class="btn ghost sm" @click="hr.disconnect">Disconnect</button>
              <button v-if="hr.state.remembered" class="btn ghost sm forget" @click="hr.forget">Forget</button>
            </div>
          </div>
          <div class="set-row">
            <span>Max HR</span>
            <input type="number" v-model.number="maxHr" min="120" max="220" />
          </div>
          <p class="set-note">Fat-burn zone: {{ Math.round(maxHr * 0.6) }}–{{ Math.round(maxHr * 0.7) }} bpm</p>

          <h3>Advanced</h3>
          <label class="set-row toggle">
            <span>Debug panel</span>
            <input type="checkbox" v-model="debugOn" />
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app { max-width: 460px; margin: 0 auto; padding: 18px 16px 40px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.brand { display: flex; align-items: center; gap: 10px; }
h1 { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
h1 span { color: var(--accent); }
.head-actions { display: flex; gap: 8px; }
.dot { width: 11px; height: 11px; border-radius: 50%; background: #555; transition: .3s; }
.dot.on { background: #f5a623; box-shadow: 0 0 10px #f5a623; }
.dot.run { background: var(--accent); box-shadow: 0 0 12px var(--accent); }

.warn { background: #3a1d1d; border: 1px solid #7a2e2e; color: #ffb4b4; padding: 10px 12px; border-radius: 10px; font-size: 13px; margin: 8px 0; }
code { background: #00000040; padding: 1px 5px; border-radius: 5px; font-size: 12px; }

.track-wrap { margin: 6px 0 14px; }
.track { width: 100%; display: block; }
.track-band { fill: none; stroke: #20242c; stroke-width: 34; stroke-linejoin: round; }
.track-line { fill: none; stroke: #333a46; stroke-width: 2; stroke-dasharray: 5 7; }
.track-progress { fill: none; stroke: var(--accent); stroke-width: 8; stroke-linecap: round; transition: stroke-dashoffset .25s linear; filter: drop-shadow(0 0 6px rgba(46,213,115,.5)); }
.startline { stroke: #eee; stroke-width: 3; }
.runner text { text-anchor: middle; font-size: 13px; } .runner .halo { fill: rgba(46,213,115,.18); } .runner .body { fill: var(--accent); } .runner { transition: transform .25s linear; }
.lap-num { text-anchor: middle; font-size: 46px; font-weight: 800; fill: #fff; }
.lap-label { text-anchor: middle; font-size: 12px; fill: #8a93a3; letter-spacing: .5px; }

.chart-wrap { margin: 0 0 18px; }
.chart-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.chart-title { font-size: 13px; font-weight: 600; color: #cbd3df; }
.chart-peak { font-size: 12px; color: var(--accent); font-weight: 600; }
.chart { width: 100%; display: block; background: #12151b; border: 1px solid #232833; border-radius: 14px; }
.chart .grid { stroke: #232833; stroke-width: 1; }
.chart .grid-label { fill: #5b6473; font-size: 7px; }
.chart .area { fill: rgba(46,213,115,.12); }
.chart .plan { fill: none; stroke: rgba(46,213,115,.7); stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.chart .actual { fill: none; stroke: #fff; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.chart .done { fill: rgba(255,255,255,.04); }
.chart .cursor { stroke: #f5a623; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.chart .cursor-dot { fill: #f5a623; }
.chart-empty { text-align: center; font-size: 12.5px; color: #8a93a3; margin-top: 8px; }

.train-banner { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.train-name { font-weight: 700; font-size: 15px; display: block; }
.train-seg { font-size: 12px; color: #8a93a3; }
.train-foot { display: flex; justify-content: space-between; font-size: 12px; color: #8a93a3; margin-top: 6px; }

.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px; }
.stat { background: #171a21; border: 1px solid #232833; border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 2px; }
.stat.big { grid-column: span 3; align-items: baseline; flex-direction: row; gap: 8px; }
.stat .v { font-size: 20px; font-weight: 700; } .stat.big .v { font-size: 44px; font-weight: 800; color: var(--accent); }
.stat.big .u { font-size: 16px; color: #8a93a3; }
.stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #8a93a3; margin-left: auto; }
.stat.big .k { align-self: center; }

.hr-spark-area { fill-opacity: .14; }
.hr-spark-line { fill: none; stroke-width: 2; stroke-opacity: .55; vector-effect: non-scaling-stroke; }
.dbg { margin: 8px 0 18px; font-size: 12px; color: #8a93a3; }
.dbg summary { cursor: pointer; }
.dbg-now { margin: 6px 0; color: #cbd3df; }
.dbg pre { padding: 8px; background: #12151b; border: 1px solid #232833; border-radius: 8px; overflow-x: auto; font-family: ui-monospace, monospace; line-height: 1.5; }

.cog { background: #1b1f27; border: 1px solid #2a303c; color: #cbd3df; border-radius: 10px;
  padding: 5px 11px; font-size: 24px; line-height: 1; cursor: pointer; }
.hr-badge { position: relative; overflow: hidden; display: inline-flex; align-items: center; gap: 4px;
  background: #1b1f27; border: 1px solid #2a303c; border-radius: 10px; padding: 8px 12px; font-size: 14px; font-weight: 800; }
.hr-badge-spark { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; opacity: .4; }
.hr-badge-content { position: relative; z-index: 1; color: #ff4757; }
.settings { display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
.settings h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: #8a93a3; margin-top: 10px; }
.set-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #171a21; border: 1px solid #232833; border-radius: 12px; padding: 12px 14px; font-size: 14px; }
.set-row input[type=number] { width: 72px; background: #12151b; border: 1px solid #232833; color: #e8ecf2; border-radius: 8px; padding: 6px 8px; font-size: 14px; text-align: right; }
.set-row input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent); }
.set-row.toggle { cursor: pointer; }
.set-note { font-size: 12.5px; color: #8a93a3; padding: 0 2px; }
.set-actions { display: flex; gap: 8px; }
.btn.forget { color: #ff7f7f; }

.controls.disabled { opacity: .55; }
.speed-row { display: flex; align-items: center; gap: 12px; }
.speed-set { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.target { font-weight: 700; font-size: 15px; } .target small { color: #8a93a3; font-weight: 400; font-size: 12px; }
input[type=range] { width: 100%; accent-color: var(--accent); }
.action-row { display: flex; gap: 10px; margin: 2px 0 16px; }
.action-row.disabled { opacity: .55; }

.btn { border: none; border-radius: 12px; padding: 12px 16px; font-size: 15px; font-weight: 700; cursor: pointer; color: #fff; background: #232833; transition: .15s; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn.sm { padding: 8px 12px; font-size: 13px; }
.btn.primary { background: var(--accent); color: #05210f; }
.btn.ghost { background: #1b1f27; color: #cbd3df; font-weight: 600; }
.btn.round { width: 46px; height: 46px; padding: 0; font-size: 24px; border-radius: 50%; }
.btn.go { flex: 1; background: var(--accent); color: #05210f; }
.btn.halt { flex: 1; background: #ff4757; }
.btn.halt.sm { flex: 0; }
.hint { margin-top: 14px; font-size: 12.5px; color: #8a93a3; line-height: 1.5; }

.overlay { position: fixed; inset: 0; background: #000a; display: flex; align-items: flex-end; justify-content: center; z-index: 20; }
.wizard-overlay { align-items: center; background: #0b0d12; padding: 16px; }
.wizard { width: 100%; max-width: 440px; background: #12151b; border: 1px solid #232833; border-radius: 20px; padding: 18px; max-height: 92vh; overflow-y: auto; }
.wiz-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.wiz-dots { display: flex; gap: 6px; }
.wiz-dots span { width: 22px; height: 5px; border-radius: 3px; background: #232833; transition: .2s; }
.wiz-dots span.on { background: var(--accent); }
.wiz-step { display: flex; flex-direction: column; gap: 12px; text-align: center; }
.wiz-icon { font-size: 46px; margin: 8px 0 0; }
.wiz-step h2 { font-size: 22px; font-weight: 800; }
.wiz-step > p { color: #8a93a3; font-size: 14px; line-height: 1.5; }
.wiz-cta { align-self: center; padding: 13px 22px; }
.wiz-ok { color: var(--accent); font-weight: 700; }
.wiz-nav { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.wiz-nav .btn { min-width: 84px; }
.mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 6px 0; }
.mode-card { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 20px 12px; background: #171a21; border: 1px solid #232833; border-radius: 16px; cursor: pointer; color: inherit; }
.mode-card:hover { border-color: var(--accent); }
.mode-emoji { font-size: 34px; }
.mode-name { font-weight: 700; font-size: 15px; }
.mode-desc { font-size: 12px; color: #8a93a3; }
.wiz-tlist { text-align: left; margin: 6px 0; }
.sheet { background: #12151b; border: 1px solid #232833; border-radius: 20px 20px 0 0; width: 100%; max-width: 460px; max-height: 88vh; overflow-y: auto; padding: 8px 16px 24px; }
.sheet-head { display: flex; align-items: center; gap: 10px; position: sticky; top: 0; background: #12151b; padding: 10px 0; }
.sheet-head h2 { font-size: 18px; font-weight: 800; flex: 1; text-align: center; }
.x { background: #1b1f27; border: none; color: #cbd3df; width: 34px; height: 34px; border-radius: 10px; font-size: 16px; cursor: pointer; }

.tlist { display: flex; flex-direction: column; gap: 10px; }
.tcard { display: flex; align-items: center; gap: 12px; text-align: left; background: #171a21; border: 1px solid #232833; border-radius: 14px; padding: 12px; cursor: pointer; }
.tcard-main { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.tname { font-weight: 700; font-size: 15px; }
.tfocus { font-size: 12.5px; color: #8a93a3; line-height: 1.4; }
.tmeta { font-size: 12px; color: var(--accent); font-weight: 600; margin-top: 2px; }
.mini { width: 100px; height: 34px; flex: none; }
.mini path { fill: rgba(46,213,115,.18); stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }

.tdetail { display: flex; flex-direction: column; gap: 14px; }
.detail-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.detail-tiles > div { background: #171a21; border: 1px solid #232833; border-radius: 12px; padding: 10px; text-align: center; }
.detail-tiles .v { display: block; font-size: 22px; font-weight: 800; color: var(--accent); }
.detail-tiles .k { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #8a93a3; }
.seglist { list-style: none; display: flex; flex-direction: column; gap: 4px; }
.seglist li { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 7px 10px; background: #171a21; border-radius: 8px; }
.seg-i { width: 20px; height: 20px; border-radius: 50%; background: #232833; color: #cbd3df; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.seg-sp { font-weight: 700; }
.seg-mn { margin-left: auto; color: #8a93a3; }
.detail-actions { display: flex; gap: 10px; }
.detail-actions .btn.ghost { flex: 0 0 auto; }
</style>
