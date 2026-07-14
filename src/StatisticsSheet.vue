<script setup lang="ts">
import { ref, computed } from 'vue'
import { currentStreak, dailyTotals, weekStart } from './statistics'
import type { Session, Goals } from './statistics'
import type { WeightEntry } from './weight'
import { mmss } from './format'

const props = defineProps<{
  sessions: Session[]
  weightLog: WeightEntry[]
  goalWeight?: number | null // target kg (#71); null/0 = no goal set
  goals: Goals
  weightKg: number
}>()
const emit = defineEmits<{
  close: []
  'weigh-in': [kg: number]
  'delete-session': [date: string]
}>()

// --- week navigation (#115): full calendar weeks Mon-Sun, ‹ › + date picker ---
const anchor = ref(weekStart()) // Monday of the displayed week
const days = computed(() => {
  // dailyTotals ends its window at `now`; feed it the week's Sunday for Mon-Sun
  const sunday = new Date(anchor.value)
  sunday.setDate(sunday.getDate() + 6)
  return dailyTotals(props.sessions, 7, sunday)
})
const isCurrentWeek = computed(() => anchor.value.getTime() === weekStart().getTime())
function shiftWeek(delta: number) {
  const d = new Date(anchor.value)
  d.setDate(d.getDate() + delta * 7)
  anchor.value = d
}
function goToday() {
  anchor.value = weekStart()
}
// native date input: value = the anchor Monday, any picked date jumps to its week
const anchorInput = computed(() => {
  const d = anchor.value
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})
function pickDate(e: Event) {
  const v = (e.target as HTMLInputElement).value
  if (v) anchor.value = weekStart(new Date(v + 'T12:00:00'))
}
const weekLabel = computed(() => {
  const a = anchor.value
  const b = new Date(a)
  b.setDate(b.getDate() + 6)
  const fmt = (d: Date, y: boolean) =>
    d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: y ? 'numeric' : undefined,
    })
  return `${fmt(a, false)} – ${fmt(b, true)}`
})
const todayKey = computed(() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})

// --- aligned lanes (#115 mock №4): kcal / steps / minutes / HR / weight on one day axis ---
const METRIC_COLORS = { kcal: '#2ed573', steps: '#6ab0ff', time: '#f5a623', hr: '#ff4757' }
const barLanes = computed(() => {
  const d = days.value
  return [
    {
      id: 'kcal',
      label: 'Calories',
      color: METRIC_COLORS.kcal,
      unit: 'kcal',
      values: d.map((x) => Math.round(x.kcal)),
    },
    {
      id: 'steps',
      label: 'Steps',
      color: METRIC_COLORS.steps,
      unit: 'steps',
      values: d.map((x) => x.steps),
    },
    {
      id: 'time',
      label: 'Minutes',
      color: METRIC_COLORS.time,
      unit: 'min',
      values: d.map((x) => Math.round(x.duration / 60)),
    },
  ].map((m) => ({
    ...m,
    max: Math.max(...m.values, 1),
    total: m.values.reduce((a, b) => a + b, 0),
  }))
})

// HR lane: min–max span + avg tick per day, padded shared scale over the week
const hrLane = computed(() => {
  const d = days.value
  const withHr = d.filter((x) => x.hrMin !== null)
  if (!withHr.length) return null
  const lo = Math.min(...withHr.map((x) => x.hrMin!)) - 5
  const hi = Math.max(...withHr.map((x) => x.hrMax!)) + 5
  const span = hi - lo
  return {
    lo: lo + 5,
    hi: hi - 5,
    bars: d.map((x) =>
      x.hrMin === null
        ? null
        : {
            bottom: ((x.hrMin - lo) / span) * 100,
            height: Math.max(((x.hrMax! - x.hrMin) / span) * 100, 4),
            avg: x.hrAvg === null ? null : ((x.hrAvg - lo) / span) * 100,
            title: `${x.date}: ${x.hrMin}–${x.hrMax} bpm · avg ${x.hrAvg}`,
          },
    ),
  }
})

