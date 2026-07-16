// @vitest-environment jsdom
// Session accounting regressions (#55): walks must log their OWN deltas — not the
// cumulative counters — across consecutive starts, workout switches, and the belt's
// deceleration bounce after Stop.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import type { TreadmillState } from './treadmill'
import type { HeartRateState } from './heartrate'

// Full-App mounts under a loaded parallel run can exceed vitest's 5 s default —
// generous ceiling, not a wait (same rationale as App.hrWorkout.test.ts).
vi.setConfig({ testTimeout: 20000 })

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
const fakeStrava = reactive({
  supported: true,
  connected: false,
  athleteName: '',
  connecting: false,
  uploading: false,
  error: '',
})
const uploadSession = vi.fn<(session: unknown, name: string) => Promise<object>>(async () => ({}))
vi.mock('./strava', () => ({
  useStrava: () => ({
    state: fakeStrava,
    connect: vi.fn(),
    disconnect: vi.fn(),
    handleRedirect: async () => false,
    uploadSession,
  }),
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
  fakeStrava.connected = false
  uploadSession.mockClear()
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

function logged(): { distance: number; duration: number; steps?: number; workout?: string }[] {
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

  it("the belt's deceleration bounce after Pause keeps the walk paused (#128)", async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 500, 300, 600)
    await clickButton(w, 'Pause')
    await w.vm.$nextTick()
    // belt coasts: telemetry flips running back on for a few metres, then the
    // staleness timeout drops it again — this must NOT finalize the paused session
    fakeTm.running = true
    await w.vm.$nextTick() // running edge lands first (like real telemetry), then coast
    await walk(w, 6, 4)
    fakeTm.running = false
    await w.vm.$nextTick()
    expect(logged()).toHaveLength(0) // still paused, nothing logged
    expect(w.text()).toContain('Resume') // Start still offers Resume
    // resuming continues the same session, coast metres included
    await clickButton(w, 'Resume')
    await walk(w, 200, 120, 240)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([706])
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

describe('workouts & goals (#68)', () => {
  it('a paused plan resumes as the same session and the workout stays active', async () => {
    const w = await mountToMain()
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    await w.findAll('.tcard')[0]!.trigger('click')
    await clickButton(w, 'Start workout')
    await walk(w, 600, 360)
    await clickButton(w, 'Pause')
    await w.vm.$nextTick()
    expect(logged()).toHaveLength(0)
    expect(w.find('.workout-banner').exists()).toBe(true) // plan not cancelled by pause
    await clickButton(w, 'Resume')
    await walk(w, 400, 240)
    // the banner's own stop control ends the plan and finalizes one combined session
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().map((s) => s.distance)).toEqual([1000])
  })

  it('stores the plan name on the session, but not for a free walk (#142)', async () => {
    const w = await mountToMain()
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    const card = w.findAll('.tcard')[0]!
    const planName = card.find('.tname').text()
    await card.trigger('click')
    await clickButton(w, 'Start workout')
    await walk(w, 100, 60)
    await clickButton(w, 'End')
    await w.vm.$nextTick()
    expect(logged().at(-1)!.workout).toBe(planName)

    // a plain free walk stores no workout name
    await clickButton(w, 'Start')
    await walk(w, 100, 60)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(logged().at(-1)!.workout).toBeUndefined()
  })

  it('offers to repeat the last-finished plan from the picker (#142)', async () => {
    const w = await mountToMain()
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    expect(w.find('.repeat-chip').exists()).toBe(false) // nothing finished yet

    const card = w.findAll('.tcard')[0]!
    const planName = card.find('.tname').text()
    await card.trigger('click')
    await clickButton(w, 'Start workout')
    await walk(w, 100, 60)
    await clickButton(w, 'End')
    await w.vm.$nextTick()

    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    const chip = w.find('.repeat-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain(planName)
    // clicking it previews the same plan, ready to start again
    await chip.trigger('click')
    expect(w.find('.wp-head h2').text()).toBe(planName)
  })

  it('building a custom workout persists it and it can be started', async () => {
    const w = await mountToMain()
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    await clickButton(w, '+ New workout')
    await w.find('.builder-name').setValue('Lunch loop')
    const inputs = w.findAll('.builder-seg input')
    await inputs[0]!.setValue(4.5)
    await inputs[1]!.setValue(15)
    await clickButton(w, 'Save workout')
    const stored = JSON.parse(localStorage.getItem('walkfit.workouts.custom')!)
    expect(stored).toHaveLength(1)
    expect(stored[0].name).toBe('Lunch loop')
    expect(stored[0].segments).toEqual([{ speed: 4.5, minutes: 15 }])
    // the new card is in the list and startable
    const card = w.findAll('.tcard').find((c) => c.text().includes('Lunch loop'))!
    await card.trigger('click')
    await clickButton(w, 'Start workout')
    expect(w.find('.workout-banner').text()).toContain('Lunch loop')
  })

  it('deleting a custom workout removes it from storage', async () => {
    localStorage.setItem(
      'walkfit.workouts.custom',
      JSON.stringify([
        { id: 'custom-1', name: 'Old plan', focus: '', segments: [{ speed: 3, minutes: 10 }] },
      ]),
    )
    const w = await mountToMain()
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    await w
      .findAll('.tcard')
      .find((c) => c.text().includes('Old plan'))!
      .trigger('click')
    await clickButton(w, 'Delete')
    expect(JSON.parse(localStorage.getItem('walkfit.workouts.custom')!)).toHaveLength(0)
    expect(w.findAll('.tcard').some((c) => c.text().includes('Old plan'))).toBe(false)
  })

  it('a distance goal tracks progress and marks reached (#68)', async () => {
    const w = await mountToMain()
    await w
      .findAll('.goal-chip')
      .find((c) => c.text() === '1 km')!
      .trigger('click')
    await clickButton(w, 'Start')
    await walk(w, 600, 360)
    expect(w.find('.goal-pct').text()).toBe('60%')
    await walk(w, 450, 270)
    expect(w.find('.goal-pct').text()).toBe('✓ reached')
    await clickButton(w, 'Stop')
  })
})

describe('per-km/N-min voice announcements (#144)', () => {
  const spoken: string[] = []
  beforeEach(() => {
    spoken.length = 0
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string
        lang = ''
        rate = 1
        constructor(text: string) {
          this.text = text
        }
      },
    )
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(),
      speak: (u: { text: string }) => spoken.push(u.text),
    })
  })

  async function setAnnounce(w: VueWrapper, value: string) {
    await clickButton(w, '☰')
    await clickButton(w, 'Settings')
    const select = w
      .findAll('select')
      .find((s) => s.findAll('option').some((o) => o.attributes('value') === '1km'))!
    await select.setValue(value)
    await w.findAll('.x').at(-1)!.trigger('click') // close Settings
  }

  it('speaks at each distance threshold during a free walk, off by default', async () => {
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 1000, 300)
    expect(spoken).toHaveLength(0) // off by default — no announcement yet
    await clickButton(w, 'Stop')

    await setAnnounce(w, '1km')
    await clickButton(w, 'Start')
    await walk(w, 999, 300)
    expect(spoken).toHaveLength(0) // just under the 1 km threshold
    await walk(w, 2, 5)
    expect(spoken).toHaveLength(1)
    await walk(w, 999, 300)
    expect(spoken).toHaveLength(2)
  })

  it('does not announce during a weight-loss plan', async () => {
    const w = await mountToMain()
    await setAnnounce(w, '1km')
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    await w.find('.tcard').trigger('click')
    await clickButton(w, 'Start workout')
    await walk(w, 1200, 600)
    // the plan speaks its own segment-speed cues (unrelated) — just the per-km
    // announcement (its distinctive "pace" phrase) must stay silent
    expect(spoken.some((s) => s.includes('pace'))).toBe(false)
  })
})

