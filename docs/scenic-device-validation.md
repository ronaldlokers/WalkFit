# Scenic device validation

Last audited: 2026-08-09

The scenic renderer has automated coverage for its tier decisions and a real-GPU desktop
smoke check. Mobile Safari/Bluefy and an active treadmill session still require physical
hardware that is not available in the development environment. This document separates the
completed checks from that hardware-only validation so the remaining claim is exact.

## Completed desktop check

The production UI was exercised in Chromium 150 at 1440 x 900 on the host GPU:

- GPU: Intel Iris Xe Graphics, Alder Lake-P GT2
- WebGL renderer: `ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2), OpenGL ES 3.2)`
- explicit `low`, `high`, and `ultra` tiers rendered at the full 1440 x 900 canvas size
- `auto` rendered successfully and sustained a 16.7 ms median frame interval
- `low`, `high`, and `ultra` each sustained a 16.7 ms median frame interval; sampled p95 was
  16.8 ms or better
- day frames were inspected at every tier; night frames were inspected at `high` and `ultra`
- clouds, tier-dependent grass density, the ultra post-process, stars, track markings, and the
  overlaid controls were visible; no browser console or page errors occurred

This confirms that the desktop tier paths run on a physical GPU rather than Playwright's
SwiftShader. It is a smoke check, not a long-duration thermal benchmark.

The normal repository gates also pass: formatting, lint, type checking, 310 unit tests,
production build, bundle-size guard, and 11 Playwright tests.

## Physical-hardware blocker

The following claims cannot be validated from this machine because it has no iPhone/iPad and
no Dreaver Motion One available to the browser:

1. Mobile WebGL frame pacing and thermal behaviour in Bluefy on iOS.
2. HUD readability while the phone is mounted at treadmill viewing distance.
3. Rendering while live BLE telemetry advances distance and speed for a sustained walk.
4. WebGL recovery after an actual mobile-browser background/foreground cycle.

No code or CI change can remove that boundary; a person with the devices must perform the
matrix below.

## Required device matrix

Run a 20-minute walk on the real treadmill in Bluefy on a current iPhone, then repeat the
short checks on a desktop Chromium browser with the treadmill connected.

| Check                                                              | iPhone / Bluefy | Desktop Chromium             |
| ------------------------------------------------------------------ | --------------- | ---------------------------- |
| Auto starts without a black frame or 2D fallback                   | Required        | Completed on Iris Xe         |
| Performance, Quality, then Auto switch live                        | Required        | Required with live BLE       |
| Day, sunset, and night keep HUD text readable                      | Required        | Required at viewing distance |
| Distance moves the camera continuously for 20 minutes              | Required        | Required                     |
| No obvious sustained stutter, context loss, or overheating warning | Required        | Required                     |
| Background for 10 seconds, return, and continue rendering          | Required        | Optional                     |

Do not enable Ultra on the phone; it is an explicitly opt-in desktop tier. On desktop, also
switch to Ultra for two minutes and confirm bloom/colour grading appears without a black frame.

Record the device model, OS/browser version, selected tier, approximate DPR/resolution, and any
failure with a screenshot or screen recording. A failure should include the browser console when
available and whether switching to Performance recovers the view.
