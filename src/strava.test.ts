import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { localWallTime, useStrava } from './strava'

describe('localWallTime (#59)', () => {
  it('formats local wall time with no zone designator', () => {
    expect(localWallTime('2026-07-13T19:00:00.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    )
  })

  it('round-trips to the same instant when re-parsed as local time', () => {
    // TZ-independent: parsing the zone-less string as local must land on the original
    // epoch — exactly the property Strava's start_date_local relies on.
    for (const iso of [
      '2026-07-13T19:00:00.000Z',
      '2026-01-05T23:30:00.000Z', // winter (different DST offset)
      '2026-06-30T00:15:00.000Z', // near midnight — date rolls across zones
    ]) {
      const local = localWallTime(iso)
      expect(new Date(local).getTime()).toBe(new Date(iso).getTime())
    }
  })
})

describe('refresh rotation race (#138)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('retries with the rotated token from storage instead of disconnecting', async () => {
    const expired = {
      accessToken: 'at-stale',
      refreshToken: 'rt-stale',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      athleteName: 'R',
    }
    localStorage.setItem('walkfit.strava', JSON.stringify(expired))
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/refresh')) {
        const sent = JSON.parse(String(init?.body)).refresh_token as string
        calls.push(sent)
        if (sent === 'rt-stale') {
          // another tab won the race: rotated pair already in storage, ours 400s
          localStorage.setItem(
            'walkfit.strava',
            JSON.stringify({ ...expired, accessToken: 'at-new', refreshToken: 'rt-new' }),
          )
          return { ok: false, status: 400, json: async () => ({ message: 'invalid' }) }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'at-new2',
            refresh_token: 'rt-new2',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        }
      }
      return { ok: true, status: 201, json: async () => ({ id: 1 }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { uploadSession, state } = useStrava()
    await uploadSession(
      { date: '2026-07-14T08:00:00.000Z', distance: 1000, duration: 600, kcal: 50, avgHr: null },
      'Walk',
    )
    expect(calls).toEqual(['rt-stale', 'rt-new']) // retried with the rotated token
    expect(state.connected).toBe(true) // pair NOT destroyed
    expect(JSON.parse(localStorage.getItem('walkfit.strava')!).refreshToken).toBe('rt-new2')
  })
})
