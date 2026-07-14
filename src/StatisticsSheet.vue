<script setup lang="ts">
import { ref, computed } from 'vue'
import { weeklyTotals, currentStreak, dailyTotals } from './statistics'
import type { Session, Goals } from './statistics'
import type { WeightEntry } from './weight'
import { mmss } from './format'

const props = defineProps<{
  sessions: Session[]
  weightLog: WeightEntry[]
  goals: Goals
  weightKg: number
}>()
const emit = defineEmits<{
  close: []
  'weigh-in': [kg: number]
  'delete-session': [date: string]
}>()

// Recent walks (#67): newest first, tappable for a per-session detail + delete.
const RECENT_LIMIT = 14
const recentWalks = computed(() => [...props.sessions].reverse().slice(0, RECENT_LIMIT))
const expandedWalk = ref<string | null>(null) // session date of the open detail row
function toggleWalk(date: string) {
  expandedWalk.value = expandedWalk.value === date ? null : date
}
function walkDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}
function walkTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
function fmtKm(m: number) {
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'
}

const weekly = computed(() => weeklyTotals(props.sessions))
const streak = computed(() => currentStreak(props.sessions))

// --- daily activity: rings + charts (#43) ---
// Metric hues reuse the app's established identity colors (HR-zone badge, accent):
// kcal green / steps blue / time amber / HR red. Validated on the #171a21 card surface —
// contrast >3:1 and CVD ΔE 81 (target ≥12); they sit above the generic dark lightness
// band by design, matching the rest of the UI rather than a darker chart-only variant.
const METRIC_COLORS = { kcal: '#2ed573', steps: '#6ab0ff', time: '#f5a623', hr: '#ff4757' }
const chartDays = ref(7)
const daily = computed(() => dailyTotals(props.sessions, chartDays.value))
const todayTotals = computed(() => dailyTotals(props.sessions, 1)[0]!)

// Activity rings: outer→inner kcal/steps/time, filling toward the daily goals.
const rings = computed(() => {
  const t = todayTotals.value
  return [
    {
      id: 'kcal',
      label: 'Calories',
      color: METRIC_COLORS.kcal,
      value: Math.round(t.kcal),
      goal: props.goals.kcal,
      unit: 'kcal',
    },
    {
      id: 'steps',
      label: 'Steps',
      color: METRIC_COLORS.steps,
      value: t.steps,
      goal: props.goals.steps,
      unit: 'steps',
    },
    {
      id: 'time',
      label: 'Time',
      color: METRIC_COLORS.time,
      value: Math.round(t.duration / 60),
      goal: props.goals.minutes,
      unit: 'min',
    },
  ].map((r, i) => {
    const radius = 52 - i * 15
    const c = 2 * Math.PI * radius
    const pct = Math.min(r.value / r.goal, 1)
    return { ...r, radius, pct, dash: `${pct * c} ${c}` }
  })
})

const barCharts = computed(() => {
  const days = daily.value
  return [
    {
      id: 'kcal',
      label: 'Calories',
      color: METRIC_COLORS.kcal,
      unit: 'kcal',
      values: days.map((d) => Math.round(d.kcal)),
    },
    {
      id: 'steps',
      label: 'Steps',
      color: METRIC_COLORS.steps,
      unit: 'steps',
      values: days.map((d) => d.steps),
    },
    {
      id: 'time',
      label: 'Activity time',
      color: METRIC_COLORS.time,
      unit: 'min',
      values: days.map((d) => Math.round(d.duration / 60)),
    },
  ].map((m) => ({
    ...m,
    max: Math.max(...m.values, 1),
    total: m.values.reduce((a, b) => a + b, 0),
  }))
})

// Daily HR: min–max span bars + an avg tick, on a shared padded bpm scale.
const hrChart = computed(() => {
  const days = daily.value
  const withHr = days.filter((d) => d.hrMin !== null)
  if (!withHr.length) return null
  const lo = Math.min(...withHr.map((d) => d.hrMin!)) - 5
  const hi = Math.max(...withHr.map((d) => d.hrMax!)) + 5
  const span = hi - lo
  return {
    lo,
    hi,
    bars: days.map((d) =>
      d.hrMin === null
        ? null
        : {
            bottom: ((d.hrMin - lo) / span) * 100,
            height: Math.max(((d.hrMax! - d.hrMin) / span) * 100, 3),
            avg: d.hrAvg === null ? null : ((d.hrAvg - lo) / span) * 100,
            title: `${d.date}: ${d.hrMin}–${d.hrMax} bpm · avg ${d.hrAvg}`,
          },
    ),
  }
})

