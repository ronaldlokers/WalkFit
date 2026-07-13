// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from './App.vue'

// jsdom doesn't implement SVG geometry; stub what the loop/marker code calls.
beforeAll(() => {
  SVGElement.prototype.getTotalLength = () => 100
  SVGElement.prototype.getPointAtLength = () => ({ x: 0, y: 0 })
})
beforeEach(() => localStorage.clear())

// Click the first <button> whose text contains `label`.
async function clickButton(wrapper, label) {
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
    expect(w.text()).toContain('current speed')
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
      .find((c) => c.text().includes('Workout'))
      .trigger('click')
    const cards = w.findAll('.tcard')
    expect(cards.length).toBeGreaterThan(0)
    await cards[0].trigger('click')
    await w
      .findAll('button')
      .find((b) => b.text().includes('Start workout'))
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
    expect(cards[0].text()).toMatch(/km/)
    expect(cards[0].text()).toMatch(/kcal/)
  })

  it('wizard step 4 embeds the same tabbed WorkoutPicker as the header menu, including HR targets', async () => {
    const w = mount(App)
    await clickButton(w, 'Skip')
    await clickButton(w, 'Skip')
    await w
      .findAll('.mode-card')
      .find((c) => c.text().includes('Workout'))
      .trigger('click')
    // still inside the wizard (step 4), not the header's separate overlay
    expect(w.text()).toContain('current speed')
    expect(w.find('.wizard').exists()).toBe(true)
    expect(w.find('.workout-tabs').exists()).toBe(true)
    expect(w.find('.tlist').exists()).toBe(true)
    // switching tabs from here reaches the same HR targets the header menu has
    await w
      .findAll('.workout-tab')
      .find((b) => b.text().includes('Heart rate'))
      .trigger('click')
    expect(w.findAll('.hr-zone-opt').length).toBe(4)
    // wizard's own Back nav still works to leave the picker
    await w
      .findAll('.wiz-nav button')
      .find((b) => b.text().includes('Back'))
      .trigger('click')
    expect(w.find('.mode-grid').exists()).toBe(true)
  })
})