describe('live daily-goal ring + cue (#145)', () => {
  const spoken: string[] = []
  beforeEach(() => {
    spoken.length = 0
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string
        lang = ''
        rate = 1
        constructor(text: string) {
          this.text = text
        }
      },
    )
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(),
      speak: (u: { text: string }) => spoken.push(u.text),
    })
  })

  it('ring reflects live progress and speaks once when a goal is reached mid-walk', async () => {
    const w = await mountToMain()
    expect(w.find('.goal-ring-val').text()).toBe('0%')

    await clickButton(w, 'Start')
    await walk(w, 100, 60, 8000) // default steps goal is 8000 — hit in one tick
    await w.vm.$nextTick()
    expect(spoken.some((s) => s.includes('Steps'))).toBe(true)
    const announcedOnce = spoken.length

    // staying over the goal must not re-announce it
    await walk(w, 100, 60, 1)
    expect(spoken.length).toBe(announcedOnce)
  })
})

describe('avgHr sampling (#132)', () => {
  it('averages over time, not over value changes', async () => {
    fakeHr.connected = true
    const w = await mountToMain()
    await clickButton(w, 'Start')
    // 20 ticks steady at 100 bpm — a change-based accumulator would count this ONCE
    fakeHr.bpm = 100
    for (let i = 0; i < 20; i++) await walk(w, 10, 1)
    // 2 ticks at 160
    fakeHr.bpm = 160
    for (let i = 0; i < 2; i++) await walk(w, 10, 1)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    const [session] = logged() as { avgHr?: number }[]
    // time-weighted: (20*100 + 2*160) / 22 ≈ 105 — change-weighted would be ~130
    expect(session!.avgHr).toBeGreaterThan(100)
    expect(session!.avgHr).toBeLessThan(112)
    fakeHr.connected = false
    fakeHr.bpm = 0
  })
})