// Sparse x labels: weekday letters for 7d, day-of-month every 5th for longer ranges.
function dayLabel(dateKey: string, i: number): string {
  const d = new Date(dateKey + 'T00:00:00')
  if (chartDays.value === 7) return 'SMTWTFS'[d.getDay()]!
  return i % 5 === 0 || i === chartDays.value - 1 ? String(d.getDate()) : ''
}

// --- weight log (issue #16) ---
const latestWeight = computed(() => props.weightLog[props.weightLog.length - 1] ?? null)
// Delta vs the last weigh-in at least ~30 days before the newest one (falls back to the
// oldest entry when the log is younger than that; null until two entries exist).
const weightDelta = computed(() => {
  const log = props.weightLog
  if (log.length < 2) return null
  const latest = log[log.length - 1]
  const cutoff = new Date(latest.date).getTime() - 30 * 86400000
  let refEntry = log[0]
  for (const e of log) {
    if (new Date(e.date).getTime() <= cutoff) refEntry = e
    else break
  }
  return latest.kg - refEntry.kg
})
// Trend line, x proportional to time (weigh-ins are irregular — index-spacing would lie).
const weightSpark = computed(() => {
  const log = props.weightLog
  if (log.length < 2) return null
  const W = 320,
    H = 80
  const kgs = log.map((e) => e.kg)
  const min = Math.min(...kgs),
    max = Math.max(...kgs)
  const rng = Math.max(0.5, max - min) // floor so a flat log doesn't zoom into noise
  const t0 = new Date(log[0].date).getTime()
  const span = Math.max(1, new Date(log[log.length - 1].date).getTime() - t0)
  const pts = log.map(
    (e) =>
      `${(((new Date(e.date).getTime() - t0) / span) * W).toFixed(1)},${(H - 0.12 * H - ((e.kg - min) / rng) * 0.76 * H).toFixed(1)}`,
  )
  return { line: pts.join(' '), area: `M0,${H} L${pts.join(' L')} L${W},${H} Z`, min, max }
})
const weighInInput = ref<number | null>(null)
function logWeighIn() {
  if (!weighInInput.value) return
  const kg = Math.round(weighInInput.value * 10) / 10
  emit('weigh-in', kg)
  weighInInput.value = null
}
</script>

