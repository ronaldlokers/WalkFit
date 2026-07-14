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
import { exportData, importData } from './backup'
import { ref } from 'vue'

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
const bigNumbers = defineModel<boolean>('bigNumbers', { required: true })
const goalKcal = defineModel<number>('goalKcal', { required: true })
const goalSteps = defineModel<number>('goalSteps', { required: true })
const goalMinutes = defineModel<number>('goalMinutes', { required: true })

function fmtSynced(ms: number | null) {
  return ms ? new Date(ms).toLocaleString() : 'never'
}
</script>

<template>
  <div class="sheet">
    <div class="sheet-head">
      <h2>Settings</h2>
      <button class="x" @click="emit('close')">✕</button>
    </div>
    <div class="settings">
      <h3>Treadmill</h3>
      <div class="set-row">
        <span>{{
          tm.state.connected
            ? tm.state.deviceName
            : tm.state.remembered
              ? 'Remembered'
              : 'Not connected'
        }}</span>
        <div class="set-actions">
          <button
            v-if="!tm.state.connected"
            class="btn ghost sm"
            :disabled="tm.state.connecting"
            @click="tm.connect"
          >
            {{ tm.state.connecting ? 'Connecting…' : 'Connect' }}
          </button>
          <button v-else class="btn ghost sm" @click="tm.disconnect">Disconnect</button>
          <button v-if="tm.state.remembered" class="btn ghost sm forget" @click="tm.forget">
            Forget
          </button>
        </div>
      </div>

      <h3>Heart rate</h3>
      <div class="set-row">
        <span>{{
          hr.state.connected
            ? hr.state.deviceName
            : hr.state.remembered
              ? 'Remembered'
              : 'Not connected'
        }}</span>
        <div class="set-actions">
          <button
            v-if="!hr.state.connected"
            class="btn ghost sm"
            :disabled="hr.state.connecting"
            @click="hr.connect"
          >
            {{ hr.state.connecting ? 'Connecting…' : 'Connect' }}
          </button>
          <button v-else class="btn ghost sm" @click="hr.disconnect">Disconnect</button>
          <button v-if="hr.state.remembered" class="btn ghost sm forget" @click="hr.forget">
            Forget
          </button>
        </div>
      </div>
      <div class="set-row">
        <span>Max HR</span>
        <input v-model.number="maxHr" type="number" min="120" max="220" />
      </div>
      <p class="set-note">
        Fat-burn zone: {{ Math.round(maxHr * 0.6) }}–{{ Math.round(maxHr * 0.7) }} bpm
      </p>
      <div class="set-row">
        <span>Weight</span>
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
      <p class="set-note">Used to estimate calories burned.</p>
      <div class="set-row">
        <span>Goal weight</span>
        <span class="set-inline">
          <input v-model.number="goalWeight" type="number" min="0" max="250" placeholder="—" />
          <span class="set-unit">kg</span>
        </span>
      </div>
      <p class="set-note">Draws a target line on the weight trend. 0 = no goal.</p>

      <h3>Daily goals</h3>
      <div class="set-row">
        <span>Calories</span>
        <span class="set-inline">
          <input v-model.number="goalKcal" type="number" min="50" max="5000" step="50" />
          <span class="set-unit">kcal</span>
        </span>
      </div>
      <div class="set-row">
        <span>Steps</span>
        <input v-model.number="goalSteps" type="number" min="500" max="50000" step="500" />
      </div>
      <div class="set-row">
        <span>Activity time</span>
        <span class="set-inline">
          <input v-model.number="goalMinutes" type="number" min="5" max="300" step="5" />
          <span class="set-unit">min</span>
        </span>
      </div>
      <p class="set-note">The activity rings in Statistics fill toward these.</p>

      <h3>Display</h3>
      <div class="set-row">
        <span>Track view</span>
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
            :title="scenicSupported ? undefined : 'Needs WebGL'"
            @click="viewMode = 'scenic'"
          >
            3D
          </button>
        </div>
      </div>
      <div class="set-row">
        <span>Big numbers (kiosk)</span>
        <input v-model="bigNumbers" type="checkbox" />
      </div>
      <div class="set-row">
        <span>3D time of day</span>
        <select v-model="scenicTime" class="set-select">
          <option value="auto">Auto (follows distance)</option>
          <option value="dawn">Dawn</option>
          <option value="day">Day</option>
          <option value="sunset">Sunset</option>
          <option value="night">Night</option>
        </select>
      </div>

      <template v-if="strava.state.supported">
        <h3>Strava</h3>
        <div class="set-row">
          <span>{{
            strava.state.connected ? strava.state.athleteName || 'Connected' : 'Not connected'
          }}</span>
          <div class="set-actions">
            <button
              v-if="!strava.state.connected"
              class="btn ghost sm"
              :disabled="strava.state.connecting"
              @click="strava.connect"
            >
              {{ strava.state.connecting ? 'Connecting…' : 'Connect' }}
            </button>
            <button v-else class="btn ghost sm" @click="strava.disconnect">Disconnect</button>
          </div>
        </div>
        <p v-if="strava.state.error" class="set-note warn-note">{{ strava.state.error }}</p>
        <div v-if="strava.state.connected" class="set-row">
          <span>Auto-upload walks</span>
          <input v-model="stravaAutoUpload" type="checkbox" class="set-check" />
        </div>
        <p class="set-note">
          {{
            stravaAutoUpload
              ? 'Finished walks upload automatically; failures fall back to the prompt.'
              : 'Prompts to upload each finished walk once connected.'
          }}
        </p>
      </template>

      <template v-for="p in providers" :key="p.id">
        <template v-if="p.state.supported">
          <h3>{{ p.name }}</h3>
          <div class="set-row">
            <span>{{
              p.state.connected ? p.state.accountLabel || 'Connected' : 'Not connected'
            }}</span>
            <div class="set-actions">
              <button
                v-if="!p.state.connected"
                class="btn ghost sm"
                :disabled="p.state.connecting"
                @click="p.connect"
              >
                {{ p.state.connecting ? 'Connecting…' : 'Connect' }}
              </button>
              <template v-else>
                <button
                  class="btn ghost sm"
                  :disabled="p.state.syncing"
                  @click="emit('sync-provider', p)"
                >
                  {{ p.state.syncing ? 'Syncing…' : 'Sync now' }}
                </button>
                <button class="btn ghost sm" @click="p.disconnect">Disconnect</button>
              </template>
            </div>
          </div>
          <p v-if="p.state.error" class="set-note warn-note">{{ p.state.error }}</p>
          <p class="set-note">
            Weigh-ins sync into the weight log{{
              p.state.connected ? ` — last synced ${fmtSynced(p.state.lastSync)}` : ''
            }}.
          </p>
        </template>
      </template>

      <h3>Data</h3>
      <div class="set-row">
        <span>Backup</span>
        <div class="set-actions">
          <button class="btn ghost sm" @click="doExport">Export</button>
          <button class="btn ghost sm" @click="fileInput?.click()">Import</button>
          <input
            ref="fileInput"
            type="file"
            accept="application/json,.json"
            class="file-hidden"
            @change="doImport"
          />
        </div>
      </div>
      <label class="set-note tokens-opt">
        <input v-model="includeTokens" type="checkbox" />
        include connection tokens (device-specific secrets)
      </label>
      <p class="set-note">
        {{ dataMsg || 'Sessions and weigh-ins merge on import; settings overwrite.' }}
      </p>

      <h3>Sound</h3>
      <label class="set-row toggle">
        <span>Audio cues</span>
        <input v-model="audioOn" type="checkbox" />
      </label>
      <p class="set-note">Countdown beeps + spoken speed at segment changes, lap chime.</p>

      <h3>Advanced</h3>
      <label class="set-row toggle">
        <span>Debug panel</span>
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
  background: #12151b;
  border: 1px solid #232833;
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
  color: #8a93a3;
  margin-top: 10px;
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
  color: #8a93a3;
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
  background: #171a21;
  border: 1px solid #232833;
  border-radius: 8px;
  color: inherit;
  font: inherit;
  padding: 6px 10px;
}
</style>
