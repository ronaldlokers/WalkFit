// @vitest-environment jsdom
// BLE connection lifecycle (#56): attach cleanup on failure, orphaned-attach
// invalidation, stale-characteristic nulling, reentrancy, chooser-cancel handling.
// Uses stubbed GATT objects — no real Bluetooth.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTreadmill } from './treadmill'

type Listener = (ev: Event) => void

function fakeDevice(id = 'dev1') {
  const listeners = new Map<string, Set<Listener>>()
  const charListeners = new Set<Listener>()
  const char = {
    writeValueWithResponse: vi.fn(async () => {}),
    writeValueWithoutResponse: vi.fn<(data: BufferSource) => Promise<void>>(async () => {}),
    startNotifications: vi.fn(async () => {}),
    addEventListener: vi.fn((_t: string, f: Listener) => charListeners.add(f)),
    removeEventListener: vi.fn((_t: string, f: Listener) => charListeners.delete(f)),
    value: undefined as DataView | undefined,
  }
  // deliver a raw fff1 frame to the subscribed telemetry handler
  function emitFrame(bytes: number[]) {
    const buf = Uint8Array.from(bytes)
    char.value = new DataView(buf.buffer)
    for (const f of [...charListeners]) f({ target: char } as unknown as Event)
  }
  const svc = { getCharacteristic: vi.fn(async () => char) }
  const gatt = {
    connected: false,
    connect: vi.fn(async () => {
      gatt.connected = true
      return gatt
    }),
    disconnect: vi.fn(() => {
      gatt.connected = false
      dispatch('gattserverdisconnected')
    }),
    getPrimaryService: vi.fn(async () => svc),
  }
  const dev = {
    id,
    name: 'Fake belt',
    gatt,
    forget: vi.fn(async () => {}),
    addEventListener: (t: string, f: Listener) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(f)
    },
    removeEventListener: (t: string, f: Listener) => listeners.get(t)?.delete(f),
  }
  function dispatch(type: string) {
    for (const f of [...(listeners.get(type) ?? [])]) f(new Event(type))
  }
  return { dev: dev as unknown as BluetoothDevice, gatt, svc, char, dispatch, listeners, emitFrame }
}

function stubBluetooth(impl: Partial<Bluetooth>) {
  Object.defineProperty(navigator, 'bluetooth', { value: impl, configurable: true })
}

beforeEach(() => {
  localStorage.clear()
  // fake performance.now too — the ticker, staleness stop, and enforce window all read it
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  })
  // jsdom reports no secure context; the composable gates on it at construction
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('treadmill connection lifecycle (#56)', () => {
  it('connect wires up the device and marks state connected', async () => {
    const f = fakeDevice()
    stubBluetooth({ requestDevice: vi.fn(async () => f.dev) } as Partial<Bluetooth>)
    const tm = useTreadmill()
    await tm.connect()
    expect(tm.state.connected).toBe(true)
    expect(f.char.startNotifications).toHaveBeenCalled()
    expect(localStorage.getItem('walkfit.treadmill.id')).toBe('dev1')
    await tm.disconnect()
  })

  it('a failure mid-attach releases the GATT link and leaves no half-wired device', async () => {
    const f = fakeDevice()
    f.gatt.getPrimaryService.mockRejectedValueOnce(new Error('service missing'))
    stubBluetooth({ requestDevice: vi.fn(async () => f.dev) } as Partial<Bluetooth>)
    const tm = useTreadmill()
    await tm.connect()
    expect(tm.state.connected).toBe(false)
    expect(f.gatt.disconnect).toHaveBeenCalled() // link released for clean re-pairing
    expect(f.listeners.get('gattserverdisconnected')?.size ?? 0).toBe(0) // no leaked listener
    // a retry works
    await tm.connect()
    expect(tm.state.connected).toBe(true)
    await tm.disconnect()
  })

  it("an autoConnect that outlives its 8s timeout can't hijack state later", async () => {
    const f = fakeDevice()
    let releaseConnect: (g: typeof f.gatt) => void
    f.gatt.connect.mockImplementationOnce(
      () =>
        new Promise((res) => {
          releaseConnect = res as never
        }),
    )
    localStorage.setItem('walkfit.treadmill.id', 'dev1')
    stubBluetooth({ getDevices: vi.fn(async () => [f.dev]) } as Partial<Bluetooth>)
    const tm = useTreadmill()
    const p = tm.autoConnect()
    await vi.advanceTimersByTimeAsync(8001) // timeout fires, autoConnect gives up
    await p
    expect(tm.state.connecting).toBe(false)
    // the slow device finally responds — the orphaned attach must not commit
    releaseConnect!(f.gatt)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(tm.state.connected).toBe(false)
    expect(f.gatt.disconnect).toHaveBeenCalled() // orphan released its link
  })

  it('start() after a device power-off is a no-op instead of an unhandled rejection', async () => {
    const f = fakeDevice()
    stubBluetooth({ requestDevice: vi.fn(async () => f.dev) } as Partial<Bluetooth>)
    const tm = useTreadmill()
    await tm.connect()
    f.dispatch('gattserverdisconnected') // belt powered off
    expect(tm.state.connected).toBe(false)
    f.char.writeValueWithResponse.mockClear()
    await tm.start() // must hit the null-characteristic guard, not write to a dead char
    expect(f.char.writeValueWithResponse).not.toHaveBeenCalled()
  })

  it('cancelling the chooser does not surface an error banner', async () => {
    const cancel = new DOMException('User cancelled', 'NotFoundError')
    stubBluetooth({
      requestDevice: vi.fn(async () => Promise.reject(cancel)),
    } as Partial<Bluetooth>)
    const tm = useTreadmill()
    await tm.connect()
    expect(tm.state.error).toBe('')
    expect(tm.state.connecting).toBe(false)
  })

  it('concurrent connect() calls collapse to one chooser', async () => {
    const f = fakeDevice()
    const requestDevice = vi.fn(async () => f.dev)
    stubBluetooth({ requestDevice } as Partial<Bluetooth>)
    const tm = useTreadmill()
    await Promise.all([tm.connect(), tm.connect()])
    expect(requestDevice).toHaveBeenCalledTimes(1)
    await tm.disconnect()
  })
})