<template>
  <div class="sheet">
    <div class="sheet-head">
      <h2>Statistics</h2>
      <button class="x" @click="emit('close')">✕</button>
    </div>

    <div v-if="!sessions.length" class="hist-empty">
      <span class="hist-empty-icon">🏃</span>
      <p class="hint">No walks logged yet — finish a walk to see it here.</p>
    </div>

    <div v-else class="hist-body">
      <div class="hist-section">
        <h3>Daily activity</h3>
        <div class="rings-wrap">
          <svg class="rings" viewBox="0 0 120 120" aria-hidden="true">
            <g v-for="r in rings" :key="r.id">
              <circle class="ring-track" cx="60" cy="60" :r="r.radius" :stroke="r.color" />
              <circle
                v-if="r.pct > 0"
                class="ring-fill"
                cx="60"
                cy="60"
                :r="r.radius"
                :stroke="r.color"
                :stroke-dasharray="r.dash"
                transform="rotate(-90 60 60)"
              />
            </g>
          </svg>
          <div class="ring-legend">
            <div v-for="r in rings" :key="r.id" class="ring-item">
              <span class="ring-dot" :style="{ background: r.color }"></span>
              <span class="ring-label">{{ r.label }}</span>
              <span class="ring-val"
                >{{ r.value }}<span class="ring-goal"> / {{ r.goal }} {{ r.unit }}</span
                ><span v-if="r.pct >= 1" class="ring-done"> ✓</span></span
              >
            </div>
          </div>
        </div>
      </div>

      <div class="detail-tiles hist-tiles">
        <div>
          <span class="v">{{ streak }}<span class="unit">🔥</span></span>
          <span class="k">day streak</span>
        </div>
        <div>
          <span class="v">{{ sessions.length }}</span>
          <span class="k">{{ sessions.length === 1 ? 'walk' : 'walks' }} total</span>
        </div>
      </div>

      <div class="hist-section">
        <div class="daily-head">
          <h3>Daily detail</h3>
          <div class="range-chips">
            <button
              v-for="n in [7, 14, 30]"
              :key="n"
              class="chip"
              :class="{ on: chartDays === n }"
              @click="chartDays = n"
            >
              {{ n }}d
            </button>
          </div>
        </div>

        <div v-for="m in barCharts" :key="m.id" class="daychart">
          <div class="daychart-head">
            <span class="daychart-label"
              ><span class="ring-dot" :style="{ background: m.color }"></span>{{ m.label }}</span
            >
            <span class="daychart-total">{{ m.total }} {{ m.unit }}</span>
          </div>
          <div class="bars">
            <div
              v-for="(v, i) in m.values"
              :key="i"
              class="bar-slot"
              :title="`${daily[i]!.date}: ${v} ${m.unit}`"
            >
              <div
                class="bar"
                :style="
                  v === 0
                    ? { height: '2px', background: '#252b37' }
                    : { height: (v / m.max) * 100 + '%', background: m.color }
                "
              ></div>
            </div>
          </div>
          <div class="bar-labels">
            <span v-for="(d, i) in daily" :key="d.date">{{ dayLabel(d.date, i) }}</span>
          </div>
        </div>

        <div class="daychart">
          <div class="daychart-head">
            <span class="daychart-label"
              ><span class="ring-dot" :style="{ background: METRIC_COLORS.hr }"></span>Heart
              rate</span
            >
            <span v-if="hrChart" class="daychart-total"
              >{{ hrChart.lo }}–{{ hrChart.hi }} bpm · ─ avg</span
            >
          </div>
          <template v-if="hrChart">
            <div class="bars hr-bars">
              <div
                v-for="(b, i) in hrChart.bars"
                :key="i"
                class="bar-slot"
                :title="b ? b.title : ''"
              >
                <template v-if="b">
                  <div
                    class="hr-span"
                    :style="{ bottom: b.bottom + '%', height: b.height + '%' }"
                  ></div>
                  <div v-if="b.avg !== null" class="hr-avg" :style="{ bottom: b.avg + '%' }" />
                </template>
              </div>
            </div>
            <div class="bar-labels">
              <span v-for="(d, i) in daily" :key="d.date">{{ dayLabel(d.date, i) }}</span>
            </div>
          </template>
          <p v-else class="hint chart-empty-hint">
            No heart-rate data in this range — connect a HR sensor during a walk.
          </p>
        </div>
      </div>

      <div class="hist-section">
        <h3>Recent walks</h3>
        <ul class="walklist">
          <li v-for="w in recentWalks" :key="w.date">
            <button class="walk-row" @click="toggleWalk(w.date)">
              <span class="walk-when">
                <span class="walk-day">{{ walkDay(w.date) }}</span>
                <span class="walk-time">{{ walkTime(w.date) }}</span>
              </span>
              <span class="walk-stats">
                <span class="walk-stat">{{ fmtKm(w.distance) }}</span>
                <span class="walk-stat">{{ mmss(w.duration) }}</span>
                <span class="walk-stat">~{{ Math.round(w.kcal) }} kcal</span>
              </span>
            </button>
            <div v-if="expandedWalk === w.date" class="walk-detail">
              <div class="detail-tiles hist-tiles walk-tiles">
                <div>
                  <span class="v">{{ w.steps ?? '—' }}</span>
                  <span class="k">steps</span>
                </div>
                <div>
                  <span class="v">{{ w.avgHr ?? '—' }}</span>
                  <span class="k">avg bpm</span>
                </div>
                <div>
                  <span class="v">{{ w.hrMin != null ? `${w.hrMin}–${w.hrMax}` : '—' }}</span>
                  <span class="k">bpm range</span>
                </div>
              </div>
              <button class="btn ghost sm walk-delete" @click="emit('delete-session', w.date)">
                Delete this walk
              </button>
            </div>
          </li>
        </ul>
      </div>

      <div class="hist-section">
        <h3>By week</h3>
        <ul class="weeklist">
          <li v-for="w in weekly" :key="w.week">
            <div class="week-head">
              <span class="week-label">{{ w.week }}</span>
              <span class="week-meta"
                >{{ w.sessions }} {{ w.sessions === 1 ? 'walk' : 'walks' }}</span
              >
            </div>
            <div class="week-stats">
              <span class="week-stat"
                ><span class="week-stat-v">{{ (w.distance / 1000).toFixed(1) }}</span
                ><span class="week-stat-k">km</span></span
              >
              <span class="week-stat"
                ><span class="week-stat-v">{{ mmss(w.duration) }}</span
                ><span class="week-stat-k">time</span></span
              >
              <span class="week-stat"
                ><span class="week-stat-v">~{{ Math.round(w.kcal) }}</span
                ><span class="week-stat-k">kcal</span></span
              >
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div class="hist-section weight-section">
      <h3>Weight</h3>
      <div v-if="latestWeight" class="detail-tiles hist-tiles">
        <div>
          <span class="v">{{ latestWeight.kg.toFixed(1) }}<span class="unit">kg</span></span>
          <span class="k">latest</span>
        </div>
        <div>
          <span class="v"
            >{{ weightDelta === null ? '—' : (weightDelta > 0 ? '+' : '') + weightDelta.toFixed(1)
            }}<span v-if="weightDelta !== null" class="unit">kg</span></span
          >
          <span class="k">vs ~30 days</span>
        </div>
      </div>
      <template v-if="weightSpark">
        <svg class="weight-chart" viewBox="0 0 320 80" preserveAspectRatio="none">
          <path class="weight-area" :d="weightSpark.area" />
          <polyline class="weight-line" :points="weightSpark.line" />
        </svg>
        <div class="weight-range">
          {{ weightSpark.min.toFixed(1) }}–{{ weightSpark.max.toFixed(1) }} kg
        </div>
      </template>
      <p v-if="!weightLog.length" class="hint">No weigh-ins yet — log one to start the trend.</p>
      <div class="set-row weigh-row">
        <span class="set-inline">
          <input
            v-model.number="weighInInput"
            type="number"
            step="0.1"
            min="30"
            max="250"
            :placeholder="String(weightKg)"
            @keyup.enter="logWeighIn"
          />
          <span class="set-unit">kg</span>
        </span>
        <button class="btn go sm" :disabled="!weighInInput" @click="logWeighIn">
          Log weigh-in
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Local copies of the shared sheet chrome (.sheet/.sheet-head/.x/.hint) and the reused
   .detail-tiles/.set-* rules: App.vue's styles are scoped, so they don't reach into this
   component — each sheet component carries its own copy. Keep in sync with App.vue. */
