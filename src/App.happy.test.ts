// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'

// jsdom doesn't implement SVG geometry; stub what the loop/marker code calls.
type SvgGeometryStub = { getTotalLength(): number; getPointAtLength(d: number): DOMPoint }
beforeAll(() => {
  const proto = SVGElement.prototype as unknown as SvgGeometryStub
  proto.getTotalLength = () => 100
  proto.getPointAtLength = () => ({ x: 0, y: 0 }) as DOMPoint
})
beforeEach(() => localStorage.clear())

// Click the first <button> whose text contains `label`.
async function clickButton(wrapper: VueWrapper, label: string) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(label))
  if (!btn) throw new Error(`no button matching "${label}"`)
  await btn.trigger('click')
}

describe('App happy path', () => {
  it('opens the onboarding wizard on load', () => {
    const w = mount(App)
    expect(w.text()).toContain('Connect your treadmill')
  })

  it('skips the wizard for returning users (#63)', () => {
    localStorage.setItem('walkfit.setupDone', '1')
    const w = mount(App)
    expect(w.text()).not.toContain('Connect your treadmill')
    expect(w.find('.stat-strip').exists()).toBe(true)
  })

  it('completing the wizard once persists setup-done (#63)', async () => {
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    expect(localStorage.getItem('walkfit.setupDone')).toBe('1')
  })

  it('Settings weight edits in one day collapse to a single weigh-in (#63)', async () => {
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    await clickButton(w, '☰')
    await clickButton(w, 'Settings')
    const input = w
      .findAll('input[type="number"]')
      .find((i) => i.attributes('max') === '250' && i.attributes('min') === '30')!
    await input.setValue(83)
    await input.trigger('change')
    await input.setValue(82.5)
    await input.trigger('change')
    const log = JSON.parse(localStorage.getItem('walkfit.weight.log') || '[]')
    expect(log).toHaveLength(1) // overwritten, not appended
    expect(log[0].kg).toBe(82.5)
  })

  it('wizard → Free walk reaches the main screen (no workout active)', async () => {
    const w = mount(App)
    await clickButton(w, 'Skip') // step 1 treadmill -> 2
    await clickButton(w, 'Skip') // step 2 heart rate -> 3
    await clickButton(w, 'Free walk') // finish
    expect(w.text()).not.toContain('Connect your treadmill')
    // header stat strip shows the live values, faded while idle (#46)
    expect(w.find('.stat-strip').exists()).toBe(true)
    expect(w.find('.stat-strip').classes()).toContain('idle')
    expect(w.find('.stat-strip').text()).toContain('min/km')
    expect(w.find('.workout-banner').exists()).toBe(false)
  })

  it('wizard → Workout → pick a session activates it and hides manual speed', async () => {
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    // choose Workout mode (the wizard card, not the header button of the same text) —
    // this now opens the same overlay the header button does: card click previews, a
    // separate "Start workout" button actually activates it.
    await w
      .findAll('.mode-card')
      .find((c) => c.text().includes('Workout'))!
      .trigger('click')
    const cards = w.findAll('.tcard')
    expect(cards.length).toBeGreaterThan(0)
    await cards[0]!.trigger('click')
    await w
      .findAll('button')
      .find((b) => b.text().includes('Start workout'))!
      .trigger('click')
    // overlay closed, a workout is now active
    expect(w.find('.workout-banner').exists()).toBe(true)
    // manual speed control is hidden while a workout drives the belt
    expect(w.find('.speed-row').exists()).toBe(false)
  })

  it('lists every preset workout in the menu with time/distance/kcal', async () => {
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    await clickButton(w, '☰') // header overflow menu
    await clickButton(w, 'Workout') // opens the workout menu overlay (weight-loss tab default)
    const cards = w.findAll('.tcard')
    expect(cards.length).toBe(5)
    expect(cards[0]!.text()).toMatch(/km/)
    expect(cards[0]!.text()).toMatch(/kcal/)
  })

  it('statistics sheet logs a weigh-in: trend appears and kcal weight follows the newest entry', async () => {
    // fake only Date: two same-ms weigh-ins would share the merge key (source+date)
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-13T08:00:00.000Z') })
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    await clickButton(w, '☰')
    await clickButton(w, 'Statistics')
    expect(w.find('.weight-section').exists()).toBe(true)
    expect(w.text()).toContain('No weigh-ins yet')

    await w.find('.weigh-row input').setValue(82.4)
    await clickButton(w, 'Log weigh-in')
    expect(w.find('.weight-section').text()).toContain('82.4')
    expect(JSON.parse(localStorage.getItem('walkfit.weight.log')!)).toHaveLength(1)
    expect(localStorage.getItem('walkfit.weight')).toBe('82.4') // newest entry drives kcal weight

    // second entry a day later -> two points, trend chart renders
    vi.setSystemTime(new Date('2026-07-14T08:00:00.000Z'))
    await w.find('.weigh-row input').setValue(82.1)
    await clickButton(w, 'Log weigh-in')
    expect(w.find('.weight-chart').exists()).toBe(true)
    expect(localStorage.getItem('walkfit.weight')).toBe('82.1')
    vi.useRealTimers()
  })

  it('statistics sheet shows activity rings, daily charts, and the HR range chart', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-13T20:00:00.000Z') })
    // seed: one walk today (with steps + HR range), one yesterday (pre-#43 shape: no steps/hr range)
    localStorage.setItem('walkfit.goals', JSON.stringify({ kcal: 400, steps: 6000, minutes: 30 }))
    localStorage.setItem(
      'walkfit.history',
      JSON.stringify([
        {
          date: '2026-07-12T08:00:00.000Z',
          distance: 900,
          duration: 900,
          kcal: 40,
          avgHr: 100,
        },
        {
          date: '2026-07-13T08:00:00.000Z',
          distance: 1500,
          duration: 1200,
          kcal: 72,
          steps: 1800,
          avgHr: 112,
          hrMin: 88,
          hrMax: 131,
        },
      ]),
    )
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    await clickButton(w, '☰')
    await clickButton(w, 'Statistics')

    // rings: three tracks, fills for today's non-zero metrics, legend shows value/goal
    expect(w.findAll('.ring-track').length).toBe(3)
    expect(w.findAll('.ring-fill').length).toBe(3)
    const legend = w.find('.ring-legend').text()
    expect(legend).toContain('72')
    expect(legend).toContain('/ 400 kcal')
    expect(legend).toContain('1800')
    expect(legend).toContain('/ 6000 steps')
    expect(legend).toContain('20') // 1200s -> 20 min
    expect(legend).toContain('/ 30 min')

    // daily detail: three bar charts with period totals, 7d default
    const charts = w.findAll('.daychart')
    expect(charts.length).toBe(4) // kcal, steps, time + HR
    expect(charts[0]!.text()).toContain('112 kcal') // 40 + 72 over the week
    expect(charts[1]!.text()).toContain('1800 steps') // yesterday's pre-#43 walk adds 0
    expect(w.find('.chip.on').text()).toBe('7d')
    expect(w.findAll('.bar-slot').length).toBeGreaterThan(20) // 7 slots x 3 charts + HR

    // HR chart: both days have HR data (yesterday falls back to avgHr for the range)
    expect(w.findAll('.hr-span').length).toBe(2)
    expect(w.findAll('.hr-avg').length).toBe(2)

    // range selector re-renders at 30 days
    await w
      .findAll('.chip')
      .find((c) => c.text() === '30d')!
      .trigger('click')
    expect(w.find('.chip.on').text()).toBe('30d')
    expect(w.findAll('.daychart')[0]!.findAll('.bar-slot').length).toBe(30)
    vi.useRealTimers()
  })

  it('scenic without WebGL falls back to the track view and disables the toggle', async () => {
    // jsdom has no WebGL: the async Scenic3D component mounts, probes, and emits
    // 'unsupported' — the app must land on the track view, not a blank scene (#51).
    localStorage.setItem('walkfit.view', 'scenic')
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    // let the defineAsyncComponent import (three.js chunk) + mount + emit settle
    await vi.waitFor(() => expect(w.find('.track').exists()).toBe(true), { timeout: 5000 })
    expect(w.find('.scene3d-wrap').exists()).toBe(false)
    // the Settings view toggle disables the 3D option
    await clickButton(w, '☰')
    await clickButton(w, 'Settings')
    const btn3d = w.findAll('button').find((b) => b.text() === '3D')!
    expect(btn3d.attributes('disabled')).toBeDefined()
    expect(btn3d.attributes('title')).toBe('Needs WebGL')
  })

  it('a goal weight draws the target line and the to-go delta (#71)', async () => {
    localStorage.setItem('walkfit.weight.goal', '80')
    localStorage.setItem(
      'walkfit.weight.log',
      JSON.stringify([
        { date: '2026-07-01T07:00:00.000Z', kg: 85, source: 'manual' },
        { date: '2026-07-10T07:00:00.000Z', kg: 83.2, source: 'manual' },
      ]),
    )
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    await clickButton(w, '☰')
    await clickButton(w, 'Statistics')
    expect(w.find('.weight-goal-line').exists()).toBe(true)
    expect(w.find('.weight-section').text()).toContain('3.2')
    expect(w.find('.weight-section').text()).toContain('to goal')
  })

  it('recent walks list expands to a detail view and deletes a session (#67)', async () => {
    localStorage.setItem(
      'walkfit.history',
      JSON.stringify([
        {
          date: '2026-07-13T08:00:00.000Z',
          distance: 900,
          duration: 600,
          kcal: 40,
          steps: 1100,
          avgHr: 105,
          hrMin: 90,
          hrMax: 120,
        },
        { date: '2026-07-14T08:00:00.000Z', distance: 1200, duration: 800, kcal: 55, avgHr: null },
      ]),
    )
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await clickButton(w, 'Free walk')
    await clickButton(w, '☰')
    await clickButton(w, 'Statistics')

    const rows = w.findAll('.walk-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('1.20 km') // newest first
    await rows[1]!.trigger('click') // expand the older walk
    const detail = w.find('.walk-detail')
    expect(detail.text()).toContain('1100') // steps
    expect(detail.text()).toContain('90–120') // bpm range
    await clickButton(w, 'Delete this walk')
    expect(w.findAll('.walk-row')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('walkfit.history')!)).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('walkfit.history')!)[0].date).toBe(
      '2026-07-14T08:00:00.000Z',
    )
  })

  it('wizard step 4 embeds the same tabbed WorkoutPicker as the header menu, including HR targets', async () => {
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await w
      .findAll('.mode-card')
      .find((c) => c.text().includes('Workout'))!
      .trigger('click')
    // still inside the wizard (step 4), not the header's separate overlay
    expect(w.find('.stat-strip').exists()).toBe(true)
    expect(w.find('.wizard').exists()).toBe(true)
    expect(w.find('.workout-tabs').exists()).toBe(true)
    expect(w.find('.tlist').exists()).toBe(true)
    // switching tabs from here reaches the same HR targets the header menu has
    await w
      .findAll('.workout-tab')
      .find((b) => b.text().includes('Heart rate'))!
      .trigger('click')
    expect(w.findAll('.hr-zone-opt').length).toBe(4)
    // wizard's own Back nav still works to leave the picker
    await w
      .findAll('.wiz-nav button')
      .find((b) => b.text().includes('Back'))!
      .trigger('click')
    expect(w.find('.mode-grid').exists()).toBe(true)
  })
})

