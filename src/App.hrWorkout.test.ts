// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import type { TreadmillState } from './treadmill'
import type { HeartRateState } from './heartrate'

const fakeTm = reactive<TreadmillState>({
  secure: true,
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
  steps: 0,
  beltDistance: 0,
  beltKcal: 0,
  beltTime: 0,
  elapsed: 0,
  error: '',
  history: [],
  log: [],
})
const fakeHr = reactive<HeartRateState>({
  supported: true,
  connecting: false,
  connected: true,
  remembered: false,
  deviceName: 'FakeHR',
  bpm: 0,
  history: [],
  error: '',
})
const setSpeedCalls: number[] = []

// unmount between tests — a lingering instance keeps watching the shared fakeTm/fakeHr
// and would double-count nudges once steering rebases on elapsed resets (#55)
let mounted: VueWrapper | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

vi.mock('./treadmill', () => ({
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
    pause: vi.fn(async () => {
      fakeTm.running = false
    }),
    setSpeed: vi.fn(async (kmh: number) => {
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
vi.mock('./heartrate', () => ({
  useHeartRate: () => ({
    state: fakeHr,
    connect: vi.fn(),
    autoConnect: vi.fn(),
    disconnect: vi.fn(),
    forget: vi.fn(),
  }),
}))

// These tests drive a full App mount through dozens of elapsed-tick nextTicks; under
// a loaded parallel run they can exceed vitest's 5 s default. Generous, not a wait.
vi.setConfig({ testTimeout: 20000 })

type SvgGeometryStub = { getTotalLength(): number; getPointAtLength(d: number): DOMPoint }
beforeAll(() => {
  const proto = SVGElement.prototype as unknown as SvgGeometryStub
  proto.getTotalLength = () => 800
  proto.getPointAtLength = () => ({ x: 0, y: 0 }) as DOMPoint
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

async function toMain(w: VueWrapper) {
  await w
    .findAll('button')
    .find((b) => b.text().includes('Skip') || b.text().includes('Next'))!
    .trigger('click')
  await w
    .findAll('button')
    .find((b) => b.text().includes('Skip') || b.text().includes('Next'))!
    .trigger('click')
  await w
    .findAll('button')
    .find((b) => b.text().includes('Free walk'))!
    .trigger('click')
}

describe('HR workout', () => {
  it('nudges speed up when bpm is below the target zone, rate-limited to HR_ADJUST_INTERVAL', async () => {
    const App = (await import('./App.vue')).default
    const w = (mounted = mount(App))
    await toMain(w)

    // open picker via the HR badge, start Cardio (zone 3)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))!
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))!
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

  it('keeps nudging after a mid-workout stats reset (#55)', async () => {
    const App = (await import('./App.vue')).default
    const w = (mounted = mount(App))
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))!
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))!
      .trigger('click')
    fakeHr.bpm = 90
    for (let e = 0; e <= 25; e += 1) {
      fakeTm.elapsed = e
      await w.vm.$nextTick()
    }
    expect(setSpeedCalls.length).toBe(1)
    // Reset button zeroes elapsed mid-workout — steering must rebase, not stall until
    // elapsed re-exceeds the pre-reset value
    fakeTm.elapsed = 0
    await w.vm.$nextTick()
    for (let e = 0; e <= 21; e += 1) {
      fakeTm.elapsed = e
      await w.vm.$nextTick()
    }
    expect(setSpeedCalls.length).toBe(2)
  })

  it('nudges speed down when bpm is above the target zone', async () => {
    const App = (await import('./App.vue')).default
    const w = (mounted = mount(App))
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))!
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))!
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
    const w = (mounted = mount(App))
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))!
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))!
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
    const w = (mounted = mount(App))
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))!
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Fat burn'))!
      .trigger('click')
    expect(w.find('.workout-banner').exists()).toBe(true)

    fakeHr.connected = false
    await w.vm.$nextTick()
    expect(w.find('.workout-banner').exists()).toBe(false)
    fakeHr.connected = true // reset for other tests sharing the mocked reactive object
  })

  it('HR targets are disabled without a sensor, with an explanatory hint (#63)', async () => {
    const App = (await import('./App.vue')).default
    const w = (mounted = mount(App))
    await toMain(w)
    fakeHr.connected = false
    // reach the HR tab via the header workout menu (no HR badge without a sensor)
    await w
      .findAll('button')
      .find((b) => b.text() === '☰')!
      .trigger('click')
    await w
      .findAll('button')
      .find((b) => b.text().includes('Workout'))!
      .trigger('click')
    await w
      .findAll('.workout-tab')
      .find((b) => b.text().includes('Heart rate'))!
      .trigger('click')
    for (const opt of w.findAll('.hr-zone-opt')) {
      expect(opt.attributes('disabled')).toBeDefined()
    }
    expect(w.text()).toContain('Connect a heart-rate sensor first')
    fakeHr.connected = true // restore for other tests sharing the mock
  })

  it('offers a Light target at 90–113 bpm (default 190 max HR)', async () => {
    const App = (await import('./App.vue')).default
    const w = (mounted = mount(App))
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))!
      .trigger('click')
    const light = w.findAll('.hr-zone-opt').find((b) => b.text().includes('Light'))!
    expect(light.text()).toContain('90')
    expect(light.text()).toContain('113')
  })

  it('the HR badge shows the live zone, fat-burn highlighted (#17)', async () => {
    const App = (await import('./App.vue')).default
    const w = mount(App)
    mounted = w
    await toMain(w)
    // default maxHr 190: 125 bpm = 65.8% -> Z2 Fat burn
    fakeHr.bpm = 125
    await w.vm.$nextTick()
    const tag = w.find('.hr-zone-tag')
    expect(tag.text()).toBe('Z2 Fat burn')
    expect(tag.classes()).toContain('fatburn')
    // 160 bpm = 84.2% -> Z4 Hard, no fat-burn highlight
    fakeHr.bpm = 160
    await w.vm.$nextTick()
    expect(w.find('.hr-zone-tag').text()).toBe('Z4 Hard')
    expect(w.find('.hr-zone-tag').classes()).not.toContain('fatburn')
    // no reading -> no tag
    fakeHr.bpm = 0
    await w.vm.$nextTick()
    expect(w.find('.hr-zone-tag').exists()).toBe(false)
  })

  it('locale switch mid-workout keeps the picker highlight and re-renders the name (#130)', async () => {
    const { locale } = await import('./i18n')
    const App = (await import('./App.vue')).default
    const w = mount(App)
    mounted = w
    await toMain(w)
    // start a Cardio HR workout via the badge
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tap for HR workout'))!
      .trigger('click')
    await w
      .findAll('.hr-zone-opt')
      .find((b) => b.text().includes('Cardio'))!
      .trigger('click')
    expect(w.find('.imm-workout').text()).toContain('Cardio')

    locale.value = 'nl'
    await w.vm.$nextTick()
    // ribbon shows the NL name (live lookup by id, not the pick-time object)
    expect(w.find('.imm-workout').text()).toContain('Cardio') // same word in NL
    // reopen the picker: the active target still highlights (id match, not identity)
    await w
      .findAll('button')
      .find((b) => b.attributes('title')?.includes('tik om te wijzigen'))!
      .trigger('click')
    const on = w.findAll('.hr-zone-opt').filter((b) => b.classes().includes('on'))
    expect(on).toHaveLength(1)
    locale.value = 'en'
  })

  it('the header Workout menu item opens the weight-loss tab, not the HR tab', async () => {
    const App = (await import('./App.vue')).default
    const w = (mounted = mount(App))
    await toMain(w)
    await w
      .findAll('button')
      .find((b) => b.text() === '☰')!
      .trigger('click')
    await w
      .findAll('button')
      .find((b) => b.text().includes('Workout'))!
      .trigger('click')
    expect(w.find('.tlist').exists()).toBe(true)
    expect(w.find('.hr-workout-pane').exists()).toBe(false)
  })
})