.sheet {
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 20px 20px 0 0;
  width: 100%;
  max-width: 460px;
  max-height: 88vh;
  overflow-y: auto;
  padding: 8px 16px 24px;
}
/* Desktop (#48): sheets center as dialogs (instead of bottom-anchored) with more room —
   the statistics charts benefit most. */
@media (min-width: 900px) {
  .sheet {
    max-width: 640px;
    border-radius: 20px;
    padding: 8px 24px 24px;
  }
}
.sheet-head {
  display: flex;
  align-items: center;
  gap: 10px;
  position: sticky;
  top: 0;
  background: #12151b;
  padding: 10px 0;
}
.sheet-head h2 {
  font-size: 18px;
  font-weight: 800;
  flex: 1;
  text-align: center;
}
.x {
  background: #1b1f27;
  border: none;
  color: #cbd3df;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  font-size: 16px;
  cursor: pointer;
}
.hint {
  margin-top: 14px;
  font-size: 12.5px;
  color: #8a93a3;
  line-height: 1.5;
}
.detail-tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.detail-tiles > div {
  background: #171a21;
  border: 1px solid #232833;
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
  color: #8a93a3;
}
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
}
.set-row input[type='number'] {
  width: 72px;
  background: #12151b;
  border: 1px solid #232833;
  color: #e8ecf2;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 14px;
  text-align: right;
}
.set-inline {
  display: flex;
  align-items: center;
  gap: 6px;
}
.set-unit {
  color: #8a93a3;
  font-size: 13px;
}
/* --- statistics --- */
.hist-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  padding: 48px 16px 36px;
}
.hist-empty-icon {
  font-size: 40px;
  opacity: 0.6;
}
.hist-empty .hint {
  margin-top: 0;
}
.hist-body {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding-top: 4px;
}
.hist-tiles > div {
  padding: 16px 10px;
}
.hist-tiles .v {
  font-size: 26px;
}
.hist-tiles .unit {
  margin-left: 3px;
  font-size: 16px;
  vertical-align: 2px;
}
.hist-section h3 {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #8a93a3;
  margin: 0 0 10px 2px;
}
/* --- daily activity rings --- */
.rings-wrap {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 6px 2px;
}
.rings {
  width: 128px;
  height: 128px;
  flex: none;
}
.ring-track {
  fill: none;
  stroke-width: 10;
  opacity: 0.16;
}
.ring-fill {
  fill: none;
  stroke-width: 10;
  stroke-linecap: round;
  transition: stroke-dasharray 0.4s ease;
}
.ring-legend {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.ring-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
}
.ring-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
  display: inline-block;
  align-self: center;
}
.ring-label {
  color: #8a93a3;
  min-width: 62px;
}
.ring-val {
  font-weight: 700;
}
.ring-goal {
  color: #8a93a3;
  font-weight: 400;
  font-size: 12px;
}
.ring-done {
  color: var(--accent);
}
/* --- daily bar / HR charts --- */
.daily-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.range-chips {
  display: flex;
  gap: 6px;
}
.chip {
  background: #1b1f27;
  border: 1px solid #232833;
  color: #cbd3df;
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
  cursor: pointer;
}
.chip.on {
  background: var(--accent);
  border-color: transparent;
  color: #05210f;
  font-weight: 700;
}
.daychart {
  margin-top: 14px;
}
.daychart-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
  font-size: 13px;
}
.daychart-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #cbd3df;
  font-weight: 600;
}
.daychart-total {
  color: #8a93a3;
  font-size: 12px;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 64px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 10px;
  padding: 6px 6px 0;
  overflow: hidden;
}
.bar-slot {
  flex: 1;
  height: 100%;
  position: relative;
  display: flex;
  align-items: flex-end;
}
.bar {
  width: 100%;
  border-radius: 3px 3px 0 0;
}
.hr-bars {
  height: 90px;
  padding: 6px;
}
.hr-span {
  position: absolute;
  left: 18%;
  width: 64%;
  background: rgba(255, 71, 87, 0.4);
  border: 1px solid #ff4757;
  border-radius: 4px;
}
.hr-avg {
  position: absolute;
  left: 10%;
  width: 80%;
  height: 2px;
  border-radius: 1px;
  background: #e8ecf2;
}
.bar-labels {
  display: flex;
  gap: 2px;
  margin-top: 4px;
  padding: 0 6px;
}
.bar-labels span {
  flex: 1;
  text-align: center;
  font-size: 10px;
  color: #8a93a3;
}
.chart-empty-hint {
  margin: 4px 0 0;
  font-size: 12px;
}
.walklist {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.walk-row {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 12px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.15s;
}
.walk-row:hover {
  border-color: #333a46;
}
.walk-when {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.walk-day {
  font-weight: 700;
  font-size: 13.5px;
}
.walk-time {
  font-size: 11px;
  color: #8a93a3;
}
.walk-stats {
  display: flex;
  gap: 12px;
}
.walk-stat {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: #cbd3df;
}
.walk-detail {
  padding: 10px 6px 4px;
}
.walk-tiles {
  margin-bottom: 10px;
}
.walk-delete {
  color: #ff7f7f;
}

.weeklist {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.weeklist li {
  padding: 14px 16px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 14px;
  transition: border-color 0.15s;
}
.weeklist li:hover {
  border-color: #333a46;
}
.weight-chart {
  display: block;
  width: 100%;
  height: 90px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 14px;
}
.weight-area {
  fill: rgba(46, 213, 115, 0.12);
}
.weight-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
}
.weight-range {
  text-align: right;
  font-size: 11px;
  color: #8a93a3;
  margin-top: 4px;
}
.weight-section {
  /* separate the Weight block from the By-week block above it */
  margin-top: 22px;
}
.weight-section .hist-tiles {
  margin-bottom: 12px;
}
.weigh-row {
  margin-top: 10px;
}
.week-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}
.week-label {
  font-weight: 800;
  font-size: 14px;
  letter-spacing: 0.2px;
}
.week-meta {
  font-size: 12px;
  color: #8a93a3;
}
.week-stats {
  display: flex;
  gap: 10px;
}
.week-stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  background: #12151b;
  border-radius: 8px;
  text-align: center;
}
.week-stat-v {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.week-stat-k {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #8a93a3;
}
</style>
