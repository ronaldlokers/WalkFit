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
  it('converts value x 10^unit to kg and unix date to ISO', () => {
    expect(parseWeighIns([grp()])).toEqual([
      { date: '2026-07-13T07:00:00.000Z', kg: 82.4, source: 'withings' },
    ])
  })
  it('handles other unit exponents', () => {
    expect(parseWeighIns([grp({ measures: [{ value: 8240, unit: -2, type: 1 }] })])[0]!.kg).toBe(
      82.4,
    )
    expect(parseWeighIns([grp({ measures: [{ value: 82, unit: 0, type: 1 }] })])[0]!.kg).toBe(82)
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

    const entries = await useWithings().syncWeight()
    expect(entries).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://wbsapi.withings.net/measure')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer at-old')
    expect(String(init!.body)).toContain('action=getmeas')
    expect(String(init!.body)).not.toContain('lastupdate') // no cursor -> full history
  })

  it('sends the incremental cursor once a last sync exists', async () => {
    localStorage.setItem('walkfit.withings', JSON.stringify(tokens()))
    localStorage.setItem('walkfit.health.lastSync.withings', '1783926000000')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(measureEnvelope)))
    vi.stubGlobal('fetch', fetchMock)

    await useWithings().syncWeight()
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain('lastupdate=1783926000')
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

    const entries = await useWithings().syncWeight()
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
})
