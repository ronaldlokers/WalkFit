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