// The hard-won timing behaviors (#61): 3s staleness stop, dt-based distance
// integration, and the bounded ~8s target-speed enforce window. Frames below are
// checksum-valid (parseTelemetry now verifies them).
describe('treadmill timing (#61)', () => {
  const SPEED_2_0 = [0x02, 0x53, 0x02, 0x14, 0x45, 0x03] // 2.0 km/h
  const SPEED_3_6 = [0x02, 0x53, 0x02, 0x24, 0x75, 0x03] // 3.6 km/h = 1 m/s

  async function connected() {
    const f = fakeDevice()
    stubBluetooth({ requestDevice: vi.fn(async () => f.dev) } as Partial<Bluetooth>)
    const tm = useTreadmill()
    await tm.connect()
    return { f, tm }
  }

  it('staleness: no speed frames for >3s stops the belt state', async () => {
    const { f, tm } = await connected()
    f.emitFrame(SPEED_2_0)
    expect(tm.state.running).toBe(true)
    expect(tm.state.speed).toBe(2.0)
    await vi.advanceTimersByTimeAsync(3400) // ticker checks every 250ms
    expect(tm.state.running).toBe(false)
    expect(tm.state.speed).toBe(0)
    await tm.disconnect()
  })

  it('integrates distance/elapsed from live speed over time', async () => {
    const { f, tm } = await connected()
    // keep frames fresher than the 3s staleness window while 4s pass
    for (let i = 0; i < 4; i++) {
      f.emitFrame(SPEED_3_6)
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(tm.state.distance).toBeCloseTo(4, 1) // 1 m/s x 4s
    expect(tm.state.elapsed).toBeCloseTo(4, 1)
    await tm.disconnect()
  })

  it('enforce window: re-sends the target for ~8s while unmatched, throttled, then stops', async () => {
    const { f, tm } = await connected()
    const setSpeedWrites = () =>
      f.char.writeValueWithoutResponse.mock.calls.filter((c) => {
        const b = c[0] as Uint8Array
        return b[1] === 0x53 && b[2] === 0x02
      }).length

    await tm.setSpeed(3.0)
    expect(setSpeedWrites()).toBe(1) // the immediate write
    // belt ignores it (start countdown): keeps reporting 2.0
    for (let i = 0; i < 12; i++) {
      f.emitFrame(SPEED_2_0)
      await vi.advanceTimersByTimeAsync(1000)
    }
    const during = setSpeedWrites()
    // ~8s window at >=900ms throttle: the initial write plus roughly 8 retries
    expect(during).toBeGreaterThanOrEqual(6)
    expect(during).toBeLessThanOrEqual(11)
    // window closed: no further enforce writes however long we wait
    for (let i = 0; i < 5; i++) {
      f.emitFrame(SPEED_2_0)
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(setSpeedWrites()).toBe(during)
    await tm.disconnect()
  })

  it('enforce stops immediately once the belt matches the target', async () => {
    const { f, tm } = await connected()
    const setSpeedWrites = () =>
      f.char.writeValueWithoutResponse.mock.calls.filter((c) => {
        const b = c[0] as Uint8Array
        return b[1] === 0x53 && b[2] === 0x02
      }).length

    await tm.setSpeed(2.0)
    f.emitFrame(SPEED_2_0) // belt reaches the target right away
    await vi.advanceTimersByTimeAsync(3000)
    expect(setSpeedWrites()).toBe(1) // no retries after the match
    await tm.disconnect()
  })
})
