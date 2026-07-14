import { reactive } from 'vue'
import {
  setSpeedFrame,
  STATUS_QUERY,
  SPORT_DATA_QUERY,
  parseTelemetry,
  createSpeedFilter,
} from './protocol'

// --- Dreaver Motion One (FitShow FS-BT-T4) BLE identifiers ---
// Canonical 128-bit UUID strings, not 0x… aliases: Bluefy (iOS Web Bluetooth
// bridge) fails to parse numeric aliases in requestDevice ("request payload
// could not be parsed"); strings work everywhere, including Chrome.
const FTMS_SERVICE = '00001826-0000-1000-8000-00805f9b34fb' // Fitness Machine Service
const FTMS_CONTROL = '00002ad9-0000-1000-8000-00805f9b34fb' // Fitness Machine Control Point (write + indicate)
const VENDOR_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb' // FitShow vendor service
const VENDOR_WRITE = '0000fff2-0000-1000-8000-00805f9b34fb' // vendor command channel (write w/o response)
const VENDOR_NOTIFY = '0000fff1-0000-1000-8000-00805f9b34fb' // vendor telemetry stream (notify)
const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb' // Device Information
const HR_SERVICE_TM = '0000180d-0000-1000-8000-00805f9b34fb' // some units expose HR too

export const SPEED_MIN = 1.0 // km/h  (from FTMS supported-speed range 2ad4)
export const SPEED_MAX = 6.0 // km/h
export const SPEED_STEP = 0.1

export interface TreadmillState {
  secure: boolean
  hasApi: boolean
  supported: boolean
  connecting: boolean
  connected: boolean
  remembered: boolean
  running: boolean // belt actually moving (from telemetry)
  deviceName: string
  speed: number // live speed reported by device (km/h)
  targetSpeed: number // last speed we asked for (km/h)
  distance: number // metres, integrated client-side from live speed
  steps: number // step count reported by the belt's own pedometer (fff1 running frame)
  beltDistance: number // metres, the belt's own session counter (survives OUR reloads, #66)
  beltKcal: number
  beltTime: number // seconds, belt-side
  elapsed: number // seconds the belt has been moving
  error: string
  history: number[] // speed (km/h) sampled once per second since connect
  log: string[] // TEMP debug: recent speed-write / speed-rx events
}

