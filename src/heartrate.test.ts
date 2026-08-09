import { describe, expect, it } from 'vitest'
import { estimateMaxHr } from './heartrate'

describe('estimateMaxHr', () => {
  it('uses the rounded Tanaka estimate for plausible ages', () => {
    expect(estimateMaxHr(40)).toBe(180)
    expect(estimateMaxHr(65)).toBe(163)
  })

  it('rejects implausible ages', () => {
    expect(estimateMaxHr(0)).toBeNull()
    expect(estimateMaxHr(101)).toBeNull()
    expect(estimateMaxHr(NaN)).toBeNull()
  })
})
