// Pure, framework-free protocol helpers for the Dreaver / FitShow treadmill and
// standard BLE heart rate. No Web Bluetooth or Vue here so it's unit-testable.

// Device speed limits (from the FTMS supported-speed range 2ad4). Live here — the
// pure, import-free hub — so treadmill.ts and demo.ts can share them without a cycle.
export const SPEED_MIN = 1.0 // km/h
export const SPEED_MAX = 6.0 // km/h
export const SPEED_STEP = 0.1

export type Bytes = Uint8Array | number[]

export type TelemetryEvent =
  | {
      type: 'speed'
      speed: number
      steps?: number
      beltDistance?: number // metres, the belt's own session counter
      beltKcal?: number
      beltTime?: number // seconds
    }
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
// The XOR checksum the framing defines is verified (#61): a corrupted low speed byte
// would otherwise feed the min-filter and pin displayed speed (and the distance
// integration) wrong for a whole ~1.6s window. Every frame shape captured on-device —
// idle, countdown, status, stop, the phantom-2x speed frame, and the 17-byte running
// frame — carries a valid checksum, so rejection only ever drops genuine corruption.
export function parseTelemetry(b: Bytes): TelemetryEvent | null {
  if (b.length < 4 || b[0] !== 0x02 || b[b.length - 1] !== 0x03) return null
  let ck = 0
  for (let i = 1; i < b.length - 2; i++) ck ^= b[i]!
  if (ck !== b[b.length - 2]) return null
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
    if (b.length >= 17) {
      ev.steps = b[5]! | (b[6]! << 8)
      // the belt's own session counters (#66) — they survive a page reload on our side
      ev.beltDistance = b[7]! | (b[8]! << 8)
      ev.beltKcal = b[9]! | (b[10]! << 8)
      ev.beltTime = b[11]! | (b[12]! << 8)
    }
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
