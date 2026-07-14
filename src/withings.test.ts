import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { unwrapEnvelope, parseWeighIns, useWithings } from './withings'
import type { MeasureGroup } from './withings'

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

const grp = (over: Partial<MeasureGroup> = {}): MeasureGroup => ({
  grpid: 1,
  date: 1783926000, // 2026-07-13T07:00:00.000Z
  category: 1,
  measures: [{ value: 82400, unit: -3, type: 1 }],
  ...over,
})

describe('unwrapEnvelope', () => {
  it('returns body when status is 0', () => {
    expect(unwrapEnvelope({ status: 0, body: { ok: true } })).toEqual({ ok: true })
  })
  it('throws on status != 0 even though HTTP said 200', () => {
    expect(() => unwrapEnvelope({ status: 401, error: 'invalid_token' })).toThrow(/invalid_token/)
  })
  it('throws on a missing body', () => {
    expect(() => unwrapEnvelope({ status: 0 })).toThrow(/Withings error/)
  })
})

describe('parseWeighIns', () => {
  it('converts value x 10^unit to kg, unix date to ISO, and carries the grpid', () => {
    expect(parseWeighIns([grp()])).toEqual([
      { date: '2026-07-13T07:00:00.000Z', kg: 82.4, source: 'withings', grpid: 1 },
    ])
  })
  it('handles other unit exponents', () => {
    expect(parseWeighIns([grp({ measures: [{ value: 8240, unit: -2, type: 1 }] })])[0]!.kg).toBe(
      82.4,
    )
    expect(parseWeighIns([grp({ measures: [{ value: 82, unit: 0, type: 1 }] })])[0]!.kg).toBe(82)
  })
  it('carries body fat % and muscle mass when the group has them (#42)', () => {
    const e = parseWeighIns([
      grp({
        measures: [
          { value: 82400, unit: -3, type: 1 },
          { value: 245, unit: -1, type: 6 }, // 24.5 % body fat
          { value: 55300, unit: -3, type: 76 }, // 55.3 kg muscle
        ],
      }),
    ])[0]!
    expect(e.kg).toBe(82.4)
    expect(e.fatPct).toBe(24.5)
    expect(e.muscleKg).toBe(55.3)
    // weight-only group: extras stay absent
    expect(parseWeighIns([grp()])[0]!.fatPct).toBeUndefined()
  })

  it('skips user objectives (category 2) and groups without a weight measure', () => {
    expect(
      parseWeighIns([
        grp({ category: 2 }),
        grp({ measures: [{ value: 500, unit: -1, type: 6 }] }), // type 6 = body fat %
      ]),
    ).toEqual([])
  })
})