describe('wake lock race (#133)', () => {
  it('a lock resolving after the walk ended is released immediately', async () => {
    const release = vi.fn(async () => {})
    let resolveReq: (s: WakeLockSentinel) => void
    const request = vi.fn(() => new Promise<WakeLockSentinel>((r) => (resolveReq = r)))
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true })
    const w = await mountToMain()
    await clickButton(w, 'Start') // acquire in flight, unresolved
    await w.vm.$nextTick()
    await clickButton(w, 'Stop') // walk ends before the sentinel arrives
    await w.vm.$nextTick()
    resolveReq!({ release } as unknown as WakeLockSentinel)
    await Promise.resolve()
    await Promise.resolve()
    expect(release).toHaveBeenCalled() // late sentinel released, not leaked
  })
})

describe('strava prompt queue (#140)', () => {
  it('a second finished walk queues instead of clobbering the open prompt', async () => {
    fakeStrava.connected = true
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 300, 300)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(w.text()).toContain('Upload to Strava?')
    // second walk finishes while the first prompt is still open
    await clickButton(w, 'Start')
    await walk(w, 400, 300)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    // still the FIRST session's prompt (0.30 km)
    expect(w.find('.strava-sheet').text()).toContain('0.30')
    await clickButton(w, 'Skip')
    await w.vm.$nextTick()
    // dismissing surfaces the queued second prompt (0.40 km)
    expect(w.find('.strava-sheet').text()).toContain('0.40')
    await clickButton(w, 'Skip')
    expect(w.find('.strava-sheet').exists()).toBe(false)
    fakeStrava.connected = false
  })
})

describe('screen wake lock (#19)', () => {
  it('requests the lock when the belt starts and releases it on stop', async () => {
    const release = vi.fn(async () => {})
    const request = vi.fn(async () => ({ release }) as unknown as WakeLockSentinel)
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true })
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await w.vm.$nextTick()
    expect(request).toHaveBeenCalledWith('screen')
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(release).toHaveBeenCalled()
  })
})

describe('strava auto-upload (#70)', () => {
  it('uploads finished walks directly when the toggle is on, no prompt', async () => {
    localStorage.setItem('walkfit.strava.autoUpload', '1')
    fakeStrava.connected = true
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 1000, 600)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(uploadSession).toHaveBeenCalledTimes(1)
    expect(uploadSession.mock.calls[0]![1]).toBe('Free walk')
    expect(w.text()).not.toContain('Upload to Strava?') // no prompt
    await w.vm.$nextTick()
    expect(w.find('.toast').exists()).toBe(true) // confirmation toast
  })

  it('falls back to the prompt when the auto-upload fails', async () => {
    localStorage.setItem('walkfit.strava.autoUpload', '1')
    fakeStrava.connected = true
    uploadSession.mockRejectedValueOnce(new Error('rate limited'))
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 1000, 600)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(w.text()).toContain('Upload to Strava?')
  })

  it('keeps the prompt behavior when the toggle is off', async () => {
    fakeStrava.connected = true
    const w = await mountToMain()
    await clickButton(w, 'Start')
    await walk(w, 1000, 600)
    await clickButton(w, 'Stop')
    await w.vm.$nextTick()
    expect(uploadSession).not.toHaveBeenCalled()
    expect(w.text()).toContain('Upload to Strava?')
  })
})
