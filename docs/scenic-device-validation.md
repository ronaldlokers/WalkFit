# Scenic v3 device validation

This is the manual release gate for Scenic v3. Run it against a production build served
from the deployed PWA (not Vite's development server), with the treadmill controls still
available in the same browser tab.

## Matrix

| Device / browser                              | Quality           | Camera modes  | Motion       | Network                       | Required result                                                                                |
| --------------------------------------------- | ----------------- | ------------- | ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Desktop with Intel Iris Xe or newer, Chromium | auto, high, ultra | first + third | on + reduced | online                        | stable mount, no context loss, route HUD and checkpoint visible                                |
| Mid-range Android Chromium                    | auto, low         | first + third | on + reduced | online                        | no blank frame, controls remain responsive, no sustained memory growth                         |
| iPhone/iPad Safari or Bluefy                  | auto, low         | first + third | on + reduced | online                        | 20-minute walk remains interactive; graceful 2D fallback is acceptable if WebGL is unavailable |
| Any supported device                          | low               | first         | on           | offline after one online load | PWA starts, scenic chunk and manifest are available, procedural fallback remains usable        |

## Procedure

1. Start from a clean profile, open the deployed app, complete onboarding, and open 3D.
2. Exercise the first/third-person toggle, outfit picker, reduced-motion setting, and each
   quality tier. Confirm the header, route ribbon, stop/pause/reset controls, and live stats
   never become unreachable behind the scenic HUD.
3. Walk at least 20 minutes on desktop and iPhone/Bluefy. Capture a screenshot at the
   stadium hub, park gate, pond checkpoint, and overlook. Record browser console errors,
   approximate FPS, and whether the GLB request succeeded or the procedural fallback was
   used.
4. Reload while walking, background the tab for 30 seconds, return, and exercise a WebGL
   context-loss/recovery if the browser exposes the test hook. The session snapshot, route
   HUD, and controls must recover without a blank view.
5. With the app loaded once, enable airplane/offline mode and reload. Confirm the app shell,
   lazy scenic chunk, manifest, and both licensed GLBs are served by the installed PWA.
6. Export a JSON backup, clear the profile in a disposable browser context, import the file,
   and verify progression XP, route badges, personal bests, outfit choice, and settings return.

## Acceptance thresholds

- No uncaught page errors during any matrix row.
- The main bundle remains under the repository guard; Three.js stays in the lazy scenic chunk.
- Low tier stays responsive on the phone path; high/ultra may reduce detail only through the
  documented quality budgets.
- A failed manifest, GLB, or WebGL probe leaves the 2D track and safety controls usable.
- No progression reward depends on speed above the user's selected workout target or on an
  incline command the treadmill protocol does not support.

Record date, device/browser, commit, quality, camera, FPS impression, and pass/fail in the
release issue before calling the physical-device gate complete.