describe('useWithings syncWeight', () => {
  const tokens = (over = {}) => ({
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  })
  const measureEnvelope = { status: 0, body: { measuregrps: [grp()] } }

  it('fetches weigh-ins browser-direct with the bearer token', async () => {
    localStorage.setItem('walkfit.withings', JSON.stringify(tokens()))
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(measureEnvelope)))
    vi.stubGlobal('fetch', fetchMock)

    const { entries } = await useWithings().syncWeight()
    expect(entries).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://wbsapi.withings.net/measure')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer at-old')
    expect(String(init!.body)).toContain('action=getmeas')
    expect(String(init!.body)).not.toContain('lastupdate') // no cursor -> full history
  })

  it('sends the stored cursor incrementally (legacy lastSync as fallback)', async () => {
    localStorage.setItem('walkfit.withings', JSON.stringify(tokens()))
    localStorage.setItem('walkfit.health.lastSync.withings', '1783926000000')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(measureEnvelope)))
    vi.stubGlobal('fetch', fetchMock)

    await useWithings().syncWeight()
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain('lastupdate=1783926000')

    // a dedicated cursor takes precedence over the legacy wall-clock value
    localStorage.setItem('walkfit.health.cursor.withings', '1783930000000')
    await useWithings().syncWeight()
    expect(String(fetchMock.mock.calls[1]![1]!.body)).toContain('lastupdate=1783930000')
  })

  it('derives the next cursor from the response timestamps, not the client clock (#57)', async () => {
    localStorage.setItem('walkfit.withings', JSON.stringify(tokens()))
    const envelope = {
      status: 0,
      body: {
        measuregrps: [
          grp({ grpid: 1, date: 1783926000 }),
          grp({ grpid: 2, date: 1783930000, modified: 1783999999 }), // edited later
        ],
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(envelope))),
    )
    const { cursor } = await useWithings().syncWeight()
    expect(cursor).toBe(1783999999 * 1000) // max(modified ?? date), in ms
  })

  it('returns a null cursor when the sync had nothing new', async () => {
    localStorage.setItem('walkfit.withings', JSON.stringify(tokens()))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 0, body: { measuregrps: [] } }))),
    )
    const { entries, cursor } = await useWithings().syncWeight()
    expect(entries).toEqual([])
    expect(cursor).toBeNull()
  })

  it('follows pagination instead of truncating a multi-page history (#57)', async () => {
    localStorage.setItem('walkfit.withings', JSON.stringify(tokens()))
    const page1 = {
      status: 0,
      body: { measuregrps: [grp({ grpid: 1 })], more: 1, offset: 42 },
    }
    const page2 = {
      status: 0,
      body: { measuregrps: [grp({ grpid: 2, date: 1783930000 })], more: 0 },
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1)))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2)))
    vi.stubGlobal('fetch', fetchMock)

    const { entries } = await useWithings().syncWeight()
    expect(entries).toHaveLength(2)
    expect(String(fetchMock.mock.calls[0]![1]!.body)).not.toContain('offset')
    expect(String(fetchMock.mock.calls[1]![1]!.body)).toContain('offset=42')
  })

  it('refreshes an expired token and persists the ROTATED refresh token immediately', async () => {
    localStorage.setItem(
      'walkfit.withings',
      JSON.stringify(tokens({ expiresAt: Math.floor(Date.now() / 1000) - 10 })),
    )
    const refreshEnvelope = {
      status: 0,
      body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 10800 },
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(refreshEnvelope)))
      .mockResolvedValueOnce(new Response(JSON.stringify(measureEnvelope)))
    vi.stubGlobal('fetch', fetchMock)

    const { entries } = await useWithings().syncWeight()
    expect(entries).toHaveLength(1)
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      refresh_token: 'rt-old',
    })
    const stored = JSON.parse(localStorage.getItem('walkfit.withings')!)
    expect(stored.refreshToken).toBe('rt-new')
    expect(stored.accessToken).toBe('at-new')
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer at-new',
    )
  })

  it('disconnects with a readable error when the refresh itself is rejected', async () => {
    localStorage.setItem(
      'walkfit.withings',
      JSON.stringify(tokens({ expiresAt: Math.floor(Date.now() / 1000) - 10 })),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 401, error: 'invalid_grant' }))),
    )

    const p = useWithings()
    await expect(p.syncWeight()).rejects.toThrow(/reconnect in Settings/)
    expect(p.state.connected).toBe(false)
    expect(localStorage.getItem('walkfit.withings')).toBeNull()
  })

  it('a transient proxy failure does NOT destroy the token pair (#57)', async () => {
    const stored = tokens({ expiresAt: Math.floor(Date.now() / 1000) - 10 })
    localStorage.setItem('walkfit.withings', JSON.stringify(stored))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    )

    const p = useWithings()
    await expect(p.syncWeight()).rejects.toThrow(/will retry/)
    expect(p.state.connected).toBe(true)
    expect(JSON.parse(localStorage.getItem('walkfit.withings')!)).toEqual(stored) // pair intact
  })

  it('re-reads tokens rotated by another tab before giving up (#57)', async () => {
    localStorage.setItem(
      'walkfit.withings',
      JSON.stringify(tokens({ expiresAt: Math.floor(Date.now() / 1000) - 10 })),
    )
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (!String(url).includes('/refresh')) {
        return new Response(JSON.stringify({ status: 0, body: { measuregrps: [grp()] } }))
      }
      const body = JSON.parse(String(init!.body ?? '{}'))
      if (body.refresh_token === 'rt-old') {
        // simulate the race: another tab rotated the pair while we refreshed
        localStorage.setItem(
          'walkfit.withings',
          JSON.stringify({
            accessToken: 'at-tab2',
            refreshToken: 'rt-tab2',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          }),
        )
        return new Response(JSON.stringify({ status: 401, error: 'invalid_grant' }))
      }
      return new Response(JSON.stringify({ status: 0, body: { measuregrps: [grp()] } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const p = useWithings()
    const { entries } = await p.syncWeight()
    expect(entries).toHaveLength(1) // recovered using the other tab's fresh pair
    expect(p.state.connected).toBe(true)
    expect(JSON.parse(localStorage.getItem('walkfit.withings')!).refreshToken).toBe('rt-tab2')
    // the measure call used the other tab's still-valid access token
    const measureCall = fetchMock.mock.calls.find(([u]) => String(u).includes('measure'))!
    expect((measureCall[1]!.headers as Record<string, string>).Authorization).toBe('Bearer at-tab2')
  })
})

describe('page-cap cursor (#139)', () => {
  it('a capped fetch resumes from the oldest fetched timestamp, not the newest', async () => {
    localStorage.setItem(
      'walkfit.withings',
      JSON.stringify({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
    // every page reports more data remaining -> the 50-page cap trips
    const fetchMock = vi.fn(async () => ({
      json: async () => ({
        status: 0,
        body: {
          measuregrps: [
            grp({ grpid: 1, date: 1783926000, modified: 1783926000 }),
            grp({ grpid: 2, date: 1783839600, modified: 1783839600 }),
          ],
          more: 1,
          offset: 123,
        },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { syncWeight } = useWithings()
    const res = await syncWeight()
    expect(fetchMock).toHaveBeenCalledTimes(50)
    // cursor = OLDEST modified so the next sync continues the backfill
    expect(res.cursor).toBe(1783839600 * 1000)
  })
})
