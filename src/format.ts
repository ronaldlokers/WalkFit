// Shared display formatting helpers.

// Seconds → "mm:ss" (floored, clamped at zero).
export function mmss(sec: number): string {
  sec = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
}
