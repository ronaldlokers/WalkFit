// Pure, framework-free protocol helpers for the Dreaver / FitShow treadmill and
// standard BLE heart rate. No Web Bluetooth or Vue here so it's unit-testable.

export type Bytes = Uint8Array | number[]

export type TelemetryEvent =
  | { type: 'speed'; speed: number; steps?: number }
  | { type: 'status'; running: boolean }
  | { type: 'stop' }

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

// Sport-data query: a second FitShow read query family (0x52, "SPORT_DATA") seen in
// other FitShow clients. It's meant to return the full running-data frame — time,
// distance, calories, and the pedometer step count the belt shows on its display, which
// the 0x51 status frame parsed here does not yet expose. Read-only (the 0x53 family is
// the control channel), so safe to poll. Used only by the step-capture debug path.
export const SPORT_DATA_QUERY = frame([0x52, 0x00])

// Parse an fff1 notification (Uint8Array or number[]) into a typed event, or null.
export function parseTelemetry(b: Bytes): TelemetryEvent | null {
  if (b.length < 4 || b[0] !== 0x02) return null
  if (b[1] === 0x53) {
    if (b[2] === 0x02) return { type: 'speed', speed: b[3] / 10 } // + phantom 2x frame
    if (b[2] === 0x01) return { type: 'status', running: b[3] === 0x00 }
    if (b[2] === 0x03) return { type: 'stop' }
    return null
  }
  if (b[1] === 0x51 && b[2] === 0x03) {
    const ev: TelemetryEvent = { type: 'speed', speed: b[3] / 10 }
    // The running-data variant is a 17-byte frame: 02 51 03 <spd> <incline> then four
    // uint16 LE counters the belt keeps and shows on its display —
    //   [5..6] steps   [7..8] distance (m)   [9..10] calories   [11..12] time (s)
    // — [13..14] reserved, [15] xor, [16] 03. Offsets confirmed against on-device capture
    // (a "100 steps" checkpoint landed exactly on [5..6] === 100). Only steps is surfaced
    // for now (#43); the distance/calories/time offsets are documented for later, since the
    // app currently derives those client-side. The shorter 02 51 03 response carries only
    // speed, so gate on the full 17-byte length.
    if (b.length >= 17) ev.steps = b[5] | (b[6] << 8)
    return ev
  }
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
