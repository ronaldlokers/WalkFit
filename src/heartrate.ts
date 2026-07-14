import { reactive } from 'vue'
import { isDemo, demoHeartRate } from './demo'
import { parseHeartRate } from './protocol'

// Standard Bluetooth Heart Rate Service (works with Garmin "Broadcast Heart Rate",
// chest straps, etc.) — separate GATT device from the treadmill.
// 128-bit UUID strings, not 0x… aliases — see treadmill.ts (Bluefy compat)
// Sentinel error string, translated at render (#140) — see treadmill.ts.
export const NO_WEBBT_HR_ERROR = 'Web Bluetooth unavailable here.'

const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb'
const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb'

export interface HeartRateState {
  supported: boolean
  connecting: boolean
  connected: boolean
  remembered: boolean
  deviceName: string
  bpm: number
  history: number[] // recent bpm samples for the sparkline
  error: string
}

export function useHeartRate() {
  // Demo mode (#169): simulated strap behind the same interface — explicit opt-in only.
  if (isDemo()) return demoHeartRate()
  return realHeartRate()
}

function realHeartRate() {
  const state = reactive<HeartRateState>({
    supported: 'bluetooth' in navigator && window.isSecureContext,
    connecting: false,
    connected: false,
    remembered: !!localStorage.getItem('walkfit.hr.id'),
    deviceName: '',
    bpm: 0,
    history: [],
    error: '',
  })
  const MAX_SAMPLES = 120

  let device: BluetoothDevice | null = null
  let char: BluetoothRemoteGATTCharacteristic | null = null

  function onMeasurement(event: Event) {
    const dv = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!dv) return
    state.bpm = parseHeartRate(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
    if (state.bpm > 0) {
      state.history.push(state.bpm)
      if (state.history.length > MAX_SAMPLES) state.history.shift()
    }
  }

  // Same lifecycle discipline as treadmill.ts (#56): generation counter invalidates
  // orphaned attach attempts; state/listeners commit only after everything resolved.
  let attachGen = 0

  function detach() {
    if (char) char.removeEventListener('characteristicvaluechanged', onMeasurement)
    if (device) device.removeEventListener('gattserverdisconnected', onDisconnected)
    char = null
    device = null
  }

  async function attach(dev: BluetoothDevice) {
    const gen = ++attachGen
    try {
      const gatt = await dev.gatt!.connect()
      const svc = await gatt.getPrimaryService(HR_SERVICE)
      const c = await svc.getCharacteristic(HR_MEASUREMENT)
      await c.startNotifications()
      if (gen !== attachGen) {
        // superseded while connecting — release the link instead of hijacking state
        try {
          dev.gatt?.disconnect()
        } catch {}
        return
      }
      detach()
      device = dev
      char = c
      dev.addEventListener('gattserverdisconnected', onDisconnected)
      c.addEventListener('characteristicvaluechanged', onMeasurement)
      state.history = []
      state.deviceName = dev.name || 'Heart rate'
      state.connected = true
      state.remembered = true
      localStorage.setItem('walkfit.hr.id', dev.id)
    } catch (e) {
      try {
        dev.gatt?.disconnect()
      } catch {}
      throw e
    }
  }

  async function connect() {
    if (!state.supported) {
      state.error = NO_WEBBT_HR_ERROR
      return
    }
    if (state.connecting) return // reentrancy guard
    state.error = ''
    state.connecting = true
    try {
      const dev = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE] }],
        optionalServices: [HR_SERVICE],
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

  // Silent reconnect on load to a previously-granted HR sensor (times out if not broadcasting).
  async function autoConnect() {
    if (!state.supported || !navigator.bluetooth.getDevices) return
    const id = localStorage.getItem('walkfit.hr.id')
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
      // not broadcasting / off — invalidate the still-running attach so it can't
      // finish late and hijack state (#56)
      attachGen++
    } finally {
      state.connecting = false
    }
  }

  function onDisconnected() {
    detach()
    state.connected = false
    state.bpm = 0
  }
  function disconnect() {
    attachGen++ // user intent: also invalidate any in-flight attach
    try {
      if (device?.gatt?.connected) device.gatt.disconnect()
    } catch {}
    onDisconnected()
  }

  async function forget() {
    attachGen++ // user intent: also invalidate any in-flight attach
    const id = localStorage.getItem('walkfit.hr.id')
    try {
      let d = device
      if (!d && navigator.bluetooth.getDevices)
        d = (await navigator.bluetooth.getDevices()).find((x) => x.id === id) ?? null
      if (d?.gatt?.connected) d.gatt.disconnect()
      if (d?.forget) await d.forget()
    } catch {}
    localStorage.removeItem('walkfit.hr.id')
    state.remembered = false
    state.deviceName = ''
    onDisconnected()
  }

  return { state, connect, autoConnect, disconnect, forget }
}
