import { describe, it, expect, beforeEach } from 'vitest'
import { syncProvider, loadCursor } from './health'
import type { HealthProvider, WeighInSync } from './health'
import { loadWeightLog } from './weight'

beforeEach(() => localStorage.clear())

function fakeProvider(syncWeight: () => Promise<WeighInSync>): HealthProvider {
  return {
    id: 'fake',
    name: 'Fake',
    state: {
      supported: true,
      connected: true,
      connecting: false,
      syncing: false,
      error: '',
      accountLabel: '',
      lastSync: null,
    },
    connect() {},
    disconnect() {},
    handleRedirect: async () => false,
    syncWeight,
  }
}

describe('syncProvider cursor handling (#57)', () => {
  it('stores the provider-derived cursor after a successful merge', async () => {
    const p = fakeProvider(async () => ({
      entries: [{ date: '2026-07-01T07:00:00.000Z', kg: 82.4, source: 'fake' }],
      cursor: 1783926000000,
    }))
    const merged = await syncProvider(p)
    expect(merged).toHaveLength(1)
    expect(loadCursor('fake')).toBe(1783926000000)
    expect(loadWeightLog()).toHaveLength(1)
  })

  it('leaves the cursor untouched when the sync throws — the batch must be re-fetched', async () => {
    localStorage.setItem('walkfit.health.cursor.fake', '111')
    const p = fakeProvider(async () => {
      throw new Error('network down')
    })
    const merged = await syncProvider(p)
    expect(merged).toBeNull()
    expect(p.state.error).toMatch(/network down/)
    expect(loadCursor('fake')).toBe(111) // not advanced past the dropped batch
  })

  it('a null cursor means "nothing new" and keeps the stored cursor', async () => {
    localStorage.setItem('walkfit.health.cursor.fake', '222')
    const p = fakeProvider(async () => ({ entries: [], cursor: null }))
    await syncProvider(p)
    expect(loadCursor('fake')).toBe(222)
  })
})
