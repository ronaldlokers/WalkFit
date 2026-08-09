import { describe, expect, it } from 'vitest'
import { ambientProfile } from './scenicAudio'

describe('scenic ambient audio profiles', () => {
  it('prioritises weather over time of day', () => {
    expect(ambientProfile(0.45, 'mist').kind).toBe('rain')
    expect(ambientProfile(0.45, 'overcast').kind).toBe('rain')
  })

  it('switches between dawn/day birds and night crickets', () => {
    expect(ambientProfile(0.03, 'clear').kind).toBe('crickets')
    expect(ambientProfile(0.4, 'clear').kind).toBe('birds')
    expect(ambientProfile(0.9, 'clear').kind).toBe('crickets')
  })
})
