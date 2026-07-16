<script setup lang="ts">
import { ref } from 'vue'
import { t } from './i18n'
import { SPEED_MAX } from './treadmill'
import { workoutStats, timeline, hrTargetRange } from './workouts'
import type { Workout, Segment, HrTarget } from './workouts'
import { mmss } from './format'

// Shared by the wizard's "pick a workout" step and the header/HR-badge menu — same
// tabs, same lists, same start/stop behavior, so the two entry points can't drift apart.
const props = withDefaults(
  defineProps<{
    workouts: Workout[]
    customWorkouts?: Workout[] // user-built plans (#68)
    weightKg: number
    maxHr: number
    connected?: boolean
    hrConnected?: boolean // an HR sensor is paired — required to start an HR workout (#63)
    hrTargets: HrTarget[]
    activeHrTarget?: HrTarget | null
    adjustInterval: number
    startTab?: 'plans' | 'hr' // 'plans' (weight loss) | 'hr' (heart rate)
    closable?: boolean
    lastWorkout?: Workout | null // most recently completed plan, for "Repeat" (#142)
  }>(),
  {
    connected: false,
    hrConnected: false,
    activeHrTarget: null,
    startTab: 'plans',
    closable: true,
    customWorkouts: () => [],
    lastWorkout: null,
  },
)
const emit = defineEmits<{
  'start-plan': [w: Workout]
  'save-custom': [w: Workout]
  'delete-custom': [id: string]
  'start-hr': [t: HrTarget]
  'stop-hr': []
  close: []
}>()

const tab = ref<'plans' | 'hr'>(props.startTab)
const preview = ref<Workout | null>(null) // weight-loss workout shown in the detail view

// --- custom workout builder (#68) ---
const building = ref(false)
const buildName = ref('')
const buildSegs = ref<Segment[]>([{ speed: 3.0, minutes: 10 }])
function openBuilder() {
  buildName.value = ''
  buildSegs.value = [{ speed: 3.0, minutes: 10 }]
  building.value = true
}
function addSeg() {
  if (buildSegs.value.length < 24)
    buildSegs.value.push({ ...buildSegs.value[buildSegs.value.length - 1]! })
}
function removeSeg(i: number) {
  if (buildSegs.value.length > 1) buildSegs.value.splice(i, 1)
}
function saveBuild() {
  emit('save-custom', {
    id: `custom-${crypto.randomUUID()}`,
    name: buildName.value.trim() || 'My workout',
    focus: 'Custom plan',
    segments: buildSegs.value.map((s) => ({ ...s })),
  })
  building.value = false
}

function stats(w: Workout) {
  return workoutStats(w, props.weightKg)
}

// --- chart geometry (mirrors App.vue's own chart scale, duplicated here since scoped
// styles/computeds don't cross component boundaries) ---
const CH_W = 320,
  CH_H = 120
const gridLines = [2, 4, 6].map((s) => ({ s, y: CH_H - (s / SPEED_MAX) * CH_H }))
function planPath(w: { segments: Segment[] }) {
  const { segs, total } = timeline(w)
  const pts: string[] = []
  for (const s of segs) {
    const x0 = (s.start / total) * CH_W,
      x1 = (s.end / total) * CH_W
    const y = CH_H - (s.speed / SPEED_MAX) * CH_H
    pts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`)
  }
  return { line: pts.join(' '), area: `M0,${CH_H} L${pts.join(' L')} L${CH_W},${CH_H} Z` }
}
function miniPath(w: { segments: Segment[] }) {
  const W = 100,
    H = 34
  const { segs, total } = timeline(w)
  const pts: string[] = []
  for (const s of segs) {
    const x0 = (s.start / total) * W,
      x1 = (s.end / total) * W
    const y = H - (s.speed / SPEED_MAX) * H
    pts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`)
  }
  return `M0,${H} L${pts.join(' L')} L${W},${H} Z`
}