// Weight lane: weigh-ins that fall inside the displayed week, dot per entry on the
// day axis, plus the goal line. The full-log trend lives in the right-rail card.
const weightLane = computed(() => {
  const a = anchor.value.getTime()
  const entries = props.weightLog
    .map((e) => ({ e, t: new Date(e.date).getTime() }))
    .filter(({ t }) => t >= a && t < a + 7 * 86400000)
  if (!entries.length) return null
  const kgs = entries.map(({ e }) => e.kg)
  if (props.goalWeight) kgs.push(props.goalWeight)
  const min = Math.min(...kgs)
  const rng = Math.max(0.5, Math.max(...kgs) - min)
  const H = 56
  const y = (kg: number) => H - 0.15 * H - ((kg - min) / rng) * 0.7 * H
  const pts = entries.map(({ e, t }) => ({
    x: (((t - a) / (7 * 86400000)) * 320).toFixed(1),
    y: y(e.kg).toFixed(1),
    kg: e.kg,
  }))
  return {
    pts,
    line: pts.map((p) => `${p.x},${p.y}`).join(' '),
    goalY: props.goalWeight ? y(props.goalWeight) : null,
    latest: entries[entries.length - 1]!.e.kg,
  }
})

function dayLabel(dateKey: string) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })
}

// --- right rail: summary / walk log / weight ---
const streak = computed(() => currentStreak(props.sessions))
const todayPct = computed(() => {
  const t = dailyTotals(props.sessions, 1)[0]!
  const pcts = [
    t.kcal / props.goals.kcal,
    t.steps / props.goals.steps,
    t.duration / 60 / props.goals.minutes,
  ].map((p) => Math.min(p, 1))
  return Math.round((pcts.reduce((a, b) => a + b, 0) / 3) * 100)
})
const weekDistance = computed(() => days.value.reduce((a, d) => a + d.distance, 0))

// Walk log: the displayed week's walks, newest first (#67 detail/delete kept).
const weekWalks = computed(() => {
  const a = anchor.value.getTime()
  return [...props.sessions]
    .filter((s) => {
      const t = new Date(s.date).getTime()
      return t >= a && t < a + 7 * 86400000
    })
    .reverse()
})
const expandedWalk = ref<string | null>(null)
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

