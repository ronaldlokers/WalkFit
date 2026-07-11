import { describe, it, expect } from 'vitest'
import {
  checksum, frame, setSpeedFrame, STATUS_QUERY,
  parseTelemetry, createSpeedFilter, parseHeartRate,
} from './protocol.js'

const hex = a => Array.from(a, x => x.toString(16).padStart(2, '0')).join(' ')

describe('framing', () => {
  it('xor checksum over the inner bytes', () => {
    expect(checksum([0x53, 0x02, 0x14])).toBe(0x45)   // 53^02^14
    expect(checksum([0x51, 0x03, 0x00])).toBe(0x52)
  })

  it('wraps inner bytes as 02 <inner> <ck> 03', () => {
    expect(hex(frame([0x53, 0x02, 0x14]))).toBe('02 53 02 14 45 03')
  })

  it('set-speed frame encodes km/h x10 (confirmed on-device: 2.0 -> 14)', () => {
    expect(hex(setSpeedFrame(2.0))).toBe('02 53 02 14 45 03')
    expect(hex(setSpeedFrame(1.0))).toBe('02 53 02 0a 5b 03')
    expect(hex(setSpeedFrame(2.5))).toBe('02 53 02 19 48 03')
  })

  it('status query is a valid framed 02 51 03 00', () => {
    expect(hex(STATUS_QUERY)).toBe('02 51 03 00 52 03')
  })
})

describe('parseTelemetry', () => {
  it('decodes a speed frame (km/h x10)', () => {
    expect(parseTelemetry([0x02, 0x53, 0x02, 0x19, 0x00, 0x48, 0x03]))
      .toEqual({ type: 'speed', speed: 2.5 })
  })
  it('decodes the running-data frame variant (02 51 03)', () => {
    expect(parseTelemetry([0x02, 0x51, 0x03, 0x0a, 0x00, 0x74])).toEqual({ type: 'speed', speed: 1.0 })
  })
  it('status: 00 = running, 03 = idle (must not be treated as speed)', () => {
    expect(parseTelemetry([0x02, 0x53, 0x01, 0x00, 0x52, 0x03])).toEqual({ type: 'status', running: true })
    expect(parseTelemetry([0x02, 0x53, 0x01, 0x03, 0x51, 0x03])).toEqual({ type: 'status', running: false })
  })
  it('rejects malformed / non-frame input', () => {
    expect(parseTelemetry([0x00, 0x53, 0x02, 0x19])).toBeNull()
    expect(parseTelemetry([0x02, 0x99])).toBeNull()
  })
})

describe('createSpeedFilter (phantom 2x rejection)', () => {
  it('reports the real speed, discarding the interleaved 2x frame', () => {
    const f = createSpeedFilter(1600)
    // real 2.5 (0x19) alternating with phantom 5.0 (0x32)
    expect(f.push(2.5, 1000)).toBe(2.5)
    expect(f.push(5.0, 1300)).toBe(2.5)   // phantom ignored — min stays 2.5
    expect(f.push(2.5, 1600)).toBe(2.5)
    expect(f.push(5.0, 1900)).toBe(2.5)
  })

  it('tracks a genuine ramp up as old low samples age out of the window', () => {
    const f = createSpeedFilter(1000)
    expect(f.push(1.0, 0)).toBe(1.0)
    expect(f.push(2.5, 500)).toBe(1.0)    // 1.0 still in window
    expect(f.push(2.5, 1600)).toBe(2.5)   // 1.0 aged out (>1000ms) -> min is 2.5
  })

  it('reset() and a 0 reading clear the window', () => {
    const f = createSpeedFilter(1600)
    f.push(3.0, 0)
    expect(f.push(0, 100)).toBe(0)
    expect(f.push(4.0, 200)).toBe(4.0)    // window was cleared by the 0
  })
})

describe('parseHeartRate (0x2A37)', () => {
  it('uint8 format when flags bit0 = 0', () => {
    expect(parseHeartRate([0x00, 72])).toBe(72)
  })
  it('uint16 LE format when flags bit0 = 1', () => {
    expect(parseHeartRate([0x01, 0x2c, 0x01])).toBe(300)   // 0x012c
  })
})
