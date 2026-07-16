<script setup lang="ts">
import type { TreadmillState } from './treadmill'
import type { HeartRateState } from './heartrate'
import type { StravaState } from './strava'
import type { HealthProvider } from './health'

// The composable objects are passed through whole (their `state` is reactive); methods
// are called directly on them — only actions that mutate App-owned state (the weight
// log) go back up as emits.
defineProps<{
  tm: {
    state: TreadmillState
    connect: () => Promise<void> | void
    disconnect: () => void
    forget: () => void
  }
  hr: {
    state: HeartRateState
    connect: () => Promise<void> | void
    disconnect: () => void
    forget: () => void
  }
  strava: {
    state: StravaState
    connect: () => Promise<void> | void
    disconnect: () => void
  }
  providers: HealthProvider[]
  scenicSupported: boolean
}>()
import { exportData, exportCsv, importData } from './backup'
import { ref } from 'vue'
import { t, locale, LOCALES } from './i18n'

// --- backup & restore (#69) ---
const includeTokens = ref(false)
const dataMsg = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
function doExport() {
  const blob = new Blob([exportData(includeTokens.value)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `walkfit-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  dataMsg.value = 'Backup downloaded.'
}
// CSV export (#147): read-only spreadsheet dump of the session log, separate from
// the JSON backup above — this one isn't meant to round-trip through Import.
function doExportCsv() {
  const blob = new Blob([exportCsv()], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `walkfit-sessions-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
async function doImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const applied = importData(await file.text())
    dataMsg.value = `Restored ${applied} entries — reloading…`
    emit('imported')
  } catch (err) {
    dataMsg.value = (err as Error).message
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

const emit = defineEmits<{
  close: []
  'weight-changed': []
  'sync-provider': [p: HealthProvider]
  imported: []
}>()

const maxHr = defineModel<number>('maxHr', { required: true })
const weightKg = defineModel<number>('weightKg', { required: true })
const audioOn = defineModel<boolean>('audioOn', { required: true })
const debugOn = defineModel<boolean>('debugOn', { required: true })
const stravaAutoUpload = defineModel<boolean>('stravaAutoUpload', { required: true })
const goalWeight = defineModel<number>('goalWeight', { required: true })
const scenicTime = defineModel<string>('scenicTime', { required: true })
const viewMode = defineModel<'track' | 'scenic'>('viewMode', { required: true })
const goalKcal = defineModel<number>('goalKcal', { required: true })
const goalSteps = defineModel<number>('goalSteps', { required: true })
const goalMinutes = defineModel<number>('goalMinutes', { required: true })

function fmtSynced(ms: number | null) {
  return ms ? new Date(ms).toLocaleString() : t('settings.never')
}
</script>

<template>
  <div class="sheet">
    <div class="sheet-head">
      <h2>{{ t('settings.title') }}</h2>
      <button class="x" @click="emit('close')">✕</button>
    </div>
    <div class="settings">
      <h3>{{ t('settings.treadmill') }}</h3>
      <div class="set-row">
        <span>{{
          tm.state.connected
            ? tm.state.deviceName
            : tm.state.remembered
              ? t('settings.remembered')
              : t('settings.notConnected')
        }}</span>
        <div class="set-actions">
          <button
            v-if="!tm.state.connected"
            class="btn ghost sm"
            :disabled="tm.state.connecting"
            @click="tm.connect"
          >
            {{ tm.state.connecting ? t('settings.connecting') : t('settings.connect') }}
          </button>
          <button v-else class="btn ghost sm" @click="tm.disconnect">
            {{ t('settings.disconnect') }}
          </button>
          <button v-if="tm.state.remembered" class="btn ghost sm forget" @click="tm.forget">
            {{ t('settings.forget') }}
          </button>
        </div>
      </div>

      <h3>{{ t('settings.heartRate') }}</h3>
      <div class="set-row">
        <span>{{
          hr.state.connected
            ? hr.state.deviceName
            : hr.state.remembered
              ? t('settings.remembered')
              : t('settings.notConnected')
        }}</span>
        <div class="set-actions">
          <button
            v-if="!hr.state.connected"
            class="btn ghost sm"
            :disabled="hr.state.connecting"
            @click="hr.connect"
          >
            {{ hr.state.connecting ? t('settings.connecting') : t('settings.connect') }}
          </button>
          <button v-else class="btn ghost sm" @click="hr.disconnect">
            {{ t('settings.disconnect') }}
          </button>
          <button v-if="hr.state.remembered" class="btn ghost sm forget" @click="hr.forget">
            {{ t('settings.forget') }}
          </button>
        </div>
      </div>
      <div class="set-row">
        <span>{{ t('settings.maxHr') }}</span>
        <input v-model.number="maxHr" type="number" min="120" max="220" />
      </div>
      <p class="set-note">
        {{
          t('settings.fatburnNote', { lo: Math.round(maxHr * 0.6), hi: Math.round(maxHr * 0.7) })
        }}
      </p>
      <div class="set-row">
        <span>{{ t('settings.weight') }}</span>
        <span class="set-inline">
          <input
            v-model.number="weightKg"
            type="number"
            min="30"
            max="250"
            @change="emit('weight-changed')"
          />
          <span class="set-unit">kg</span>
        </span>
      </div>
      <p class="set-note">{{ t('settings.weightNote') }}</p>
      <div class="set-row">
        <span>{{ t('settings.goalWeight') }}</span>
        <span class="set-inline">
          <input v-model.number="goalWeight" type="number" min="0" max="250" placeholder="—" />
          <span class="set-unit">kg</span>
        </span>
      </div>
      <p class="set-note">{{ t('settings.goalWeightNote') }}</p>

      <h3>{{ t('settings.dailyGoals') }}</h3>
      <div class="set-row">
        <span>{{ t('settings.calories') }}</span>
        <span class="set-inline">
          <input v-model.number="goalKcal" type="number" min="50" max="5000" step="50" />
          <span class="set-unit">kcal</span>
        </span>
      </div>
      <div class="set-row">
        <span>{{ t('settings.steps') }}</span>
        <input v-model.number="goalSteps" type="number" min="500" max="50000" step="500" />
      </div>
      <div class="set-row">
        <span>{{ t('settings.activityTime') }}</span>
        <span class="set-inline">
          <input v-model.number="goalMinutes" type="number" min="5" max="300" step="5" />
          <span class="set-unit">min</span>
        </span>
      </div>
      <p class="set-note">{{ t('settings.goalsNote') }}</p>

      <h3>{{ t('settings.display') }}</h3>
      <div class="set-row">
        <span>{{ t('settings.trackView') }}</span>
        <div class="set-actions">
          <button
            :class="viewMode === 'track' ? 'btn primary sm' : 'btn ghost sm'"
            @click="viewMode = 'track'"
          >
            2D
          </button>
          <button
            :class="viewMode === 'scenic' ? 'btn primary sm' : 'btn ghost sm'"
            :disabled="!scenicSupported"
            :title="scenicSupported ? undefined : t('settings.needsWebgl')"
            @click="viewMode = 'scenic'"
          >
            3D
          </button>
        </div>
      </div>
      <div class="set-row">
        <span>{{ t('settings.language') }}</span>
        <select v-model="locale" class="set-select">
          <option v-for="l in LOCALES" :key="l.id" :value="l.id">{{ l.label }}</option>
        </select>
      </div>
      <div class="set-row">
        <span>{{ t('settings.timeOfDay') }}</span>
        <select v-model="scenicTime" class="set-select">
          <option value="auto">{{ t('settings.todAuto') }}</option>
          <option value="dawn">{{ t('settings.todDawn') }}</option>
          <option value="day">{{ t('settings.todDay') }}</option>
          <option value="sunset">{{ t('settings.todSunset') }}</option>
          <option value="night">{{ t('settings.todNight') }}</option>
        </select>
      </div>

      <template v-if="strava.state.supported">
        <h3>Strava</h3>
        <div class="set-row">
          <span>{{
            strava.state.connected
              ? strava.state.athleteName || t('settings.connected')
              : t('settings.notConnected')
          }}</span>
          <div class="set-actions">
            <button
              v-if="!strava.state.connected"
              class="btn ghost sm"
              :disabled="strava.state.connecting"
              @click="strava.connect"
            >
              {{ strava.state.connecting ? t('settings.connecting') : t('settings.connect') }}
            </button>
            <button v-else class="btn ghost sm" @click="strava.disconnect">
              {{ t('settings.disconnect') }}
            </button>
          </div>
        </div>
        <p v-if="strava.state.error" class="set-note warn-note">{{ strava.state.error }}</p>
        <div v-if="strava.state.connected" class="set-row">
          <span>{{ t('settings.autoUpload') }}</span>
          <input v-model="stravaAutoUpload" type="checkbox" class="set-check" />
        </div>
        <p class="set-note">
          {{ stravaAutoUpload ? t('settings.autoUploadOn') : t('settings.autoUploadOff') }}
        </p>
      </template>

      <template v-for="p in providers" :key="p.id">
        <template v-if="p.state.supported">
          <h3>{{ p.name }}</h3>
          <div class="set-row">
            <span>{{
              p.state.connected
                ? p.state.accountLabel || t('settings.connected')
                : t('settings.notConnected')
            }}</span>
            <div class="set-actions">
              <button
                v-if="!p.state.connected"
                class="btn ghost sm"
                :disabled="p.state.connecting"
                @click="p.connect"
              >
                {{ p.state.connecting ? t('settings.connecting') : t('settings.connect') }}
              </button>
              <template v-else>
                <button
                  class="btn ghost sm"
                  :disabled="p.state.syncing"
                  @click="emit('sync-provider', p)"
                >
                  {{ p.state.syncing ? t('settings.syncing') : t('settings.syncNow') }}
                </button>
                <button class="btn ghost sm" @click="p.disconnect">
                  {{ t('settings.disconnect') }}
                </button>
              </template>
            </div>
          </div>
          <p v-if="p.state.error" class="set-note warn-note">{{ p.state.error }}</p>
          <p class="set-note">
            {{ t('settings.weighInsSync')
            }}{{
              p.state.connected
                ? t('settings.lastSynced', { when: fmtSynced(p.state.lastSync) })
                : ''
            }}.
          </p>
        </template>
      </template>

      <h3>{{ t('settings.data') }}</h3>
      <div class="set-row">
        <span>{{ t('settings.backup') }}</span>
        <div class="set-actions">
          <button class="btn ghost sm" @click="doExport">{{ t('settings.export') }}</button>
          <button class="btn ghost sm" @click="fileInput?.click()">
            {{ t('settings.import') }}
          </button>
          <input
            ref="fileInput"
            type="file"
            class="file-hidden"
            accept="application/json"
            @change="doImport"
          />
        </div>
      </div>
      <div class="set-row">
        <span>{{ t('settings.csvExport') }}</span>
        <button class="btn ghost sm" @click="doExportCsv">{{ t('settings.export') }}</button>
      </div>
      <label class="set-note tokens-opt">
        <input v-model="includeTokens" type="checkbox" />
        {{ t('settings.includeTokens') }}
      </label>
      <p class="set-note">
        {{ dataMsg || t('settings.importNote') }}
      </p>

      <h3>{{ t('settings.sound') }}</h3>
      <label class="set-row toggle">
        <span>{{ t('settings.audioCues') }}</span>
        <input v-model="audioOn" type="checkbox" />
      </label>
      <p class="set-note">{{ t('settings.soundNote') }}</p>

      <h3>{{ t('settings.advanced') }}</h3>
      <label class="set-row toggle">
        <span>{{ t('settings.debug') }}</span>
        <input v-model="debugOn" type="checkbox" />
      </label>
    </div>
  </div>
</template>

<style scoped>
/* Local copies of the shared sheet chrome (.sheet/.sheet-head/.x/.warn-note): App.vue's
   styles are scoped, so they don't reach into this component — each sheet component
   carries its own copy. Keep in sync with App.vue. */
.sheet {
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.95);
  color: #17324d;
  backdrop-filter: blur(24px);
  box-shadow: 0 18px 50px rgba(23, 50, 77, 0.2);
  border-radius: 20px 20px 0 0;
  width: 100%;
  max-width: 460px;
  max-height: 88vh;
  overflow-y: auto;
  padding: 8px 16px 24px;
}
/* Desktop (#48): sheets center as dialogs (instead of bottom-anchored) with more room. */
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
  z-index: 2;
  /* was transparent — scrolled content bled through the sticky title (#178). A sticky
     header inside a constantly-scrolling sheet needs to be near-opaque, not just
     frosted like a stationary card — content passes directly behind it continuously,
     not just at rest, so 0.55-0.7 alpha (fine for .stats-topbar, .sstat) still let
     text show through here. */
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(16px);
  margin: 0 -16px;
  padding: 10px 16px;
  border-radius: 20px 20px 0 0;
}
@media (min-width: 900px) {
  .sheet-head {
    margin: 0 -24px;
    padding: 10px 24px;
  }
}
.sheet-head h2 {
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
.warn-note {
  color: #ff7f50;
}
.settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 8px;
}
.settings h3 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #5a789a;
  margin-top: 10px;
}
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  color: #17324d;
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
.set-row input[type='checkbox'] {
  width: 20px;
  height: 20px;
  accent-color: var(--accent);
}
.set-row.toggle {
  cursor: pointer;
}
.set-note {
  font-size: 12.5px;
  color: #5a789a;
  padding: 0 2px;
}
.set-actions {
  display: flex;
  gap: 8px;
}
.file-hidden {
  display: none;
}
.tokens-opt {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
.set-select {
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(23, 50, 77, 0.15);
  border-radius: 8px;
  color: inherit;
  font: inherit;
  padding: 6px 10px;
}
</style>
