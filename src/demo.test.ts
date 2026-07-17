// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { isDemo, demoTreadmill, demoHeartRate, seedDemoData } from './demo'

beforeEach(() => localStorage.clear())
afterEach(() => vi.useRealTimers())

describe('demo mode (#169)', () => {
  it('is opt-in only', () => {
    expect(isDemo()).toBe(false)
    localStorage.setItem('walkfit.demo', '1')
    expect(isDemo()).toBe(true)
  })

  it('the simulated belt connects, ramps toward the target, and accrues distance', async () => {
    vi.useFakeTimers()
    const tm = demoTreadmill()
    const p = tm.connect()
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(tm.state.connected).toBe(true)
    await tm.setSpeed(4.0)
    await tm.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(tm.state.speed).toBe(4.0) // ramped up and settled
    expect(tm.state.distance).toBeGreaterThan(20)
    expect(tm.state.elapsed).toBe(30)
    expect(tm.state.steps).toBeGreaterThan(0)
    await tm.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tm.state.speed).toBe(0) // coasted down
    tm.disconnect()
  })

  it('the simulated strap produces plausible bpm that rises with belt speed', async () => {
    vi.useFakeTimers()
    const tm = demoTreadmill()
    const hr = demoHeartRate()
    const p = Promise.all([tm.connect(), hr.connect()])
    await vi.advanceTimersByTimeAsync(500)
    await p
    await vi.advanceTimersByTimeAsync(20_000)
    const resting = hr.state.bpm
    expect(resting).toBeGreaterThan(60)
    expect(resting).toBeLessThan(100)
    await tm.setSpeed(6.0)
    await tm.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hr.state.bpm).toBeGreaterThan(resting + 20) // heart follows the belt
    tm.disconnect()
    hr.disconnect()
  })

  it('seedDemoData populates every surface once and never clobbers real data', () => {
    seedDemoData()
    const history = JSON.parse(localStorage.getItem('walkfit.history')!)
    expect(history.length).toBeGreaterThan(50) // #196: 90-day window, not just a handful of days
    expect(history.some((s: { series?: unknown[] }) => s.series && s.series.length > 1)).toBe(true)
    expect(history.some((s: { workout?: string }) => s.workout)).toBe(true)
    expect(JSON.parse(localStorage.getItem('walkfit.weight.log')!)[0].fatPct).toBeDefined()
    expect(JSON.parse(localStorage.getItem('walkfit.workouts.custom')!)).toHaveLength(2)
    // existing history blocks the seed
    localStorage.setItem('walkfit.history', '[{"real":1}]')
    localStorage.removeItem('walkfit.weight.log')
    seedDemoData()
    expect(localStorage.getItem('walkfit.history')).toBe('[{"real":1}]')
    expect(localStorage.getItem('walkfit.weight.log')).toBeNull()
  })
})
