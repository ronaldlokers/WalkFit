// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'

// jsdom doesn't implement SVG geometry; stub what the loop/marker code calls.
// Full-App mounts under a loaded parallel run can exceed vitest's 5 s default —
// generous ceiling, not a wait (same rationale as App.hrWorkout.test.ts).
vi.setConfig({ testTimeout: 20000 })

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
    expect(w.find('.stat-strip').text()).toContain('kcal')
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
    await clickButton(w, 'Weight') // tab (#115 mock №3)
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

  it('statistics dashboard: hero band, tabs, Mon-Sun week navigation (#115)', async () => {
    // 2026-07-13 is a Monday; seed one walk that Monday and one the Sunday before
    // (previous calendar week) — the week view must separate them.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-13T20:00:00') })
    localStorage.setItem('walkfit.goals', JSON.stringify({ kcal: 400, steps: 6000, minutes: 30 }))
    localStorage.setItem(
      'walkfit.history',
      JSON.stringify([
        {
          date: '2026-07-12T08:00:00',
          distance: 900,
          duration: 900,
          kcal: 40,
          avgHr: 100,
        },
        {
          date: '2026-07-13T08:00:00',
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

    // hero band reflects the current week (Mon 13 - Sun 19: only Monday's walk)
    const hero = w.find('.hero-band').text()
    expect(hero).toContain('1.5') // km this week
    expect(hero).toContain('72') // kcal this week
    // Activity tab is the default: three day charts with a full Mon-Sun axis
    expect(w.findAll('.activity-grid .card').length).toBe(3)
    expect(w.findAll('.activity-grid .card')[0]!.findAll('.bar-slot').length).toBe(7)
    expect(w.findAll('.card-total').map((t) => t.text())).toContain('1800 steps')

    // HR tab shows Monday's span only
    await clickButton(w, 'Heart rate')
    expect(w.findAll('.hr-span').length).toBe(1)

    // Walks tab lists only this week's walk
    await clickButton(w, 'Walks')
    expect(w.findAll('.walk-row').length).toBe(1)
    expect(w.find('.walk-row').text()).toContain('1.50 km')

    // ← one week back: Sunday's walk appears, hero updates, This-week chip shows
    const nav = w.findAll('.wk-btn')
    await nav[0]!.trigger('click')
    expect(w.findAll('.walk-row').length).toBe(1)
    expect(w.find('.walk-row').text()).toContain('900 m')
    expect(w.find('.hero-band').text()).toContain('0.9')
    expect(w.find('.today-chip').exists()).toBe(true)

    // → forward returns to the current week; the chip goes away
    await nav[1]!.trigger('click')
    expect(w.find('.walk-row').text()).toContain('1.50 km')
    expect(w.find('.today-chip').exists()).toBe(false)

    // date picker jumps to the week containing the picked date
    await w.find('.week-date').setValue('2026-07-08') // a Wednesday, week of Jul 6-12
    expect(w.find('.walk-row').text()).toContain('900 m')
    await clickButton(w, 'This week')
    expect(w.find('.walk-row').text()).toContain('1.50 km')
    vi.useRealTimers()
  })

  it('week boundary is the local next Monday, not anchor+168h (#135)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-13T10:00:00') })
    localStorage.setItem('walkfit.setupDone', '1')
    localStorage.setItem(
      'walkfit.history',
      JSON.stringify([
        // Sunday 23:59 local — inside the Jul 13-19 week
        { date: '2026-07-19T23:59:00', distance: 800, duration: 600, kcal: 35, avgHr: null },
        // Monday 00:00 local — first second of the NEXT week
        { date: '2026-07-20T00:00:00', distance: 900, duration: 700, kcal: 40, avgHr: null },
      ]),
    )
    const w = mount(App)
    await clickButton(w, '☰')
    await w
      .findAll('.menu-item')
      .find((b) => b.text().includes('Statistics'))!
      .trigger('click')
    await clickButton(w, 'Walks')
    expect(w.findAll('.walk-row')).toHaveLength(1)
    expect(w.find('.walk-row').text()).toContain('800 m')
    vi.useRealTimers()
  })

  it('the dashboard clock ticks: Sunday-to-Monday rollover follows the new week (#134)', async () => {
    // Sunday evening Jul 19; the open dashboard must roll to the new week at midnight
    vi.useFakeTimers({ toFake: ['Date', 'setInterval'], now: new Date('2026-07-19T23:59:50') })
    localStorage.setItem('walkfit.setupDone', '1')
    localStorage.setItem(
      'walkfit.history',
      JSON.stringify([
        { date: '2026-07-19T10:00:00', distance: 900, duration: 600, kcal: 40, avgHr: null },
      ]),
    )
    const w = mount(App)
    await clickButton(w, '☰')
    await w
      .findAll('.menu-item')
      .find((b) => b.text().includes('Statistics'))!
      .trigger('click')
    expect(w.find('.week-label span').text()).toContain('19') // week ends Sun 19 Jul
    expect(w.find('.today-chip').exists()).toBe(false) // on the current week

    // cross midnight; the 30s clock tick fires and the view follows the new week
    vi.setSystemTime(new Date('2026-07-20T00:00:20'))
    vi.advanceTimersByTime(30_000)
    await w.vm.$nextTick()
    expect(w.find('.week-label span').text()).toContain('26') // week of Jul 20-26
    expect(w.find('.today-chip').exists()).toBe(false) // still "current week", not stale
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
    await clickButton(w, 'Weight')
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
    await clickButton(w, 'Walks')

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

describe('immersive layout (#103)', () => {
  it('is always immersive', () => {
    localStorage.setItem('walkfit.setupDone', '1')
    const w = mount(App)
    expect(w.find('.app').classes()).toContain('layout-immersive')
  })

  it('shows the workout ribbon during a plan and End clears it', async () => {
    localStorage.setItem('walkfit.setupDone', '1')
    const w = mount(App)
    expect(w.find('.imm-workout').exists()).toBe(false)
    await clickButton(w, '☰')
    await clickButton(w, 'Workout')
    await w.find('.tcard').trigger('click')
    await clickButton(w, 'Start workout')
    const ribbon = w.find('.imm-workout')
    expect(ribbon.exists()).toBe(true)
    expect(ribbon.text()).toContain('seg 1/')
    expect(ribbon.findAll('.imm-seg').length).toBeGreaterThan(1)
    // hero countdown ring + now→next speeds (#110)
    expect(ribbon.find('.imm-ring-val').text()).toMatch(/^\d{2}:\d{2}$/)
    expect(ribbon.find('.imm-now .imm-nn-v').text()).toMatch(/^\d\.\d$/)
    expect(ribbon.find('.imm-next .imm-nn-v').text()).toMatch(/^\d\.\d$/) // seg 1 of several
    // Skip (#110) is exercised end-to-end in App.hrWorkout.test.ts, where the fake
    // treadmill fixture has running: true — required for finishWorkout() to fire
    expect(ribbon.findAll('button').some((b) => b.text() === 'Skip')).toBe(true)
    await clickButton(w, 'End')
    expect(w.find('.imm-workout').exists()).toBe(false)
  })
})
