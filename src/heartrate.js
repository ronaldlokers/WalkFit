import { reactive } from 'vue'
import { parseHeartRate } from './protocol.js'

// Standard Bluetooth Heart Rate Service (works with Garmin "Broadcast Heart Rate",
// chest straps, etc.) — separate GATT device from the treadmill.
const HR_SERVICE = 0x180d
const HR_MEASUREMENT = 0x2a37

export function useHeartRate() {
  const state = reactive({
    supported: 'bluetooth' in navigator && window.isSecureContext,
    connecting: false,
    connected: false,
    remembered: !!localStorage.getItem('walkfit.hr.id'),
    deviceName: '',
    bpm: 0,
    history: [], // recent bpm samples for the sparkline
    error: '',
  })
  const MAX_SAMPLES = 120

  let device = null
  let char = null

  function onMeasurement(event) {
    const dv = event.target.value
    state.bpm = parseHeartRate(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
    if (state.bpm > 0) {
      state.history.push(state.bpm)
      if (state.history.length > MAX_SAMPLES) state.history.shift()
    }
  }

  async function attach(dev) {
    device = dev
    device.addEventListener('gattserverdisconnected', onDisconnected)
    state.history = []
    const gatt = await device.gatt.connect()
    const svc = await gatt.getPrimaryService(HR_SERVICE)
    char = await svc.getCharacteristic(HR_MEASUREMENT)
    await char.startNotifications()
    char.addEventListener('characteristicvaluechanged', onMeasurement)
    state.deviceName = device.name || 'Heart rate'
    state.connected = true
    state.remembered = true
    localStorage.setItem('walkfit.hr.id', device.id)
  }

  async function connect() {
    if (!state.supported) {
      state.error = 'Web Bluetooth unavailable here.'
      return
    }
    state.error = ''
    state.connecting = true
    try {
      const dev = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE] }],
        optionalServices: [HR_SERVICE],
      })
      await attach(dev)
    } catch (e) {
      state.error = e.message || String(e)
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
    state.connecting = true
    try {
      await Promise.race([
        attach(dev),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ])
    } catch {
      /* not broadcasting / off */
    } finally {
      state.connecting = false
    }
  }

  function onDisconnected() {
    state.connected = false
    state.bpm = 0
  }
  function disconnect() {
    try {
      if (device?.gatt?.connected) device.gatt.disconnect()
    } catch {}
    onDisconnected()
  }

  async function forget() {
    const id = localStorage.getItem('walkfit.hr.id')
    try {
      let d = device
      if (!d && navigator.bluetooth.getDevices)
        d = (await navigator.bluetooth.getDevices()).find((x) => x.id === id)
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