describe('experimental layouts (#103)', () => {
  it('defaults to the current layout and persists a switch', async () => {
    localStorage.setItem('walkfit.setupDone', '1')
    const w = mount(App)
    expect(w.find('.app').classes()).toContain('layout-current')
    await clickButton(w, '☰')
    await clickButton(w, 'Settings')
    const select = w
      .findAll('select')
      .find((s) => s.findAll('option').some((o) => o.attributes('value') === 'immersive'))!
    await select.setValue('immersive')
    expect(w.find('.app').classes()).toContain('layout-immersive')
    expect(localStorage.getItem('walkfit.layout')).toBe('immersive')
  })

  it('persisted immersive layout applies on load, big-numbers option adds hud-big', () => {
    localStorage.setItem('walkfit.setupDone', '1')
    localStorage.setItem('walkfit.layout', 'immersive')
    localStorage.setItem('walkfit.layout.big', '1')
    const w = mount(App)
    expect(w.find('.app').classes()).toContain('layout-immersive')
    expect(w.find('.app').classes()).toContain('hud-big')
    // dashboard widgets stay out of the other layouts
    expect(w.find('.dash-widget').exists()).toBe(false)
  })

  it('dashboard layout renders the Today and Recent walks widgets', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-13T20:00:00.000Z') })
    localStorage.setItem('walkfit.setupDone', '1')
    localStorage.setItem('walkfit.layout', 'dashboard')
    localStorage.setItem('walkfit.goals', JSON.stringify({ kcal: 400, steps: 6000, minutes: 30 }))
    localStorage.setItem(
      'walkfit.history',
      JSON.stringify([
        { date: '2026-07-12T08:00:00.000Z', distance: 900, duration: 900, kcal: 40, avgHr: null },
        {
          date: '2026-07-13T08:00:00.000Z',
          distance: 1500,
          duration: 1200,
          kcal: 72,
          steps: 1800,
          avgHr: 112,
        },
      ]),
    )
    const w = mount(App)
    expect(w.find('.app').classes()).toContain('layout-dashboard')
    const widgets = w.findAll('.dash-widget')
    expect(widgets).toHaveLength(2)
    expect(widgets[0]!.text()).toContain('Today')
    expect(widgets[0]!.text()).toContain('72 / 400') // today's kcal vs goal
    expect(widgets[0]!.text()).toContain('1800 / 6000')
    expect(widgets[1]!.text()).toContain('Recent walks')
    expect(widgets[1]!.findAll('.dw-walk')).toHaveLength(2)
    expect(widgets[1]!.findAll('.dw-walk')[0]!.text()).toContain('1.50 km') // newest first
    vi.useRealTimers()
  })
})
