// @vitest-environment jsdom
// Session accounting regressions (#55): walks must log their OWN deltas — not the
// cumulative counters — across consecutive starts, workout switches, and the belt's
// deceleration bounce after Stop.
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
  running: false,
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
  connected: false,
  remembered: false,
  deviceName: '',
  bpm: 0,
  history: [],
  error: '',
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
    setSpeed: vi.fn(),
    // functional reset, like the real composable — the watermark logic depends on it
    resetStats: vi.fn(() => {
      fakeTm.distance = 0
      fakeTm.elapsed = 0
      fakeTm.steps = 0
    }),
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

type SvgGeometryStub = { getTotalLength(): number; getPointAtLength(d: number): DOMPoint }
beforeAll(() => {
  const proto = SVGElement.prototype as unknown as SvgGeometryStub
  proto.getTotalLength = () => 800
  proto.getPointAtLength = () => ({ x: 0, y: 0 }) as DOMPoint
})
beforeEach(() => {
  localStorage.clear()
  fakeTm.running = false
  fakeTm.distance = 0
  fakeTm.elapsed = 0
  fakeTm.steps = 0
})

async function clickButton(w: VueWrapper, label: string) {
  const btn = w.findAll('button').find((b) => b.text().includes(label))
  if (!btn) throw new Error(`no button matching "${label}"`)
  await btn.trigger('click')
}

// unmount between tests — a lingering instance keeps watching the shared fakeTm and
// would double-log every later test's sessions
let mounted: VueWrapper | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

async function mountToMain() {
  const App = (await import('./App.vue')).default
  const w = mount(App)
  mounted = w
  // connected devices show "Next" instead of "Skip" on the wizard steps
  for (let i = 0; i < 2; i++) {
    await w
      .findAll('button')
      .find((b) => b.text().includes('Skip') || b.text().includes('Next'))!
      .trigger('click')
  }
  await clickButton(w, 'Free walk')
  return w
}

function logged(): { distance: number; duration: number; steps?: number }[] {
  return JSON.parse(localStorage.getItem('walkfit.history') || '[]')
}

async function walk(w: VueWrapper, metres: number, seconds: number, steps = 0) {
  fakeTm.distance += metres
  fakeTm.elapsed += seconds
  fakeTm.steps += steps
  await w.vm.$nextTick()
}

describe('session accounting (#55)', () => {
  it('consecutive walks log their own distance, not the cumulative counter', async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start') // startWalk resets counters
    await walk(w, 1000, 600, 1200)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([1000])

    await clickButton(w, 'Start') // no manual Reset in between
    await walk(w, 500, 300, 600)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([1000, 500])
    expect(logged()[1]!.duration).toBe(300)
    expect(logged()[1]!.steps).toBe(600)
  })

  it("the belt's deceleration bounce after Stop does not log a second session", async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 1000, 600)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    // belt coasts: telemetry flips running back on for a few metres, then staleness stops it
    fakeTm.running = true
    await walk(w, 6, 4)
    fakeTm.running = false
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([1000]) // one session, not two
  })

  it('starting a workout mid-walk logs the in-progress free walk instead of wiping it', async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 2000, 1200)
    // open the workout menu and start a preset while the belt is running
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    await w.findAll('.tcard')[0]!.trigger('click')
    await clickButton(w, 'Start workout')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([2000]) // prior walk preserved
    // the workout session then accrues from zero
    await walk(w, 800, 500)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([2000, 800])
  })

  it('Reset mid-walk rebases instead of undercounting the rest of the session', async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 400, 240)
    await clickButton(w, 'Reset') // zeroes the counters mid-session
    fakeTm.distance = 0
    fakeTm.elapsed = 0
    await w.vm.$nextTick()
    await walk(w, 300, 180)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([300]) // post-reset delta, not negative/lost
  })
})

describe('session resilience (#66)', () => {
  it('walking persists an in-progress snapshot roughly every 10 m', async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 250, 150, 300)
    const snap = JSON.parse(localStorage.getItem('walkfit.session.inprogress')!)
    expect(snap.distance).toBeGreaterThanOrEqual(240)
    expect(snap.name).toBe('Free walk')
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(localStorage.getItem('walkfit.session.inprogress')).toBeNull() // cleared on finalize
  })

  it('a reload mid-walk resumes the session and logs combined totals', async () => {
    // simulate the previous page's snapshot: 400 m walked before the reload
    localStorage.setItem(
      'walkfit.session.inprogress',
      JSON.stringify({
        date: '2026-07-14T07:00:00.000Z',
        name: 'Free walk',
        distance: 400,
        elapsed: 240,
        kcal: 20,
        steps: 500,
        hrSum: 0,
        hrCount: 0,
        hrLo: 0,
        hrHi: 0,
      }),
    )
    const w = await mountToMain()
    // belt reconnects still running; counters restart from zero on our side
    fakeTm.running = true
    await w.vm.$nextTick()
    await walk(w, 100, 60, 120)
    fakeTm.running = false
    await w.vm.$nextTick()
    const log = logged()
    expect(log).toHaveLength(1)
    expect(log[0]!.distance).toBe(500) // 400 carried + 100 fresh
    expect(log[0]!.duration).toBe(300)
    expect(log[0]!.steps).toBe(620)
    expect(JSON.parse(localStorage.getItem('walkfit.history')!)[0].date).toBe(
      '2026-07-14T07:00:00.000Z', // the original start survives the reload
    )
  })

  it('a snapshot whose belt never resumes is logged on the next Start', async () => {
    localStorage.setItem(
      'walkfit.session.inprogress',
      JSON.stringify({
        date: '2026-07-14T07:00:00.000Z',
        name: 'Free walk',
        distance: 800,
        elapsed: 480,
        kcal: 40,
        steps: 900,
        hrSum: 0,
        hrCount: 0,
        hrLo: 0,
        hrHi: 0,
      }),
    )
    const w = await mountToMain()
    await clickButton(w, 'Start') // fresh walk: the orphaned session gets closed out first
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([800])
    await walk(w, 100, 60)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([800, 100])
  })

  it('pause + resume keeps one session; Stop from paused finalizes it', async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 500, 300, 600)
    await clickButton(w, 'Pause')
    await w.vm.$nextTick()
    expect(logged()).toHaveLength(0) // paused, not finished
    expect(w.text()).toContain('Resume')
    await clickButton(w, 'Resume')
    await walk(w, 200, 120, 240)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([700])
    expect(logged()[0]!.duration).toBe(420)
  })

  it('Stop while paused logs the banked progress', async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 300, 180)
    await clickButton(w, 'Pause')
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([300])
  })
})