export function useTreadmill() {
  const state = reactive<TreadmillState>({
    secure: window.isSecureContext,
    hasApi: 'bluetooth' in navigator,
    supported: window.isSecureContext && 'bluetooth' in navigator,
    connecting: false,
    connected: false,
    remembered: !!localStorage.getItem('walkfit.treadmill.id'),
    running: false,
    deviceName: '',
    speed: 0,
    targetSpeed: SPEED_MIN,
    distance: 0,
    steps: 0,
    beltDistance: 0,
    beltKcal: 0,
    beltTime: 0,
    elapsed: 0,
    error: '',
    history: [],
    log: [],
  })
  function dbg(ev: string, val: number) {
    state.log.push(`${(performance.now() / 1000).toFixed(1)} ${ev} ${val}`)
    if (state.log.length > 16) state.log.shift()
  }
  const MAX_SAMPLES = 1800 // ~30 min of history

  let device: BluetoothDevice | null = null
  let control: BluetoothRemoteGATTCharacteristic | null = null // FTMS control point characteristic
  let vendorWrite: BluetoothRemoteGATTCharacteristic | null = null // fff2
  let vendorNotify: BluetoothRemoteGATTCharacteristic | null = null // fff1
  let ticker: ReturnType<typeof setInterval> | null = null // distance/time integrator
  let sampler: ReturnType<typeof setInterval> | null = null // 1 Hz speed-history sampler
  let poller: ReturnType<typeof setInterval> | null = null // 1 Hz status query — the FW doesn't stream running data
  // unprompted; writing 02 51 03 elicits a running-data frame
  let lastTick = 0
  let lastEnforce = 0 // throttle for target-speed enforcement
  let enforceUntil = 0 // stop re-sending after this time (bounds the retry window)
  let lastSpeedRx = 0 // time of last accepted speed frame (for staleness stop)

  // The firmware interleaves TWO 02 53 02 speed frames: the real speed (km/h x10) and a
  // duplicate at exactly 2x (same speed in 0.05 km/h units), byte-identical in structure.
  // The real value is therefore always the smaller of the pair: track readings over a
  // short window and report the minimum. No dependence on the commanded target, so it
  // tracks ramps and remote-driven changes correctly.
  const speedFilter = createSpeedFilter(1600)
  function onSpeedReading(v: number) {
    lastSpeedRx = performance.now()
    if (v === 0) {
      speedFilter.reset()
      state.speed = 0
      state.running = false
      dbg('rx', 0)
      return
    }
    const min = speedFilter.push(v, lastSpeedRx)
    state.speed = min
    state.running = true
    dbg(v === min ? 'rx' : 'x2', v) // 'x2' = discarded phantom 2x frame
  }

  // Step-capture debug: when localStorage['walkfit.capture']==='1', dump every raw fff1
  // frame (including the ones parseTelemetry drops — the step count likely lives in one of
  // those) to the console with a timestamp, and the poller additionally sends the 0x52
  // SPORT_DATA query. Walk a known number of steps, then correlate the display's counter
  // against the changing bytes to find the step field. Off by default — zero effect on
  // normal use. See issue #43.
  const capturing = () => localStorage.getItem('walkfit.capture') === '1'
  function captureRaw(b: Uint8Array) {
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')
    console.log(`[fff1] ${(performance.now() / 1000).toFixed(2)}s len=${b.length} ${hex}`)
  }

  function onTelemetry(event: Event) {
    const dv = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!dv) return
    const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
    if (capturing()) captureRaw(b)
    const ev = parseTelemetry(b)
    if (!ev) return
    // NB the device emits 02 53 01 03 "idle" even while running, so status frames must
    // NOT zero the speed — speed comes only from 'speed' events + the staleness timeout.
    if (ev.type === 'speed') {
      onSpeedReading(ev.speed)
      if (ev.steps !== undefined) state.steps = ev.steps // belt's own pedometer count
      if (ev.beltDistance !== undefined) state.beltDistance = ev.beltDistance
      if (ev.beltKcal !== undefined) state.beltKcal = ev.beltKcal
      if (ev.beltTime !== undefined) state.beltTime = ev.beltTime
    } else if (ev.type === 'status') dbg('st1', ev.running ? 0 : 3)
    else if (ev.type === 'stop') dbg('st3', 0)
  }

  function startTicker() {
    lastTick = performance.now()
    stopTicker()
    ticker = setInterval(() => {
      const now = performance.now()
      const dt = (now - lastTick) / 1000
      lastTick = now
      if (state.running && state.speed > 0) {
        state.distance += ((state.speed * 1000) / 3600) * dt // km/h -> m/s
        state.elapsed += dt
      }
      // Staleness stop: if no speed frame for a while, the belt has stopped.
      if (state.speed > 0 && now - lastSpeedRx > 3000) {
        state.speed = 0
        state.running = false
      }
      // Enforce the target speed only for a bounded window after it changes: writes are
      // ignored during the belt's 3-2-1 start countdown, so retry until the belt reaches
      // the target — but stop once matched (or the window ends) to avoid endless writes.
      if (state.running && vendorWrite) {
        if (Math.abs(state.speed - state.targetSpeed) < 0.05) {
          enforceUntil = 0
        } else if (now < enforceUntil && now - lastEnforce > 900) {
          lastEnforce = now
          writeSpeed(state.targetSpeed)
          dbg('enforce', state.targetSpeed)
        }
      }
    }, 250)
    sampler = setInterval(() => {
      state.history.push(state.speed)
      if (state.history.length > MAX_SAMPLES) state.history.shift()
    }, 1000)
    poller = setInterval(() => {
      if (vendorWrite) {
        vendorWrite.writeValueWithoutResponse(STATUS_QUERY).catch(() => {})
        // Also probe the SPORT_DATA query while capturing, in case steps arrive only there.
        if (capturing()) vendorWrite.writeValueWithoutResponse(SPORT_DATA_QUERY).catch(() => {})
      }
    }, 1000)
  }
  function stopTicker() {
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
    if (sampler) {
      clearInterval(sampler)
      sampler = null
    }
    if (poller) {
      clearInterval(poller)
      poller = null
    }
  }

  // Attach attempts carry a generation (#56): bumping it invalidates any still-running
  // attempt (an autoConnect whose 8s timeout already fired, a connect superseded by a
  // newer one), so a slow device finishing late can't hijack state from the winner.
  let attachGen = 0

  // Unhook + null everything belonging to the current device, so stale characteristics
  // can't be written after a disconnect (start() on a powered-off belt used to pass the
  // `if (!control)` guard and reject unhandled) and an old device's late
  // gattserverdisconnected event can't kill a newer connection.
  function detach() {
    if (vendorNotify) vendorNotify.removeEventListener('characteristicvaluechanged', onTelemetry)
    if (device) device.removeEventListener('gattserverdisconnected', onDisconnected)
    control = null
    vendorWrite = null
    vendorNotify = null
    device = null
  }

  // Wire up a chosen device: connect GATT, resolve characteristics, subscribe, start
  // loops. State/listeners are committed only at the end, once everything resolved and
  // the attempt is still the current generation — a throw mid-way leaves no half-wired
  // device behind (the GATT link is released so re-pairing starts clean).
  async function attach(dev: BluetoothDevice) {
    const gen = ++attachGen
    try {
      const gatt = await dev.gatt!.connect()
      const ftms = await gatt.getPrimaryService(FTMS_SERVICE)
      const ctl = await ftms.getCharacteristic(FTMS_CONTROL)
      const vendor = await gatt.getPrimaryService(VENDOR_SERVICE)
      const vw = await vendor.getCharacteristic(VENDOR_WRITE)
      const vn = await vendor.getCharacteristic(VENDOR_NOTIFY)
      await vn.startNotifications()
      if (gen !== attachGen) {
        // superseded while connecting — release the link instead of hijacking state
        try {
          dev.gatt?.disconnect()
        } catch {}
        return
      }
      detach() // drop any previous device's wiring before adopting this one
      device = dev
      control = ctl
      vendorWrite = vw
      vendorNotify = vn
      dev.addEventListener('gattserverdisconnected', onDisconnected)
      vn.addEventListener('characteristicvaluechanged', onTelemetry)
      state.deviceName = dev.name || 'Dreaver Motion One'
      state.connected = true
      state.remembered = true
      localStorage.setItem('walkfit.treadmill.id', dev.id)
      startTicker()
    } catch (e) {
      try {
        dev.gatt?.disconnect()
      } catch {}
      throw e
    }
  }

  async function connect() {
    if (!state.supported) {
      state.error =
        'Web Bluetooth not available. In Brave: enable brave://flags/#brave-web-bluetooth-api and relaunch. Otherwise use Chrome or Edge.'
      return
    }
    if (state.connecting) return // reentrancy guard: a connect is already in flight
    state.error = ''
    state.connecting = true
    try {
      const dev = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Dreaver' }, { namePrefix: 'Motion' }],
        optionalServices: [FTMS_SERVICE, VENDOR_SERVICE, DIS_SERVICE, HR_SERVICE_TM],
      })
      await attach(dev)
    } catch (e) {
      // cancelling the chooser is a normal action, not an error to banner
      if ((e as DOMException).name !== 'NotFoundError') {
        state.error = (e as Error).message || String(e)
      }
    } finally {
      state.connecting = false
    }
  }

  // Silent reconnect on load to a previously-granted device (no picker). Times out so a
  // powered-off treadmill doesn't hang. Requires navigator.bluetooth.getDevices support.
  async function autoConnect() {
    if (!state.supported || !navigator.bluetooth.getDevices) return
    const id = localStorage.getItem('walkfit.treadmill.id')
    if (!id) return
    let dev
    try {
      dev = (await navigator.bluetooth.getDevices()).find((d) => d.id === id)
    } catch {
      return
    }
    if (!dev) return
    if (state.connecting) return // a manual connect is already in flight
    state.connecting = true
    try {
      await Promise.race([
        attach(dev),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ])
    } catch {
      // not in range / off — user can connect manually. Invalidate the still-running
      // attach so it can't finish late and hijack state (#56); it releases its own link.
      attachGen++
    } finally {
      state.connecting = false
    }
  }

  function onDisconnected() {
    detach() // stale characteristics must not be writable after this point
    state.connected = false
    state.running = false
    state.speed = 0
    stopTicker()
  }

  async function disconnect() {
    attachGen++ // user intent: also invalidate any in-flight attach
    try {
      if (device?.gatt?.connected) device.gatt.disconnect()
    } catch {}
    onDisconnected()
  }

  // Forget: disconnect, drop the saved id, and revoke the Web Bluetooth permission so it
  // won't silently reconnect. Works whether or not it's currently connected this session.
  async function forget() {
    attachGen++ // user intent: also invalidate any in-flight attach
    const id = localStorage.getItem('walkfit.treadmill.id')
    try {
      let d = device
      if (!d && navigator.bluetooth.getDevices)
        d = (await navigator.bluetooth.getDevices()).find((x) => x.id === id) ?? null
      if (d?.gatt?.connected) d.gatt.disconnect()
      if (d?.forget) await d.forget()
    } catch {}
    localStorage.removeItem('walkfit.treadmill.id')
    state.remembered = false
    state.deviceName = ''
    onDisconnected()
  }

  // FTMS: request control + start. Belt still needs its physical safety key / a foot
  // on the belt; it beeps and counts down 3-2-1 before the belt moves.
  async function start() {
    if (!control) return
    await control.writeValueWithResponse(Uint8Array.of(0x00)) // request control
    await control.writeValueWithResponse(Uint8Array.of(0x07)) // start / resume
    await setSpeed(state.targetSpeed)
  }

  async function stop() {
    if (!control) return
    await control.writeValueWithResponse(Uint8Array.of(0x08, 0x01))
    state.running = false
    state.speed = 0
  }

  // FTMS Pause (08 02): spec-standard, but — unlike start/stop — NOT yet verified on
  // this belt's firmware. If the FW ignores it the belt just keeps moving and state
  // recovers from telemetry; if it stops the belt like Stop, resume (07) restarts it.
  async function pause() {
    if (!control) return
    await control.writeValueWithResponse(Uint8Array.of(0x08, 0x02))
    state.running = false
    state.speed = 0
  }

  // Speed control goes through the vendor channel (FTMS set-speed is ignored by this FW).
  function writeSpeed(kmh: number) {
    if (!vendorWrite) return
    return vendorWrite.writeValueWithoutResponse(setSpeedFrame(kmh))
  }
  async function setSpeed(kmh: number) {
    kmh = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(kmh / SPEED_STEP) * SPEED_STEP))
    state.targetSpeed = Math.round(kmh * 10) / 10
    lastEnforce = performance.now()
    enforceUntil = performance.now() + 8000 // retry to reach the new target for ~8s
    dbg('SET', state.targetSpeed)
    await writeSpeed(state.targetSpeed)
  }

  function resetStats() {
    state.distance = 0
    state.steps = 0
    state.elapsed = 0
    state.history = []
  }

  return {
    state,
    connect,
    autoConnect,
    disconnect,
    forget,
    start,
    stop,
    pause,
    setSpeed,
    resetStats,
  }
}
