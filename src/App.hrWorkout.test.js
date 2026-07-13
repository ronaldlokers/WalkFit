// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

const fakeTm = reactive({
  supported: true,
  hasApi: true,
  connecting: false,
  connected: true,
  remembered: false,
  running: true,
  deviceName: 'Fake',
  speed: 3.0,
  targetSpeed: 3.0,
  distance: 0,
  elapsed: 0,
  error: '',
  history: [],
  log: [],
})
const fakeHr = reactive({
  supported: true,
  connecting: false,
  connected: true,
  remembered: false,
  deviceName: 'FakeHR',
  bpm: 0,
  history: [],
  error: '',
})
const setSpeedCalls = []

vi.mock('./treadmill.js', () => ({
  useTreadmill: () => ({
    state: fakeTm,
    connect: vi.fn(),
    autoConnect: vi.fn(),
    disconnect: vi.fn(),
    forget: vi.fn(),
    start: vi.fn(async () => {
      fakeTm.running = true
    }),
    stop: vi.fn(async () => {
      fakeTm.running = false
    }),
    setSpeed: vi.fn(async (kmh) => {
      const clamped = Math.min(6.0, Math.max(1.0, Math.round(kmh / 0.1) * 0.1))
      setSpeedCalls.push(clamped)
      fakeTm.targetSpeed = clamped
    }),
    resetStats: vi.fn(),
  }),
  SPEED_MIN: 1.0,
  SPEED_MAX: 6.0,
  SPEED_STEP: 0.1,
}))
vi.mock('./heartrate.js', () => ({
  useHeartRate: () => ({
    state: fakeHr,
    connect: vi.fn(),
    autoConnect: vi.fn(),
    disconnect: vi.fn(),
    forget: vi.fn(),
  }),
}))

beforeAll(() => {
  SVGElement.prototype.getTotalLength = () => 800
  SVGElement.prototype.getPointAtLength = () => ({ x: 0, y: 0 })
})
beforeEach(() => {
  localStorage.clear()
  fakeTm.distance = 0
  fakeTm.elapsed = 0
  fakeTm.running = true
  fakeTm.targetSpeed = 3.0
  fakeHr.bpm = 0
  setSpeedCalls.length = 0
})

async function toMain(w) {
  await w
    .findAll('button')
    .find((b) => b.text().includes('Skip') || b.text().includes('Next'))
    .trigger('click')
  await w
    .findAll('button')
    .find((b) => b.text().includes('Skip') || b.text().includes('Next'))
    .trigger('click')
  await w
    .findAll('button')
    .find((b) => b.text().includes('Free walk'))
    .trigger('click')
}

describe('HR workout', () => {
  it('nudges speed up when bpm is below the target zone, rate-limited to HR_ADJUST_INTERVAL', async () => {
    const App = (await import('./App.vue')).default
    const w = mount(App)
    await toMain(w)

    // open picker via the HR badge, start Cardio (zone 3)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))
      .trigger('click')

    fakeHr.bpm = 90 // well below a Cardio target (maxHr default 190 -> 70-80% = 133-152 bpm)

    // advance elapsed in small steps, well past one adjust interval (20s)
    for (let e = 0; e <= 25; e += 1) {
      fakeTm.elapsed = e
      await w.vm.$nextTick()
    }

    expect(setSpeedCalls.length).toBe(1) // exactly one nudge in 25s at a 20s cadence
    expect(setSpeedCalls[0]).toBeGreaterThan(3.0) // nudged UP since bpm was too low

    // advance another 25s with still-low bpm -> exactly one more nudge, still rate-limited
    for (let e = 25; e <= 50; e += 1) {
      fakeTm.elapsed = e
      await w.vm.$nextTick()
    }
    expect(setSpeedCalls.length).toBe(2)
  })

  it('nudges speed down when bpm is above the target zone', async () => {
    const App = (await import('./App.vue')).default
    const w = mount(App)
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))
      .trigger('click')

    fakeHr.bpm = 180 // well above Cardio's ~133-152 bpm target
    for (let e = 0; e <= 25; e += 1) {
      fakeTm.elapsed = e
      await w.vm.$nextTick()
    }
    expect(setSpeedCalls.length).toBe(1)
    expect(setSpeedCalls[0]).toBeLessThan(3.0)
  })

  it('does not nudge while the belt is not running (respects countdown/enforcement)', async () => {
    const App = (await import('./App.vue')).default
    const w = mount(App)
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))
      .trigger('click')

    fakeTm.running = false // still in the belt's start countdown
    fakeHr.bpm = 90
    for (let e = 0; e <= 30; e += 1) {
      fakeTm.elapsed = e
      await w.vm.$nextTick()
    }
    expect(setSpeedCalls.length).toBe(0)
  })

  it('ends the autopilot when heart rate disconnects', async () => {
    const App = (await import('./App.vue')).default
    const w = mount(App)
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Fat burn'))
      .trigger('click')
    expect(w.find('.train-banner').exists()).toBe(true)

    fakeHr.connected = false
    await w.vm.$nextTick()
    expect(w.find('.train-banner').exists()).toBe(false)
    fakeHr.connected = true // reset for other tests sharing the mocked reactive object
  })

  it('offers a Light target at 90–113 bpm (default 190 max HR)', async () => {
    const App = (await import('./App.vue')).default
    const w = mount(App)
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))
      .trigger('click')
    const light = w.findAll('.hr-zone-opt').find((b) => b.text().includes('Light'))
    expect(light.text()).toContain('90')
    expect(light.text()).toContain('113')
  })

  it('the header Workout button opens the weight-loss tab, not the HR tab', async () => {
    const App = (await import('./App.vue')).default
    const w = mount(App)
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.text() === 'Workout')
      .trigger('click')
    expect(w.find('.tlist').exists()).toBe(true)
    expect(w.find('.hr-workout-pane').exists()).toBe(false)
  })
})
