// @vitest-environment jsdom
// BLE connection lifecycle (#56): attach cleanup on failure, orphaned-attach
// invalidation, stale-characteristic nulling, reentrancy, chooser-cancel handling.
// Uses stubbed GATT objects — no real Bluetooth.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTreadmill } from './treadmill'

type Listener = (ev: Event) => void

function fakeDevice(id = 'dev1') {
  const listeners = new Map<string, Set<Listener>>()
  const char = {
    writeValueWithResponse: vi.fn(async () => {}),
    writeValueWithoutResponse: vi.fn(async () => {}),
    startNotifications: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    value: undefined,
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
  return { dev: dev as unknown as BluetoothDevice, gatt, svc, char, dispatch, listeners }
}

function stubBluetooth(impl: Partial<Bluetooth>) {
  Object.defineProperty(navigator, 'bluetooth', { value: impl, configurable: true })
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
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