function segDur(min: number) {
  const sec = Math.round(min * 60)
  return sec % 60 === 0
    ? `${sec / 60} min`
    : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="wp">
    <div v-if="closable || preview" class="wp-head">
      <button v-if="preview" class="x" @click="preview = null">‹</button>
      <h2>{{ preview ? preview.name : t('picker.title') }}</h2>
      <button v-if="closable" class="x" @click="emit('close')">✕</button>
    </div>

    <div v-if="!preview" class="workout-tabs">
      <button class="workout-tab" :class="{ on: tab === 'plans' }" @click="tab = 'plans'">
        {{ t('picker.tabPlans') }}
      </button>
      <button class="workout-tab" :class="{ on: tab === 'hr' }" @click="tab = 'hr'">
        {{ t('picker.tabHr') }}
      </button>
    </div>

    <div v-if="building" class="builder">
      <input
        v-model="buildName"
        class="builder-name"
        :placeholder="t('picker.namePlaceholder')"
        maxlength="40"
      />
      <div v-for="(seg, i) in buildSegs" :key="i" class="builder-seg">
        <span class="seg-i">{{ i + 1 }}</span>
        <input v-model.number="seg.speed" type="number" min="1" max="6" step="0.1" />
        <span class="builder-unit">km/h</span>
        <input v-model.number="seg.minutes" type="number" min="1" max="120" />
        <span class="builder-unit">min</span>
        <button class="x builder-x" :disabled="buildSegs.length <= 1" @click="removeSeg(i)">
          ✕
        </button>
      </div>
      <button class="btn ghost sm" @click="addSeg">{{ t('picker.addSegment') }}</button>
      <div class="detail-actions">
        <button class="btn ghost" @click="building = false">{{ t('picker.cancel') }}</button>
        <button class="btn go" @click="saveBuild">{{ t('picker.save') }}</button>
      </div>
    </div>

    <div v-else-if="!preview && tab === 'plans'" class="tlist">
      <!-- Repeat last workout (#142): reuses the same preview→Start flow as any card,
           just pre-picks the last plan you actually finished -->
      <button v-if="lastWorkout" class="repeat-chip" @click="preview = lastWorkout">
        <span class="repeat-icon">↻</span>
        {{ t('picker.repeat', { name: lastWorkout.name }) }}
      </button>
      <button v-for="w in workouts" :key="w.id" class="tcard" @click="preview = w">
        <div class="tcard-main">
          <span class="tname">{{ w.name }}</span>
          <span class="tfocus">{{ w.focus }}</span>
          <span class="tmeta"
            >{{ mmss(stats(w).minutes * 60) }} · {{ stats(w).distanceKm.toFixed(1) }} km · ~{{
              stats(w).kcal
            }}
            kcal</span
          >
        </div>
        <svg class="mini" viewBox="0 0 100 34">
          <path :d="miniPath(w)" />
        </svg>
      </button>

      <template v-if="customWorkouts.length">
        <h3 class="tlist-heading">{{ t('picker.myWorkouts') }}</h3>
        <button v-for="w in customWorkouts" :key="w.id" class="tcard" @click="preview = w">
          <div class="tcard-main">
            <span class="tname">{{ w.name }}</span>
            <span class="tfocus">{{ w.focus }}</span>
            <span class="tmeta"
              >{{ mmss(stats(w).minutes * 60) }} · {{ stats(w).distanceKm.toFixed(1) }} km · ~{{
                stats(w).kcal
              }}
              kcal</span
            >
          </div>
          <svg class="mini" viewBox="0 0 100 34">
            <path :d="miniPath(w)" />
          </svg>
        </button>
      </template>
      <button class="btn ghost sm tlist-new" @click="openBuilder">{{ t('picker.new') }}</button>
    </div>

    <div v-else-if="!preview" class="hr-workout-pane">
      <p class="hint hr-picker-hint">
        {{ t('picker.hrHint', { s: adjustInterval }) }}
      </p>
      <div class="hr-zone-list">
        <button
          v-for="tg in hrTargets"
          :key="tg.id"
          class="hr-zone-opt"
          :class="{ on: activeHrTarget?.id === tg.id }"
          :style="{ '--zc': tg.color }"
          :disabled="!hrConnected"
          @click="emit('start-hr', tg)"
        >
          <span class="hr-zone-name"><span class="hr-zone-dot"></span>{{ tg.name }}</span>
          <span class="hr-zone-range"
            >{{ hrTargetRange(tg, maxHr).lo }}–{{ hrTargetRange(tg, maxHr).hi }} bpm</span
          >
        </button>
      </div>
      <button v-if="activeHrTarget" class="btn ghost hr-picker-stop" @click="emit('stop-hr')">
        {{ t('picker.stopHr') }}
      </button>
      <p v-if="!hrConnected" class="hint">
        {{ t('picker.needHr') }}
      </p>
      <p v-else-if="!connected" class="hint">
        {{ t('picker.needTm') }}
      </p>
    </div>

    <div v-else class="tdetail">
      <p class="tfocus">{{ preview.focus }}</p>
      <div class="detail-tiles">
        <div>
          <span class="v">{{ mmss(stats(preview).minutes * 60) }}</span
          ><span class="k">{{ t('picker.time') }}</span>
        </div>
        <div>
          <span class="v">{{ stats(preview).distanceKm.toFixed(1) }}</span
          ><span class="k">{{ t('picker.km') }}</span>
        </div>
        <div>
          <span class="v">~{{ stats(preview).kcal }}</span
          ><span class="k">{{ t('picker.kcal') }}</span>
        </div>
      </div>
      <svg viewBox="0 0 320 120" class="chart">
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
        <button class="btn ghost" @click="preview = null">{{ t('wizard.back') }}</button>
        <button
          v-if="preview.id.startsWith('custom-')"
          class="btn ghost delete-custom"
          @click="(emit('delete-custom', preview.id), (preview = null))"
        >
          {{ t('picker.delete') }}
        </button>
        <button class="btn go" @click="emit('start-plan', preview)">{{ t('picker.start') }}</button>
      </div>
      <p v-if="!connected" class="hint">
        {{ t('picker.needTm') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.wp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.wp-head h2 {
  font-size: 18px;
  font-weight: 800;
  flex: 1;
  text-align: center;
}
.x {
  background: rgba(255, 255, 255, 0.7);
  border: none;
  color: #17324d;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  font-size: 16px;
  cursor: pointer;
}

.workout-tabs {
  display: flex;
  gap: 6px;
  margin: 6px 0 14px;
}
.workout-tab {
  flex: 1;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  color: #5a789a;
  border-radius: 10px;
  padding: 9px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.workout-tab.on {
  color: #fff;
  border-color: transparent;
  background: var(--accent);
}

.tlist {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tcard {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  color: #17324d;
  border-radius: 14px;
  padding: 12px;
  cursor: pointer;
}
/* Repeat last workout (#142) — accent-tinted so it reads as a shortcut, not just
   another card in the list */
.repeat-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: rgba(10, 132, 255, 0.1);
  border: 1px solid rgba(10, 132, 255, 0.3);
  color: var(--accent);
  font-weight: 700;
  font-size: 13.5px;
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 10px;
  cursor: pointer;
}
.repeat-icon {
  font-size: 16px;
}
.tcard-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tname {
  font-weight: 700;
  font-size: 15px;
}
.tfocus {
  font-size: 12.5px;
  color: #5a789a;
  line-height: 1.4;
}
.tmeta {
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
  margin-top: 2px;
}
.mini {
  width: 100px;
  height: 34px;
  flex: none;
}
.mini path {
  fill: rgba(10, 132, 255, 0.14);
  stroke: var(--accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.hint {
  margin-top: 14px;
  font-size: 12.5px;
  color: #5a789a;
  line-height: 1.5;
}
.hr-picker-hint {
  margin-top: 4px;
}
.hr-workout-pane .hr-picker-hint {
  margin-top: 0;
}
.hr-zone-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 14px 0 4px;
}
.hr-zone-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 12px;
  padding: 12px 14px;
  color: inherit;
  cursor: pointer;
}
.hr-zone-opt:disabled {
  opacity: 0.45;
  cursor: default;
}
.hr-zone-opt.on {
  border-color: var(--zc);
}
.hr-zone-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 14px;
}
.hr-zone-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--zc);
  flex: 0 0 auto;
}
.hr-zone-range {
  font-size: 12.5px;
  color: #5a789a;
  font-variant-numeric: tabular-nums;
}
.hr-picker-stop {
  width: 100%;
  margin-top: 10px;
}

.tdetail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.detail-tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.detail-tiles > div {
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 12px;
  padding: 10px;
  text-align: center;
}
.detail-tiles .v {
  display: block;
  font-size: 22px;
  font-weight: 800;
  color: var(--accent);
}
.detail-tiles .k {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #5a789a;
}
.chart {
  width: 100%;
  display: block;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 14px;
}
.chart .grid {
  stroke: rgba(23, 50, 77, 0.1);
  stroke-width: 1;
}
.chart .grid-label {
  fill: #7b8da1;
  font-size: 7px;
}
.chart .area {
  fill: rgba(10, 132, 255, 0.12);
}
.chart .plan {
  fill: none;
  stroke: rgba(10, 132, 255, 0.7);
  stroke-width: 2;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.seglist {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.seglist li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  padding: 7px 10px;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 8px;
}
.seg-i {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(23, 50, 77, 0.12);
  color: #17324d;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
}
.seg-sp {
  font-weight: 700;
}
.seg-mn {
  margin-left: auto;
  color: #5a789a;
}
.detail-actions {
  display: flex;
  gap: 10px;
}
.detail-actions .btn.ghost {
  flex: 0 0 auto;
}
.tlist-heading {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #5a789a;
  margin: 10px 0 2px 2px;
}
.tlist-new {
  align-self: flex-start;
}
.builder {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 0 14px;
}
.builder-name {
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(23, 50, 77, 0.15);
  border-radius: 10px;
  color: inherit;
  font: inherit;
  padding: 9px 12px;
}
.builder-seg {
  display: flex;
  align-items: center;
  gap: 8px;
}
.builder-seg input {
  width: 72px;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(23, 50, 77, 0.15);
  border-radius: 8px;
  color: inherit;
  font: inherit;
  padding: 6px 8px;
  text-align: right;
}
.builder-unit {
  font-size: 12px;
  color: #5a789a;
}
.builder-x {
  margin-left: auto;
}
.delete-custom {
  color: #e0284a;
}
</style>
