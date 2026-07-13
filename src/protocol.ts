// Pure, framework-free protocol helpers for the Dreaver / FitShow treadmill and
// standard BLE heart rate. No Web Bluetooth or Vue here so it's unit-testable.

export type Bytes = Uint8Array | number[]

export type TelemetryEvent =
  { type: 'speed'; speed: number } | { type: 'status'; running: boolean } | { type: 'stop' }

export interface SpeedFilter {
  push(v: number, now: number): number
  reset(): void
}

// --- FitShow vendor framing: 02 <inner...> <xor(inner)> 03 ---
export function checksum(inner: number[]): number {
  return inner.reduce((a, b) => a ^ b, 0)
}
export function frame(inner: number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0x02, ...inner, checksum(inner), 0x03])
}

// Set target speed (km/h) -> vendor write frame. speed encoded as km/h x10.
export function setSpeedFrame(kmh: number): Uint8Array<ArrayBuffer> {
  return frame([0x53, 0x02, Math.round(kmh * 10)])
}

// Status query: the FW doesn't stream running data unprompted; writing this to
// fff2 elicits a running-data frame. Belt speed is unaffected.
export const STATUS_QUERY = frame([0x51, 0x03, 0x00])

// Parse an fff1 notification (Uint8Array or number[]) into a typed event, or null.
export function parseTelemetry(b: Bytes): TelemetryEvent | null {
  if (b.length < 4 || b[0] !== 0x02) return null
  if (b[1] === 0x53) {
    if (b[2] === 0x02) return { type: 'speed', speed: b[3] / 10 } // + phantom 2x frame
    if (b[2] === 0x01) return { type: 'status', running: b[3] === 0x00 }
    if (b[2] === 0x03) return { type: 'stop' }
    return null
  }
  if (b[1] === 0x51 && b[2] === 0x03) return { type: 'speed', speed: b[3] / 10 }
  return null
}

// The FW interleaves a phantom `02 53 02` frame at exactly 2x the real speed. The
// real value is always the smaller of the pair, so report the MIN over a short
// window. Stateful; call push() per reading with a monotonic timestamp (ms).
export function createSpeedFilter(windowMs = 1600): SpeedFilter {
  let win: { v: number; t: number }[] = []
  return {
    push(v, now) {
      if (v === 0) {
        win = []
        return 0
      }
      win.push({ v, t: now })
      win = win.filter((e) => now - e.t < windowMs)
      return Math.min(...win.map((e) => e.v))
    },
    reset() {
      win = []
    },
  }
}

// Heart Rate Measurement (0x2A37): flags bit0 selects uint8 vs uint16 LE.
export function parseHeartRate(b: Bytes): number {
  return b[0] & 0x01 ? b[1] | (b[2] << 8) : b[1]
}
