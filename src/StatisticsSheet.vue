<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { currentStreak, dailyTotals, weekStart } from './statistics'
import type { Session, Goals } from './statistics'
import type { WeightEntry } from './weight'
import { mmss } from './format'
import { t, locale, localeTag } from './i18n'
import Logo from './Logo.vue'

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

// Reactive clock (#134): a treadmill kiosk leaves this page open across midnight or
// the Sunday-to-Monday rollover; everything date-derived depends on this ref instead
// of caching new Date() once at mount.
const now = ref(new Date())
let clockTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clockTimer = setInterval(() => (now.value = new Date()), 30_000)
})
onUnmounted(() => clearInterval(clockTimer))

// --- week navigation (#115): full calendar weeks Mon-Sun, ‹ › + date picker ---
const anchor = ref(weekStart()) // Monday of the displayed week
// the calendar week rolled over while showing the current week: follow it
watch(
  () => weekStart(now.value).getTime(),
  (t, old) => {
    if (anchor.value.getTime() === old) anchor.value = new Date(t)
  },
)
const days = computed(() => {
  // dailyTotals ends its window at `now`; feed it the week's Sunday for Mon-Sun
  const sunday = new Date(anchor.value)
  sunday.setDate(sunday.getDate() + 6)
  return dailyTotals(props.sessions, 7, sunday)
})
const isCurrentWeek = computed(() => anchor.value.getTime() === weekStart(now.value).getTime())
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
  void locale.value // re-render the label on language switch
  const a = anchor.value
  const b = new Date(a)
  b.setDate(b.getDate() + 6)
  const fmt = (d: Date, y: boolean) =>
    d.toLocaleDateString(localeTag(), {
      day: 'numeric',
      month: 'short',
      year: y ? 'numeric' : undefined,
    })
  return `${fmt(a, false)} – ${fmt(b, true)}`
})
const todayKey = computed(() => {
  const d = now.value
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
      label: t('stats.calories'),
      color: METRIC_COLORS.kcal,
      unit: 'kcal',
      values: d.map((x) => Math.round(x.kcal)),
    },
    {
      id: 'steps',
      label: t('stats.steps'),
      color: METRIC_COLORS.steps,
      unit: 'steps',
      values: d.map((x) => x.steps),
    },
    {
      id: 'time',
      label: t('stats.minutes'),
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

// --- hero band (#115 mock №3) ---
const weekKcal = computed(() => days.value.reduce((a, d) => a + d.kcal, 0))
const weekDuration = computed(() => days.value.reduce((a, d) => a + d.duration, 0))
function hhmm(sec: number) {
  return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
}

// --- week-over-week deltas (#143): the same shape one week earlier, purely computed
// from sessions already in memory — no new data, no new storage ---
const prevWeekDays = computed(() => {
  const prevSunday = new Date(anchor.value)
  prevSunday.setDate(prevSunday.getDate() - 1) // day before this week's Monday
  return dailyTotals(props.sessions, 7, prevSunday)
})
const prevWeekDistance = computed(() => prevWeekDays.value.reduce((a, d) => a + d.distance, 0))
const prevWeekKcal = computed(() => prevWeekDays.value.reduce((a, d) => a + d.kcal, 0))
const prevWeekDuration = computed(() => prevWeekDays.value.reduce((a, d) => a + d.duration, 0))
// null when there's nothing to compare against yet, so the hero can hide the chip
// instead of showing a misleading "+100%"
function delta(cur: number, prev: number): number | null {
  return prev > 0 ? cur - prev : null
}
function fmtDelta(d: number | null, fmt: (n: number) => string): string | null {
  if (d === null || Math.abs(d) < 1e-9) return null
  return (d > 0 ? '+' : '') + fmt(d)
}
const distanceDelta = computed(() =>
  fmtDelta(delta(weekDistance.value, prevWeekDistance.value), (m) => (m / 1000).toFixed(1) + ' km'),
)
const kcalDelta = computed(() =>
  fmtDelta(delta(weekKcal.value, prevWeekKcal.value), (k) => Math.round(k) + ' kcal'),
)
const durationDelta = computed(() =>
  fmtDelta(delta(weekDuration.value, prevWeekDuration.value), (s) => Math.round(s / 60) + ' min'),
)

function dayLabel(dateKey: string) {
  return new Date(dateKey + 'T00:00:00').toLocaleDateString(localeTag(), { weekday: 'short' })
}

// --- right rail: summary / walk log / weight ---
const streak = computed(() => currentStreak(props.sessions, now.value))
const todayPct = computed(() => {
  const today = dailyTotals(props.sessions, 1, now.value)[0]!
  // a mid-edit emptied goal input reaches here as '' — guard the divide (#137)
  const frac = (v: number, goal: number) => (Number(goal) > 0 ? Math.min(v / Number(goal), 1) : 0)
  const pcts = [
    frac(today.kcal, props.goals.kcal),
    frac(today.steps, props.goals.steps),
    frac(today.duration / 60, props.goals.minutes),
  ]
  return Math.round((pcts.reduce((a, b) => a + b, 0) / 3) * 100)
})
const weekDistance = computed(() => days.value.reduce((a, d) => a + d.distance, 0))

// Walk log: the displayed week's walks, newest first (#67 detail/delete kept).
// The exclusive bound is next Monday via local-calendar arithmetic, NOT anchor+168h:
// a DST week is 167 or 169 hours, and the fixed window dropped/duplicated walks near
// the Sunday-night boundary (#135).
const weekWalks = computed(() => {
  const a = anchor.value.getTime()
  const end = new Date(anchor.value)
  end.setDate(end.getDate() + 7)
  const b = end.getTime()
  return [...props.sessions]
    .filter((s) => {
      const t = new Date(s.date).getTime()
      return t >= a && t < b
    })
    .reverse()
})
const expandedWalk = ref<string | null>(null)
function toggleWalk(date: string) {
  expandedWalk.value = expandedWalk.value === date ? null : date
}
function walkDay(iso: string) {
  return new Date(iso).toLocaleDateString(localeTag(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}
function walkTime(iso: string) {
  return new Date(iso).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
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
// body composition (#42): shown only when the provider reports them
const latestFat = computed(() => [...props.weightLog].reverse().find((e) => e.fatPct != null))
const latestMuscle = computed(() => [...props.weightLog].reverse().find((e) => e.muscleKg != null))
const fatSpark = computed(() => {
  const log = props.weightLog.filter((e) => e.fatPct != null)
  if (log.length < 2) return null
  const W = 320,
    H = 56
  const vals = log.map((e) => e.fatPct!)
  const min = Math.min(...vals),
    max = Math.max(...vals)
  const rng = Math.max(0.5, max - min)
  const t0 = new Date(log[0]!.date).getTime()
  const span = Math.max(1, new Date(log[log.length - 1]!.date).getTime() - t0)
  const pts = log.map(
    (e) =>
      `${(((new Date(e.date).getTime() - t0) / span) * W).toFixed(1)},${(H - 0.15 * H - ((e.fatPct! - min) / rng) * 0.7 * H).toFixed(1)}`,
  )
  return { line: pts.join(' '), min, max }
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
      <Logo :size="19" />
      <h2>{{ t('stats.title') }}</h2>
      <div class="week-nav">
        <button class="x wk-btn" :title="t('stats.prevWeek')" @click="shiftWeek(-1)">‹</button>
        <label class="week-label">
          <span>{{ weekLabel }}</span>
          <input type="date" class="week-date" :value="anchorInput" @change="pickDate" />
        </label>
        <button class="x wk-btn" :title="t('stats.nextWeek')" @click="shiftWeek(1)">›</button>
        <button v-if="!isCurrentWeek" class="chip today-chip" @click="goToday">
          {{ t('stats.thisWeek') }}
        </button>
      </div>
    </div>

    <!-- hero band: the shown week's headline numbers + today's goals ring -->
    <div class="hero-band">
      <div class="hero-stat">
        <span class="hero-v">{{ (weekDistance / 1000).toFixed(1) }}<small> km</small></span>
        <span class="hero-k">{{ t('stats.kmWeek') }}</span>
        <span v-if="distanceDelta" class="hero-delta" :title="t('stats.vsLastWeek')">{{
          distanceDelta
        }}</span>
      </div>
      <div class="hero-stat">
        <span class="hero-v">{{ Math.round(weekKcal) }}<small> kcal</small></span>
        <span class="hero-k">{{ t('stats.kcalWeek') }}</span>
        <span v-if="kcalDelta" class="hero-delta" :title="t('stats.vsLastWeek')">{{
          kcalDelta
        }}</span>
      </div>
      <div class="hero-stat">
        <span class="hero-v">{{ hhmm(weekDuration) }}<small> h</small></span>
        <span class="hero-k">{{ t('stats.activeWeek') }}</span>
        <span v-if="durationDelta" class="hero-delta" :title="t('stats.vsLastWeek')">{{
          durationDelta
        }}</span>
      </div>
      <div class="hero-stat">
        <span class="hero-v">{{ streak }}<small> 🔥</small></span>
        <span class="hero-k">{{ t('stats.streak') }}</span>
      </div>
      <div class="hero-stat">
        <span class="hero-ring">
          <svg viewBox="0 0 64 64">
            <circle class="hero-ring-track" cx="32" cy="32" r="26" />
            <circle
              class="hero-ring-fill"
              cx="32"
              cy="32"
              r="26"
              :stroke-dasharray="`${(todayPct / 100) * 163.4} 163.4`"
              transform="rotate(-90 32 32)"
            />
          </svg>
          <span class="hero-ring-val">{{ todayPct }}%</span>
        </span>
        <span class="hero-k">{{ t('stats.goalsToday') }}</span>
      </div>
    </div>

    <!-- Single scrolling page (#178): no tabs — Activity, Heart rate, Weight and Walks
         all render together instead of behind 4 clicks each hiding ~400px of dead space -->
    <div class="panel single-page">
      <template v-if="sessions.length">
        <!-- Activity: kcal / steps / minutes per day, Mon-Sun -->
        <div class="activity-grid">
          <div v-for="m in barLanes" :key="m.id" class="card">
            <h3>
              <span :style="{ color: m.color }">{{ t('stats.perDay', { metric: m.label }) }}</span>
              <span class="card-total">{{ m.total }} {{ m.unit }}</span>
            </h3>
            <div class="bars">
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
            <div class="bar-labels">
              <span
                v-for="d in days"
                :key="d.date"
                :class="{ 'label-today': d.date === todayKey }"
                >{{ dayLabel(d.date) }}</span
              >
            </div>
          </div>
        </div>

        <!-- Heart rate: min-max span + avg dot per day, on a gridded baseline so it
             reads as a chart instead of floating rectangles (#178) -->
        <div class="card hr-card">
          <h3>
            <span style="color: #ff4757">{{ t('stats.hrPerDay') }}</span>
            <span class="card-total">{{
              hrLane ? t('stats.hrRange', { lo: hrLane.lo, hi: hrLane.hi }) : ''
            }}</span>
          </h3>
          <template v-if="hrLane">
            <div class="bars hr-bars">
              <div class="hr-grid"><span></span><span></span><span></span></div>
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
            </div>
            <div class="bar-labels">
              <span
                v-for="d in days"
                :key="d.date"
                :class="{ 'label-today': d.date === todayKey }"
                >{{ dayLabel(d.date) }}</span
              >
            </div>
          </template>
          <p v-else class="hint">{{ t('stats.noHr') }}</p>
        </div>
      </template>
      <div v-else class="hist-empty">
        <span class="hist-empty-icon">🏃</span>
        <p class="hint">{{ t('stats.empty') }}</p>
      </div>

      <!-- Weight: full-log trend + weigh-in, reachable even with zero walks -->
      <div class="card weight-section">
        <div v-if="latestWeight" class="detail-tiles hist-tiles">
          <div>
            <span class="v">{{ latestWeight.kg.toFixed(1) }}<span class="unit">kg</span></span>
            <span class="k">{{ t('stats.latest') }}</span>
          </div>
          <div>
            <span class="v"
              >{{
                weightDelta === null ? '—' : (weightDelta > 0 ? '+' : '') + weightDelta.toFixed(1)
              }}<span v-if="weightDelta !== null" class="unit">kg</span></span
            >
            <span class="k">{{ t('stats.vs30') }}</span>
          </div>
          <div v-if="toGoal !== null">
            <span class="v"
              >{{ (toGoal > 0 ? '' : '+') + Math.abs(toGoal).toFixed(1)
              }}<span class="unit">kg</span></span
            >
            <span class="k">{{ toGoal > 0 ? t('stats.toGoal') : t('stats.pastGoal') }}</span>
          </div>
        </div>
        <div v-if="latestFat || latestMuscle" class="detail-tiles hist-tiles comp-tiles">
          <div v-if="latestFat">
            <span class="v">{{ latestFat.fatPct!.toFixed(1) }}<span class="unit">%</span></span>
            <span class="k">{{ t('stats.bodyFat') }}</span>
          </div>
          <div v-if="latestMuscle">
            <span class="v"
              >{{ latestMuscle.muscleKg!.toFixed(1) }}<span class="unit">kg</span></span
            >
            <span class="k">{{ t('stats.muscle') }}</span>
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
        <template v-if="fatSpark">
          <svg class="weight-chart fat-chart" viewBox="0 0 320 56" preserveAspectRatio="none">
            <polyline class="fat-line" :points="fatSpark.line" />
          </svg>
          <div class="weight-range">
            {{ t('stats.fatRange', { lo: fatSpark.min.toFixed(1), hi: fatSpark.max.toFixed(1) }) }}
          </div>
        </template>
        <p v-if="!weightLog.length" class="hint">{{ t('stats.noWeighIns') }}</p>
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
            {{ t('stats.logWeighIn') }}
          </button>
        </div>
      </div>

      <!-- Walks: the shown week's log, expandable detail + delete (#67) -->
      <div v-if="sessions.length" class="card">
        <h3>
          <span>{{ t('stats.walkLog') }}</span
          ><span class="card-total">{{ t('stats.walksTotal', { n: sessions.length }) }}</span>
        </h3>
        <ul v-if="weekWalks.length" class="walklist">
          <li v-for="w in weekWalks" :key="w.date">
            <button class="walk-row" @click="toggleWalk(w.date)">
              <span class="walk-when">
                <span class="walk-day"
                  >{{ walkDay(w.date)
                  }}<span v-if="w.workout" class="walk-workout"> · {{ w.workout }}</span></span
                >
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
                  <span class="k">{{ t('stats.stepsTile') }}</span>
                </div>
                <div>
                  <span class="v">{{ w.avgHr ?? '—' }}</span>
                  <span class="k">{{ t('stats.avgBpm') }}</span>
                </div>
                <div>
                  <span class="v">{{ w.hrMin != null ? `${w.hrMin}–${w.hrMax}` : '—' }}</span>
                  <span class="k">{{ t('stats.bpmRange') }}</span>
                </div>
              </div>
              <button class="btn ghost sm walk-delete" @click="emit('delete-session', w.date)">
                {{ t('stats.deleteWalk') }}
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="hint">{{ t('stats.noWalks') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Full-page dashboard (#115, mock №3): hero week band + tab panels. */
.statspage {
  position: fixed;
  inset: 0;
  z-index: 40;
  overflow-y: auto;
  background:
    radial-gradient(340px 90px at 12% 10%, rgba(255, 255, 255, 0.8) 40%, transparent 70%),
    radial-gradient(260px 70px at 84% 16%, rgba(255, 255, 255, 0.7) 40%, transparent 70%),
    linear-gradient(165deg, #aee3ff 0%, #dff2fe 40%, #ffe9d6 100%);
  color: #17324d;
  padding-bottom: 28px;
}
.stats-topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 22px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.9);
  position: sticky;
  top: 0;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(16px);
  z-index: 2;
}
.stats-topbar h2 {
  font-size: 15px;
  font-weight: 600;
  color: #5a789a;
  margin-right: auto;
  padding-left: 10px;
  border-left: 1px solid rgba(23, 50, 77, 0.15);
}
.x {
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(23, 50, 77, 0.1);
  color: #17324d;
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  color: #17324d;
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  color: #17324d;
  border-radius: 999px;
  padding: 6px 18px;
  font-size: 13px;
  cursor: pointer;
}
.chip.on {
  background: var(--accent);
  border-color: transparent;
  color: #fff;
  font-weight: 700;
}
.today-chip {
  background: var(--accent);
  border-color: transparent;
  color: #fff;
  font-weight: 700;
  padding: 5px 12px;
  font-size: 12px;
}
.hint {
  font-size: 12.5px;
  color: #5a789a;
  line-height: 1.5;
}
/* --- hero band --- */
.hero-band {
  display: flex;
  gap: 32px;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  /* was 26px/side — a whole tab's worth of chrome above the fold mattered more when
     everything below was 1 tab-click away; now the page starts sooner (#178) */
  padding: 16px 22px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.7);
  background: transparent;
}
.hero-stat {
  text-align: center;
}
.hero-v {
  display: block;
  font-size: 28px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
.hero-v small {
  font-size: 15px;
  color: #5a789a;
  font-weight: 600;
}
.hero-k {
  font-size: 12px;
  color: #5a789a;
}
/* week-over-week delta (#143) — neutral styling on purpose: more isn't always
   "better" (rest weeks are fine), so no green-up/red-down judgement */
.hero-delta {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
  margin-top: 1px;
}
.hero-ring {
  position: relative;
  display: block;
  width: 46px;
  height: 46px;
  margin: 0 auto;
}
.hero-ring svg {
  width: 100%;
  height: 100%;
}
.hero-ring-track,
.hero-ring-fill {
  fill: none;
  stroke-width: 7;
}
.hero-ring-track {
  stroke: rgba(23, 50, 77, 0.12);
}
.hero-ring-fill {
  stroke: var(--accent);
  stroke-linecap: round;
}
.hero-ring-val {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  font-weight: 800;
}
/* --- single scrolling page (#178): Activity, Heart rate, Weight, Walks all visible,
   stacked with consistent gaps instead of behind 4 tab clicks --- */
.panel {
  max-width: 1080px;
  margin: 0 auto;
  padding: 14px 22px;
}
.single-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.activity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}
.card {
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(14px);
  border-radius: 14px;
  padding: 16px;
}
.card h3 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.7px;
  color: #5a789a;
  margin: 0 0 12px;
}
.card-total {
  font-size: 12px;
  text-transform: none;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
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
/* --- bars --- */
.bars {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  height: 96px;
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
  height: 130px;
  position: relative;
}
/* faint baseline gridlines (#178) — the bare floating spans read as decoration
   without them, not a chart */
.hr-grid {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column-reverse;
  justify-content: space-between;
  pointer-events: none;
}
.hr-grid span {
  border-top: 1px dashed rgba(23, 50, 77, 0.1);
  height: 0;
}
.hr-span {
  position: absolute;
  left: 30%;
  width: 40%;
  background: rgba(255, 71, 87, 0.4);
  border: 1px solid #ff4757;
  border-radius: 4px;
}
/* a dot reads as "here's the average" more clearly than a hairline bisecting the
   whole span (#178) */
.hr-avg {
  position: absolute;
  left: 50%;
  width: 8px;
  height: 8px;
  margin: -4px 0 0 -4px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #17324d;
}
.bar-labels {
  display: flex;
  gap: 5px;
  margin-top: 6px;
}
.bar-labels span {
  flex: 1;
  text-align: center;
  font-size: 11px;
  color: #5a789a;
}
.label-today {
  color: var(--accent);
  font-weight: 700;
}
/* --- walks --- */
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
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 12px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.15s;
}
.walk-row:hover {
  border-color: var(--accent);
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
/* workout name on the row (#142) — same size, lighter weight so the date stays primary */
.walk-workout {
  font-weight: 500;
  color: #5a789a;
}
.walk-time {
  font-size: 11px;
  color: #5a789a;
}
.walk-stats {
  display: flex;
  gap: 12px;
}
.walk-stat {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: #17324d;
}
.walk-detail {
  padding: 10px 6px 4px;
}
.walk-tiles {
  margin-bottom: 10px;
}
.walk-delete {
  color: #e0284a;
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
.hist-tiles .unit {
  margin-left: 3px;
  font-size: 14px;
  vertical-align: 2px;
}
/* --- weight --- */
.weight-section .hist-tiles {
  margin-bottom: 12px;
}
.weight-chart {
  display: block;
  width: 100%;
  height: 80px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 12px;
}
.weight-area {
  fill: rgba(10, 132, 255, 0.12);
}
.weight-goal-line {
  stroke: #1c6dd0;
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
  color: #5a789a;
  margin-top: 4px;
}
.comp-tiles {
  grid-template-columns: repeat(2, 1fr);
  margin-top: 12px;
}
.fat-chart {
  height: 56px;
  margin-top: 12px;
}
.fat-line {
  fill: none;
  stroke: #f5a623;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
}
.weigh-row {
  margin-top: 12px;
}
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px;
}
.set-row input[type='number'] {
  width: 72px;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(23, 50, 77, 0.15);
  color: #17324d;
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
  color: #5a789a;
  font-size: 13px;
}
</style>