// --- weight card (issue #16 / #71) — unchanged semantics from the old sheet ---
const latestWeight = computed(() => props.weightLog[props.weightLog.length - 1] ?? null)
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
const toGoal = computed(() => {
  if (!props.goalWeight || !latestWeight.value) return null
  return Math.round((latestWeight.value.kg - props.goalWeight) * 10) / 10
})
const weightSpark = computed(() => {
  const log = props.weightLog
  if (log.length < 2) return null
  const W = 320,
    H = 80
  const kgs = log.map((e) => e.kg)
  if (props.goalWeight) kgs.push(props.goalWeight)
  const min = Math.min(...kgs),
    max = Math.max(...kgs)
  const rng = Math.max(0.5, max - min)
  const t0 = new Date(log[0].date).getTime()
  const span = Math.max(1, new Date(log[log.length - 1].date).getTime() - t0)
  const pts = log.map(
    (e) =>
      `${(((new Date(e.date).getTime() - t0) / span) * W).toFixed(1)},${(H - 0.12 * H - ((e.kg - min) / rng) * 0.76 * H).toFixed(1)}`,
  )
  const goalY = props.goalWeight ? H - 0.12 * H - ((props.goalWeight - min) / rng) * 0.76 * H : null
  return { line: pts.join(' '), area: `M0,${H} L${pts.join(' L')} L${W},${H} Z`, min, max, goalY }
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
  <div class="statspage">
    <div class="stats-topbar">
      <button class="x" @click="emit('close')">‹</button>
      <h2>Statistics</h2>
      <div class="week-nav">
        <button class="x wk-btn" title="Previous week" @click="shiftWeek(-1)">‹</button>
        <label class="week-label">
          <span>{{ weekLabel }}</span>
          <input type="date" class="week-date" :value="anchorInput" @change="pickDate" />
        </label>
        <button class="x wk-btn" title="Next week" @click="shiftWeek(1)">›</button>
        <button v-if="!isCurrentWeek" class="chip today-chip" @click="goToday">This week</button>
      </div>
    </div>

    <div class="stats-grid">
      <!-- left: aligned daily lanes, one shared Mon-Sun axis -->
      <div class="card lanes-card">
        <h3>Daily trends</h3>
        <div v-if="!sessions.length" class="hist-empty">
          <span class="hist-empty-icon">🏃</span>
          <p class="hint">No walks logged yet — finish a walk to see it here.</p>
        </div>
        <div v-else class="lanes">
          <template v-for="m in barLanes" :key="m.id">
            <div class="lane-side">
              <span class="lane-name" :style="{ color: m.color }">{{ m.label }}</span>
              <span class="lane-total">{{ m.total }} {{ m.unit }}</span>
            </div>
            <div class="lane bars">
              <div
                v-for="(v, i) in m.values"
                :key="i"
                class="bar-slot"
                :title="`${days[i]!.date}: ${v} ${m.unit}`"
              >
                <div
                  class="bar"
                  :class="{ today: days[i]!.date === todayKey }"
                  :style="
                    v === 0
                      ? { height: '2px', background: '#252b37' }
                      : { height: (v / m.max) * 100 + '%', background: m.color }
                  "
                ></div>
              </div>
            </div>
          </template>

          <div class="lane-side">
            <span class="lane-name" :style="{ color: METRIC_COLORS.hr }">Heart rate</span>
            <span class="lane-total">{{ hrLane ? `${hrLane.lo}–${hrLane.hi} bpm` : '—' }}</span>
          </div>
          <div class="lane bars hr-bars">
            <template v-if="hrLane">
              <div
                v-for="(b, i) in hrLane.bars"
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
            </template>
            <p v-else class="hint lane-empty">No heart-rate data this week.</p>
          </div>

          <div class="lane-side">
            <span class="lane-name weight-name">Weight</span>
            <span class="lane-total">{{
              weightLane ? `${weightLane.latest.toFixed(1)} kg` : '—'
            }}</span>
          </div>
          <div class="lane weight-lane">
            <svg v-if="weightLane" viewBox="0 0 320 56" preserveAspectRatio="none">
              <line
                v-if="weightLane.goalY !== null"
                class="weight-goal-line"
                x1="0"
                :y1="weightLane.goalY"
                x2="320"
                :y2="weightLane.goalY"
              />
              <polyline
                v-if="weightLane.pts.length > 1"
                class="weight-line"
                :points="weightLane.line"
              />
              <circle
                v-for="(p, i) in weightLane.pts"
                :key="i"
                class="weight-dot"
                :cx="p.x"
                :cy="p.y"
                r="3.5"
              />
            </svg>
            <p v-else class="hint lane-empty">No weigh-ins this week.</p>
          </div>

          <div></div>
          <div class="bar-labels">
            <span v-for="d in days" :key="d.date" :class="{ 'label-today': d.date === todayKey }">{{
              dayLabel(d.date)
            }}</span>
          </div>
        </div>
      </div>

      <!-- right rail -->
      <div class="rail">
        <div class="card summary-card">
          <div>
            <span class="v">{{ todayPct }}%</span>
            <span class="k">goals today</span>
          </div>
          <div>
            <span class="v">{{ streak }}🔥</span>
            <span class="k">streak</span>
          </div>
          <div>
            <span class="v">{{ (weekDistance / 1000).toFixed(1) }}</span>
            <span class="k">km this week</span>
          </div>
          <div>
            <span class="v">{{ sessions.length }}</span>
            <span class="k">walks total</span>
          </div>
        </div>

        <div class="card">
          <h3>Walk log</h3>
          <ul v-if="weekWalks.length" class="walklist">
            <li v-for="w in weekWalks" :key="w.date">
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
          <p v-else class="hint">No walks in this week.</p>
        </div>

        <div class="card weight-section">
          <h3>Weight</h3>
          <div v-if="latestWeight" class="detail-tiles hist-tiles">
            <div>
              <span class="v">{{ latestWeight.kg.toFixed(1) }}<span class="unit">kg</span></span>
              <span class="k">latest</span>
            </div>
            <div>
              <span class="v"
                >{{
                  weightDelta === null
                    ? '—'
                    : (weightDelta > 0 ? '+' : '') + weightDelta.toFixed(1)
                }}<span v-if="weightDelta !== null" class="unit">kg</span></span
              >
              <span class="k">vs ~30 days</span>
            </div>
            <div v-if="toGoal !== null">
              <span class="v"
                >{{ (toGoal > 0 ? '' : '+') + Math.abs(toGoal).toFixed(1)
                }}<span class="unit">kg</span></span
              >
              <span class="k">{{ toGoal > 0 ? 'to goal' : 'past goal' }}</span>
            </div>
          </div>
          <template v-if="weightSpark">
            <svg class="weight-chart" viewBox="0 0 320 80" preserveAspectRatio="none">
              <path class="weight-area" :d="weightSpark.area" />
              <line
                v-if="weightSpark.goalY !== null"
                class="weight-goal-line"
                x1="0"
                :y1="weightSpark.goalY"
                x2="320"
                :y2="weightSpark.goalY"
              />
              <polyline class="weight-line" :points="weightSpark.line" />
            </svg>
            <div class="weight-range">
              {{ weightSpark.min.toFixed(1) }}–{{ weightSpark.max.toFixed(1) }} kg
            </div>
          </template>
          <p v-if="!weightLog.length" class="hint">
            No weigh-ins yet — log one to start the trend.
          </p>
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
    </div>
  </div>
</template>

<style scoped>
/* Full-page dashboard (#115, mock №4): fixed overlay page, aligned lanes left,
   summary/walk-log/weight rail right. Shares the app's dark theme tokens. */
.statspage {
  position: fixed;
  inset: 0;
  z-index: 40;
  overflow-y: auto;
  background: radial-gradient(120% 90% at 50% 0%, #12151b 0%, #0c0e13 60%, #090b0f 100%);
  padding-bottom: 28px;
}
.stats-topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 22px;
  border-bottom: 1px solid #232833;
  position: sticky;
  top: 0;
  background: #0d1015;
  z-index: 2;
}
.stats-topbar h2 {
  font-size: 19px;
  font-weight: 800;
  margin-right: auto;
}
.x {
  background: #1b1f27;
  border: 1px solid #232833;
  color: #cbd3df;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  font-size: 16px;
  cursor: pointer;
}
.week-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wk-btn {
  border-radius: 50%;
}
.week-label {
  position: relative;
  font-size: 13.5px;
  font-weight: 700;
  padding: 7px 12px;
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 10px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* invisible native date input stretched over the label — tap the label, get the picker */
.week-date {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.chip {
  background: #1b1f27;
  border: 1px solid #232833;
  color: #cbd3df;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.today-chip {
  background: var(--accent);
  border-color: transparent;
  color: #05210f;
  font-weight: 700;
}
.hint {
  font-size: 12.5px;
  color: #8a93a3;
  line-height: 1.5;
}
.hist-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  padding: 64px 16px;
}
.hist-empty-icon {
  font-size: 40px;
  opacity: 0.6;
}
.stats-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  padding: 18px 22px;
  max-width: 1360px;
  margin: 0 auto;
}
@media (min-width: 1000px) {
  .stats-grid {
    grid-template-columns: minmax(0, 1fr) 400px;
    align-items: start;
  }
}
.card {
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 14px;
  padding: 16px;
}
.card h3 {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.7px;
  color: #8a93a3;
  margin: 0 0 12px;
}
/* --- lanes --- */
.lanes {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  row-gap: 18px;
  column-gap: 12px;
  align-items: end;
}
.lane-side {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 2px;
}
.lane-name {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 700;
}
.weight-name {
  color: #8a93a3;
}
.lane-total {
  font-size: 15px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.lane {
  min-width: 0;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  height: 56px;
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
  opacity: 0.75;
}
.bar.today {
  opacity: 1;
}
.hr-bars {
  align-items: stretch;
}
.hr-span {
  position: absolute;
  left: 30%;
  width: 40%;
  background: rgba(255, 71, 87, 0.4);
  border: 1px solid #ff4757;
  border-radius: 4px;
}
.hr-avg {
  position: absolute;
  left: 22%;
  width: 56%;
  height: 2px;
  border-radius: 1px;
  background: #e8ecf2;
}
.weight-lane svg {
  display: block;
  width: 100%;
  height: 56px;
}
.weight-dot {
  fill: #6ab0ff;
}
.lane-empty {
  align-self: center;
  margin: 0 auto;
}
.bar-labels {
  display: flex;
  gap: 5px;
}
.bar-labels span {
  flex: 1;
  text-align: center;
  font-size: 11px;
  color: #8a93a3;
}
.label-today {
  color: var(--accent);
  font-weight: 700;
}
/* --- right rail --- */
.rail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.summary-card {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  text-align: center;
}
.summary-card .v {
  display: block;
  font-size: 21px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.summary-card .k {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #8a93a3;
}
.detail-tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.detail-tiles > div {
  background: #12151b;
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
.hist-tiles .unit {
  margin-left: 3px;
  font-size: 14px;
  vertical-align: 2px;
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
  background: #12151b;
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
/* --- weight card --- */
.weight-section .hist-tiles {
  margin-bottom: 12px;
}
.weight-chart {
  display: block;
  width: 100%;
  height: 80px;
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 12px;
}
.weight-area {
  fill: rgba(46, 213, 115, 0.12);
}
.weight-goal-line {
  stroke: #6ab0ff;
  stroke-width: 1.2;
  stroke-dasharray: 5 4;
  vector-effect: non-scaling-stroke;
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
.weigh-row {
  margin-top: 12px;
}
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #12151b;
  border: 1px solid #232833;
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
}
.set-row input[type='number'] {
  width: 72px;
  background: #171a21;
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
</style>
