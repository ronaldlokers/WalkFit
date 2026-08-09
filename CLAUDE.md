# WalkFit

Vue 3 + Vite web app control **Dreaver Motion One** walking treadmill (FitShow
`FS-BT-T4` OEM controller) from browser over **Web Bluetooth**, virtual 400 m athletics-track
loop, guided weight-loss and HR-steered workouts, optional heart-rate display.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

Needs Chromium browser (Web Bluetooth). `localhost` secure context (no HTTPS needed).
**On Linux, Chrome hides Web Bluetooth behind flag:** enable
`chrome://flags/#enable-experimental-web-platform-features`, relaunch, else
`navigator.bluetooth` is `undefined`.

`.devcontainer/` (devpod/neovim) uses plain `debian:trixie` plus features: common-utils
creates `dev` user (uid 1000, sudo, zsh) same way upstream base-debian image
creates `vscode` — don't switch to prebuilt devcontainer image and rename its user, breaks
feature `_REMOTE_USER` resolution and sudoers. Git and mise come from features; node
comes from mise (repo `mise.toml` single version pin, container and host); neovim
comes from mise via dotfiles. `post-create.sh` installs deps, Playwright's
chromium (for e2e, matching CI), and Chrome for Testing (`chrome` on PATH) for interactive
Web Bluetooth debugging — host's BlueZ D-Bus socket bind-mounted (Linux hosts only),
so Chrome inside container reach real hardware. **Screenshot baselines must NOT get
regenerated inside devcontainer** — Debian fonts differ from CI image; use docker
command below.

Every new interactive shell in container auto-attach to `walkfit` tmux session
(`scripts/tmux-dev.sh`, wired in via block `post-create.sh` appends to `~/.zshrc`): left
pane runs `claude --dangerously-skip-permissions --continue`, top-right pane runs
`npm run dev`, bottom-right pane runs `lazygit`. Guarded by `$TMUX` so panes opened from
inside that session don't recurse.

```bash
npm test           # Vitest (run once)
npm run test:watch
npm run typecheck  # vue-tsc --build (src/, e2e/) + tsc -p oauth-proxy (checkJs worker)
npm run lint       # ESLint (flat config, Vue + typescript-eslint)
npm run format     # Prettier --write   (format:check in CI)
```

Codebase is TypeScript (strict, via `@vue/tsconfig`): `tsconfig.app.json` covers `src/`
(types `vite/client` + `@types/web-bluetooth`), `tsconfig.node.json` the config files and
`e2e/`. Extensionless relative imports (`from './protocol'`) — `vi.mock` specifiers must
match. `src/vite-env.d.ts` declares the `VITE_STRAVA_*` env vars and `webkitAudioContext`.

CI (`.github/workflows/ci.yml`) runs lint → format:check → typecheck → test → build →
bundle-size guard (`scripts/check-bundle-size.mjs` — fails if the main chunk exceeds
250 kB, i.e. if three.js ever gets imported statically) on
PRs; deploy workflow gates on tests too. Tests: `src/protocol.test.ts` (framing/checksum,
phantom-2x speed filter, telemetry + HR parsing), `src/workouts.test.ts`, `src/statistics.test.ts`,
`src/App.happy.test.ts` (jsdom + @vue/test-utils happy-path: wizard → walk/workout flows),
and `src/App.hrWorkout.test.ts` (mocks both `treadmill.ts`/`heartrate.ts` composables to
drive `state.elapsed`/`bpm` directly — verifies nudge direction, the 20s rate limit, that it
stays silent while the belt isn't running, that it ends itself on HR disconnect, the
Light target's 90–113 bpm range, and that the header button opens the weight-loss tab).
`test/setup.js` polyfills `localStorage`; component test files opt into jsdom with a
`// @vitest-environment jsdom` docblock.

Formatting Prettier (no semicolons, single quotes, width 100). Note: Prettier splits long
inline template handlers across lines, breaks multi-statement `@click="a; b"` — use
method instead of inline multi-statement handlers.

**E2E / visual (Playwright):** `npm run e2e` (spec in `e2e/`, config `playwright.config.ts`).
One smoke spec: loads app, asserts wizard + walk flow, and `toHaveScreenshot`
baseline. Baselines (`e2e/*-snapshots/*.png`) committed, MUST get generated in same
container CI uses, else font differences fail diff:

```bash
# regenerate baselines to match CI (Playwright pinned to 1.62.1)
docker run --rm -v "$PWD":/work -w /work -e CI=1 mcr.microsoft.com/playwright:v1.62.1-noble \
  bash -c "npm ci && npm run e2e:update"
```

`E2E` workflow runs `npm run e2e` inside `mcr.microsoft.com/playwright:v1.62.1-noble`.
Keep pinned Playwright version and image tag in sync.

## Layout

- `src/protocol.ts` — **pure, framework-free** protocol logic (framing/checksum, set-speed frame,
  telemetry parse, phantom-2x speed filter, HR parse). Unit-tested in `src/protocol.test.ts`.
- `src/treadmill.ts` — `useTreadmill()` composable: Web Bluetooth connection wiring around
  `protocol.ts` (connect, start/stop, set speed, distance/time integration, auto-reconnect).
- `src/demo.ts` — demo mode (#169): simulated belt + HR strap behind the same composable
  interfaces plus the canonical seed fixture (`SPEED_*` consts live in protocol.ts so
  this file imports cycle-free). README screenshots are generated against it.
- `src/heartrate.ts` — `useHeartRate()` composable: standard BLE Heart Rate Service (`0x180D`).
- `src/workouts.ts` — weight-loss workout presets (segments of `{speed, minutes}`),
  `workoutStats`, `timeline`, `metForSpeed` (MET-based kcal estimate, also used for live
  session kcal), `hrTargetRange` (steer target → bpm range, shared by App.vue and
  WorkoutPicker.vue), and the shared `Workout`/`Segment`/`HrTarget` types (SFCs can't
  export types, so App.vue's HR_TARGETS shape lives here).
- `src/statistics.ts` — completed-session log persisted to `localStorage` (key stays
  `walkfit.history` for backward compat): `Session` type (optional `steps`/`hrMin`/`hrMax`
  are absent on pre-#43 logs — readers must null-guard), `addSession`, `loadStatistics`,
  `weeklyTotals` (ISO-week rollups), `dailyTotals` (zero-filled per-local-day buckets for
  the activity rings / daily charts), `currentStreak`, and the daily `Goals`
  (`walkfit.goals`, defaults 500 kcal / 8000 steps / 30 min, editable in Settings).
  Unit-tested in `src/statistics.test.ts`.
- `src/weight.ts` — weigh-in log (`walkfit.weight.log`, issue #16): `WeightEntry`
  (`date`/`kg`/`source`), `mergeWeighIns` (idempotent on `source+date` so provider
  re-syncs never duplicate; same-key overwrites = corrected readings). Unit-tested in
  `src/weight.test.ts`. The newest entry drives `weightKg` (the kcal-estimate weight).
- `src/health.ts` — `HealthProvider` interface + `syncProvider`/lastSync helpers for
  weigh-in sync services. See "Health sync" below.
- `src/withings.ts` — `useWithings()`: the first `HealthProvider` (Withings scale).
  Unit-tested in `src/withings.test.ts` (envelope, measure parsing, refresh rotation).
- `src/strava.ts` — `useStrava()` composable: OAuth2 connect + per-session upload. See
  "Strava upload" below.
- `src/format.ts` — shared display formatting (`mmss`), used by App.vue and the sheet
  components instead of per-component copies.
- `src/WorkoutPicker.vue` — the tabbed weight-loss/HR workout picker, shared verbatim
  between the wizard's step 4 and the header's workout menu (see "Workouts" below).
- `src/StatisticsSheet.vue` — the statistics sheet (activity rings, daily/weekly charts,
  weight trend + manual weigh-in input); props `sessions`/`weightLog`/`goals`, emits
  `close`/`weigh-in` — App.vue keeps the overlay wrapper and owns the logs.
- `src/SettingsSheet.vue` — the settings sheet; composables passed through as props
  (`tm`/`hr`/`strava`/`providers`), primitives via `defineModel`, emits
  `close`/`weight-changed`/`sync-provider` — App.vue keeps the overlay wrapper.
- `src/scenic.ts` — **pure, framework-free** world model for the 3D scenic walk (the
  400 m stadium-loop geometry, surroundings, day/night). Unit-tested in
  `src/scenic.test.ts`. See the scenic paragraph below.
- `src/Scenic3D.vue` — the three.js first/third-person scenic renderer; async component, so
  three.js lives in a lazy chunk (see below).
- `src/scenicSky.ts` — day/night cycle, weather, palette, and `skyBodies()` (sun/moon
  azimuth+elevation, star opacity), split out of `scenic.ts`. The sun's elevation curve is
  piecewise, anchored so it crosses the horizon at `NIGHT_DAWN_EDGE` and `SUN_SET_PHASE` —
  a plain cosine once put the sun 68 deg underground at the dawn preset. Star opacity ramps
  inside the night band's own edges so a risen sun never sits over visible stars. Weather
  desaturates toward each colour's own luminance rather than a fixed grey, or a misty night
  comes out brighter than a clear day. Peak sun elevation is ~50 deg, NOT overhead: at the
  original 76 deg midday shadows were a quarter of an object's height and the whole scene
  rendered flat and unmodelled. It also owns the light response of everything three.js will
  NOT shade — `daylight(phase)` (0..1 from the sun's elevation, not `sunIntensity`, which
  ramps toward the pre-dawn keyframe while the sun is still underground), and the three
  consumers built on it: `cloudColor` (an unlit cloud shell tinted to exactly `sky.sky` is
  invisible by day), `backdropTint` (the treeline ring stayed daytime green under a night
  sky), and `paintLevel` (lane lines, markings, signs, lane numbers, fence and flags are all
  unlit `MeshBasic`, so without it they are exactly as bright at midnight as at noon —
  floodlight heads are deliberately excluded, being lamps rather than paint). Unit-tested in
  `src/scenicSky.test.ts`.
- `src/scenicQuality.ts` — adaptive quality tiers `low` / `high` / `ultra`, with
  `walkfit.scenic.quality` overriding the probe. Gates texture size, star count, clouds,
  the shadow map (size AND box half-width — ultra buys texels per metre, 4096 over a 40 m
  box against 2048 over 60 m, which is what puts a crisp edge on a contact shadow without
  CSM having to rewrite every material), derived normal maps, contact shading, the tuft
  count and the post chain. Every tier path must work in BOTH directions — enabling and
  disabling — or picking Performance buys neither the saving nor the fallback. The
  median-of-60-frames probe deliberately tops out at `high`: vsync clamps frame time near
  16.7 ms however much headroom the GPU has, so it cannot tell "can afford a fullscreen
  post pass" from "exactly at 60 Hz". **Ultra is opt-in from Settings only**, and is
  desktop-only by intent — a fullscreen pass at DPR 3 is the first thing that costs a
  phone frames rather than watts.
- `src/scenicMeshes.ts` — pure vertex/uv/index array builders plus the three.js mesh and
  procedural `CanvasTexture` factories, extracted from `Scenic3D.vue`. Every `REPEAT` value
  must divide `LAP_M` exactly, or the texture misaligns with itself at the start/finish seam.
  `assertSameAttributes` rejects a merge batch that mixes indexed and non-indexed geometry as
  well as one with mismatched attributes — three's own primitives disagree (`PlaneGeometry`
  is indexed, `IcosahedronGeometry` is not) and the only symptom is `mergeGeometries`
  returning null. Tree crowns are crossed alpha-tested billboards (`canopyTexture`), not
  solid meshes: a convex crown reads as a faceted ball from every angle, and the ragged
  outline is the whole difference. Because those cards are `DoubleSide`, they must be listed
  in the component's `castsDespiteTwoSided` set — the bake reads `side === DoubleSide` as
  "flat ground marking, must not cast", which silently stopped every tree casting a shadow.
  `treeLineTexture` fills the band between fence and skyline; its crowns are drawn tall in v
  and narrow in u because the ring is ~1000 m around and only 26 m high, and its `wrapT` must
  be `ClampToEdgeWrapping` or the opaque ground band at the texture's base bleeds across the
  seam as a dark hairline around the sky.
- `src/scenicLife.ts` — **pure, three.js-free** (must stay that way so App.vue COULD import
  it directly — a three import here would drag three.js out of Scenic3D.vue's lazy chunk
  and into the main bundle): ambient `pacers(t, count)` whose positions are analytic in
  elapsed time rather than accumulated, `strideLength`/`stepPhase`/`gaitCycleM`/`cadenceHz`
  (cadence is MEASURED from the belt's own pedometer via `state.steps`, not modelled —
  `gaitCycleM` converts a footfall's `strideLength` into the two-footfall period `stepPhase`
  actually swings limbs over), `paceGap`, and `cameraMotion` (bob/sway/roll/FOV, phased
  off walked distance, sharing the same `gaitCycleM` cadence the limbs use — the bob is
  twice the gait frequency, the sway exactly it). Unit-tested in `src/scenicLife.test.ts`.
- `src/scenicPlayer.ts` — **pure and independent from the world model**; persisted Scenic v3
  camera/outfit choices and their renderer configuration. Settings imports its outfit list at
  runtime, so importing `scenic.ts` here would unnecessarily pull the world model into the main
  bundle. Unit-tested in `src/scenicPlayer.test.ts`.
- `src/scenicAssets.ts` — Scenic v3 asset-manifest policy and tier selection. Actual files live
  under `public/scenic/`; every binary needs exact bytes, triangle count, source, attribution and
  an accepted licence in `manifest.json`. `npm run assets:check` enforces the manifest/files and
  CI runs it. The PWA precache includes GLB/WebP/KTX2/Ogg; see
  `docs/scenic-v3-art-direction.md` before importing art.
- `src/scenicVenue.ts` — **pure, three.js-free** club-track furniture: `stadium()` returns
  parts in the same shape `surroundings()` uses, so the component's prop builder and
  merge-by-material bake absorb them unchanged. `PART_SIZES` is the single source of truth
  for part footprints — the renderer builds meshes to it and `scenicVenue.test.ts` checks
  those same numbers against the kerb, so a resize can't pass the test while changing what
  is drawn; the grandstand's across-track depth lives there specifically because it's a
  renderer-side dimension no other test could see, and it once overhung the fence by 1.2 m
  so the netting ran underneath the terracing. Nothing may sit between `TRACK_IN` and
  `TRACK_OUT` (the running lanes) — a test pins it. The infield footprint check is
  axis-aligned (width across the track, length along it), so it's only valid for parts
  centred on a straight — it would silently stop being correct for a part on a bend arc.
  The fence's chain-link `u` repeat must divide `LAP_M` exactly (4 m/repeat, 400/4 = 100) or
  it misaligns where the loop closes; its gate is cut by skipping index emission, not
  vertices, so u continuity across the seam survives. Unit-tested in
  `src/scenicVenue.test.ts`.
- `src/App.vue` — the rest of the UI: loop, chart, controls,
  header live-stat strip (time/distance/kcal/speed/pace — real zeros faded while idle),
  header overflow menu, onboarding wizard; the statistics and settings sheets live in
  their own components now (`StatisticsSheet.vue` / `SettingsSheet.vue`), App.vue keeps
  their overlay wrappers, open-state refs, and the persisted state. Below 900px it's a
  single 460px column; at ≥900px a pure-CSS two-column grid (visual left, controls +
  chart right), the stat strip moves inline into the header row, and sheets center as
  640px dialogs instead of bottom sheets — template order is identical in both layouts.
- `src/main.ts`, `src/style.css` — bootstrap + global styles/theme vars (`--accent`), plus
  the base `.btn` family — kept unscoped/global (not in `App.vue`'s `<style scoped>`)
  specifically so `WorkoutPicker.vue`'s buttons pick it up too; scoped styles don't cross
  component boundaries. `main.ts` also registers the offline service worker (#150,
  `vite-plugin-pwa` configured in `vite.config.ts` with `manifest: false` — the
  hand-authored `public/manifest.webmanifest` stays the one source of truth for icons/
  install metadata; the plugin only owns precaching + the SW itself) — production-only
  (`import.meta.env.PROD`), precaches every built asset including the lazy
  Scenic3D/three.js chunk, so the 3D view works offline too, not just a 2D fallback.

Treadmill and HR two independent GATT devices; each needs own user-gesture connect
first time. Both composables expose `autoConnect()` (called on mount) which silently
reconnects to previously-granted device via `navigator.bluetooth.getDevices()` (no picker),
with 8s timeout so off/out-of-range device doesn't hang UI.

Session logged to statistics when `state.running` goes true→false and covered at least
50 m (filters accidental starts) — fires both on explicit Stop and on belt's own
staleness-timeout auto-stop, so doesn't matter which one ends walk. If Strava connected,
same transition opens the upload-prompt popup.

`localStorage` keys: `walkfit.lang` (`en` default | `nl` — src/i18n.ts, hand-rolled
typed key table; `t()` interpolates `{param}`s, `localeTag()` feeds SpeechSynthesis +
date formatting), `walkfit.treadmill.id`, `walkfit.hr.id` (remembered device ids),
`walkfit.maxhr`, `walkfit.weight`, `walkfit.audio`, `walkfit.debug`, `walkfit.setupDone`,
`walkfit.history`,
`walkfit.goals` (daily activity goals), `walkfit.weight.goal`, `walkfit.workouts.custom` (user-built plans), `walkfit.session.inprogress` (mid-walk
snapshot — reload resumes the session), `walkfit.weight.log` (weigh-ins),
`walkfit.strava` / `walkfit.withings` (OAuth tokens), `walkfit.strava.autoUpload`, `walkfit.health.lastSync.<provider>`
(display-only last-sync times), `walkfit.health.cursor.<provider>` (server-derived
incremental sync cursors), `walkfit.view` (`track` | `scenic`),
(the app is always the immersive
layout since #103: fullscreen visual, fading HUD pills, workout state in the
`.imm-workout` ribbon; the big-numbers/kiosk option was removed), `walkfit.scenic.time`
(3D time-of-day override), `walkfit.scenic.quality` (`auto` | `low` | `high`, 3D quality
override), `walkfit.scenic.motion` (`on` | `off`, 3D head bob/sway/lean — on by default, and
`prefers-reduced-motion` overrides it), `walkfit.scenic.camera` (`first` | `third`, Scenic v3
player camera — first person remains the default), `walkfit.scenic.avatar` (`sky` | `coral` |
`lime` | `violet`, local player outfit palette),
`walkfit.capture` (raw BLE frame
debug logging, off unless `'1'`), `walkfit.demo` (demo mode — src/demo.ts simulates the
treadmill + HR strap behind the composable interfaces and seeds a fixture dataset;
also via `?demo`. Used for README screenshots; opt-in only so it can't mask real
connection failures).

**Health sync** — `health.ts` defines `HealthProvider` (id doubles as
`WeightEntry.source`; reactive state; `connect`/`disconnect`/`handleRedirect`/
`syncWeight`). Providers are listed in App.vue's `healthProviders` and rendered
generically in Settings (connect / sync now / disconnect); connected ones auto-sync on
load, results merge into the weight log and the newest entry updates `weightKg`. The
interface is transport-agnostic on purpose — a future Apple Health provider can be a
file import rather than OAuth. **OAuth redirect ownership:** every OAuth flow (Strava +
providers) shares one redirect URI; a flow may only consume a `?code&state` callback
when the returned `state` matches the nonce in its OWN sessionStorage key, and must
leave the URL untouched otherwise (`handleOAuthRedirects()` probes them in turn). Break
this rule and providers eat each other's callbacks. Withings specifics (rotated refresh
tokens, `{status,body}` envelope, redirect_uri echoed on exchange, demo mode) live in
`withings.ts` and `oauth-proxy/README.md`.

**Workouts** — `WorkoutPicker.vue` is the single picker, mounted in two places that must
stay behaviorally identical:

1. The header's overflow menu (☰ — see below) → `menuOpen` overlay, `:closable="true"`,
   emits close the overlay on pick/close.
2. The onboarding wizard's step 4 (`wizardStep === 4`) → embedded inline,
   `:closable="false"` (no ✕; the wizard's own Back nav is the only way out besides
   picking), and its `@start-plan`/`@start-hr` handlers (`wizardStartPlan`/`wizardStartHr`)
   additionally close the wizard.

Both instances pass the same props (`workouts`, `weightKg`, `maxHr`, `hrTargets`,
`activeHrTarget`, `adjustInterval`) sourced from `App.vue` state — nothing about the
picker itself differs between the two mount points. `:start-tab` (defaults to `'plans'`)
lets the header's HR badge open straight onto the `hr` tab (`openWorkoutMenu('hr')`)
without the wizard needing that concept at all.

Inside the picker, two tabs:

- **Weight loss** (default): the fixed-segment presets from `workouts.ts`, unchanged —
  pick one, belt follows its `{speed, minutes}` timeline.
- **Heart rate**: pick a target — Light / Fat burn / Cardio / Hard — and belt speed
  nudges ±`HR_NUDGE_STEP` every `HR_ADJUST_INTERVAL` (20s, in `App.vue`) to hold bpm
  inside that target's range. `HR_TARGETS` is its own table (not the display-only
  `HR_ZONES` used by the live badge) because the steer targets need a "Light" range
  (47.5–60% of max HR — 90–113 bpm at the default 190) that the badge's zones don't
  have, and the badge's top "Max" zone isn't a sane steer target. Deliberately simple
  and safe: nudges only fire while `state.running` is true and no more often than the
  20s interval, so it can never race `treadmill.ts`'s own ~8s countdown-window
  speed-enforcement retry (20s always exceeds that window). `setSpeed()` already clamps
  to `SPEED_MIN..SPEED_MAX` and snaps to the step grid, and `state.speed` is already the
  phantom-2x-filtered reading — the workout mode adds no protocol-level logic of its
  own, just decides _when_ to call `setSpeed()`. Ends itself if the HR sensor disconnects
  mid-session (nothing left to steer by).

The two workout modes are mutually exclusive (`active` for weight-loss, `hrTarget` for
HR) — starting one clears the other.

**Skip segment (#110)** — the immersive ribbon's Skip button (weight-loss plans only)
jumps `state.elapsed` straight to the current segment's `.end`. Distance/kcal are
speed-integrated in `treadmill.ts` from live belt speed, not derived from elapsed, so
the jump fabricates no distance — the skipped seconds are just never walked, like a
pause. The existing `[state.elapsed, state.running, active]` watcher reacts on its own:
pushes the next segment's speed, or — since the last segment's `.end === timeline.total`
— calls `finishWorkout()` when Skip lands there, ending the workout exactly like End.

**Header overflow menu** — Workout / Statistics / Disconnect (only while connected) /
Settings live behind a single ☰ button (`moreMenuOpen`) instead of separate header
buttons, to keep the header from crowding on narrow screens. The Connect button (when
not connected) and the HR badge (when a sensor is connected) stay directly in the
header — both are primary, frequently-tapped actions, unlike the four menu items.

The main visual has two modes, toggled by the pill overlaid on the visual's top-right
corner or in **Settings → Display** (2D / 3D): the
top-down 2D **track** (default), or the first-person 3D **scenic** walk (#51). Both
read the same `state.distance`/`state.speed` — no separate tracking. Lap
count/lap-times carry over into the 3D mode as a corner badge overlaid on the canvas.

**Scenic (3D)** is a first-person walk around the 400 m athletics track itself, camera
centred in **lane 1** (infield on the left, counterclockwise like athletics). It splits
into two layers. `src/scenic.ts` is the pure world model: `trackPoint(s, o)` gives
position and unit tangent on the stadium loop (IAAF straights 84.39 m, bend radius
derived so the lane-1 line measures exactly 400 m; `o` is lateral offset, positive
outward), `surroundings()` places a deterministic trees/bushes/rocks ring plus 4
floodlight masts via `worldHash`, and `dayPhase`/`skyAt` drive dawn→night keyframes over
`DAY_LENGTH_M` = 3200 m of _walked distance_ — every walk starts at dawn; floodlights
read as lit at night because their heads are unlit MeshBasic. `distanceSigns()` places
"100 m/200 m/300 m" signposts beside the track, and `laneStaggers()` computes the classic
staggered start line per lane (lane k+1's lap is 2π·k·LANE_W longer, so its mark sits
that far past the common finish — every lane's lap to the finish then measures exactly
400 m; all staggers land on the home straight). It also exports `curvatureAt`/
`curvatureEased` — 0 on the straights and `+1/BEND_R` on BOTH bends, since a
counterclockwise loop turns left twice and never right. `src/Scenic3D.vue` turns that into
three.js meshes, all **built once** (a loop world needs no streaming): the red track
band, lane lines and start/finish line are closed loop-ribbons sampled every 2 m at
lateral offsets — their materials are `DoubleSide` because travel direction reverses
halfway around the loop, so any fixed triangle winding backface-culls one straight. Lane
lines sit 4 cm above the track surface (less separation z-fights into shimmer on the far
side of the loop). A sky-shader dome (horizon-biased scattering ramp from fog colour to
sky colour, plus a sun disc and Mie glow, evaluated per fragment) kills the ground/sky
seam — the vertex-colour gradient it replaced banded across a clear sky and could not
carry a halo at all, since the halo is a few degrees wide and landed between vertices, and the camera interpolates toward `state.distance`
at belt speed (distance ticks in at ~4 Hz; naive snapping would stutter). Comfort: the
camera bobs, sways and leans into the bends off walked distance (`cameraMotion` in
scenicLife.ts, `curvatureEased` in scenic.ts) — reversing the original fixed-horizon
choice now that there is something to look at. Settings → Display turns it off, and
`prefers-reduced-motion` renders discretely per distance tick instead of a continuous
rAF loop and forces the motion off regardless of the setting, because a bob applied per
discrete tick is a jolt. rAF pauses when the tab is hidden. **three.js is the one
runtime dependency**, and only the scenic view pays for it: `Scenic3D.vue` is a
`defineAsyncComponent` so Vite splits it (+three, +the post-processing addons) into a
lazy chunk (~585 kB raw) that downloads on first open — the main bundle stays three-free
and the 250 kB guard covers only that main chunk. No WebGL (probed before any
three setup) → the component emits `unsupported`, the app falls back to the 2D track
view and disables the Scenic toggle.

**Post-processing (ultra only)** runs bloom → `OutputPass` → colour grade. The grade goes
**after** `OutputPass`, not before: everything upstream of it is scene-referred and linear,
where a contrast pivot at 0.5 is meaningless — a night frame sits around 0.002-0.02, so
`(c - 0.5) * k + 0.5` drove every pixel negative and the clamp turned the whole frame
black (measured: mean frame luminance 23.6 → 1.5). The grade's strength is also driven from
`daylight(phase)`, because contrast and a corner vignette both take from the darks and a
night frame is almost nothing but darks. Note `ShaderPass` CLONES the uniform object it is
handed, so per-frame writes must go to the pass's own `uniforms`, not to the shader
definition. With a composer in play three skips tone mapping in the material shaders and
`OutputPass` does it instead — which also means fog and the sky dome, which previously
escaped it, now go through it too.

The venue (`src/scenicVenue.ts`) is a **club track, not a stadium bowl**: one covered
stand on the home straight, open horizon on the other three sides so the day/night sky
and the scenery ring stay visible — a closed bowl would occlude both. Venue parts are
STATIC and so get added to the scene BEFORE the bake block, unlike the pacers, rabbit and
avatar, which move and so are added after it. The skyline is the one exception: it looks
like venue furniture but is actually a camera-following backdrop (`SKYLINE_R` away,
`fog: false`, tinted to the fog colour every frame) and is excluded from the bake via the
`skyObjects` array, same as the sky dome. It has to work this way — a world-anchored ring
can't work at all, since the camera wanders up to 56 m off the infield's centre, and any
radius that clears the opaque sky dome on one side pokes through it on the other. Its
first cut sat at radius 380, past the camera's 290 far plane and fully saturated by fog:
it rendered zero pixels for the entire task before this fix.

Every geometry builder emits UVs and the bake pass **fills in zeros** for anything missing
them (`ensureUv`) — it used to do the opposite, deleting `uv` so `mergeGeometries` would
accept a mixed batch, which textured surfaces cannot live with. `assertSameAttributes`
throws on a mismatched batch, because a silent merge of disagreeing attribute sets renders
as corruption rather than an error. Anything that must survive the bake has to be excluded
from the `staticRoots` filter — including `sunTarget`, since a `DirectionalLight` whose
target has been removed from the scene aims at the world origin and every shadow in the
scene is then quietly wrong.

**Life on the track** — pacers, the rabbit and your own body (`src/scenicLife.ts` plus the
corresponding block in `Scenic3D.vue`) are the only live meshes in the scene; everything
else is baked, and all three are added to the scene **after** the bake block above or they
get merged into the static world and freeze in place. The render loop only calls
`update()` when walked distance changes (an optimisation from when nothing in the scene
moved on its own) — anything that animates while the belt is stopped needs the wall-clock
escape now in `frame()` (pacers force a redraw at ~30 Hz via `sessionSeconds` even when
distance hasn't moved), and the `prefers-reduced-motion` path has no rAF loop at all, so
it advances `sessionSeconds` from `performance.now()` instead. Pacers run lanes 2-6 so a
fast one overtaking cannot clip through the camera; once the pacer count exceeds the lane
count, two share a lane, and since their speeds differ the faster laps the slower within
about a minute — `pacers()` draws each at `Pacer.drawO`, an ABSOLUTE lateral offset from
the lane-1 line (not a delta), alternating `PACER_LATERAL_M` to either side of the lane
centre so that lap reads as an overtake rather than two meshes intersecting. Arc distance
is still measured along `laneMeasurementO(lane)` — conflating the two with `drawO` would
make a pacer cover subtly wrong distance on the bends. The rabbit runs for **weight-loss
plans only** (an HR target defines a heart rate, not a pace, so there is no pace to chase)
and carries its own emissive term because it's the app's only ahead/behind readout and has
to stay legible after dark even as pacers sink into the dusk. `App.vue` integrates its
distance — the one place that already knows the segment's target speed — tracking its own
`rabbitElapsed` separately from the workout watcher's so Skip doesn't bank the skipped
seconds as rabbit progress (Skip means "these seconds never happened", like a pause; a
200 m jump wraps the loop and would otherwise put the rabbit behind you). Your own body is
a shadow-caster only, its geometry inside the camera's 0.3 m near plane so it's clipped
away — and unlike the scenery props, it gets **no** blob-shadow fallback on the low tier:
visible ground starts about 2.65 m out at eye height 1.6 m with a 60 degree FOV, so a disc
under you renders nothing, and one far enough forward to be visible would read as a mark
on the track rather than as your shadow. Props keep their blob shadows on the low tier —
they're at a distance and fully in frame, so it works — and the high/Quality tier's real
cast shadow works for the walker because shadows stretch away from you into view when the
sun is low.

The 2D track view is **generated from the same scenic.ts model** the 3D view walks —
not hand-drawn SVG: `track2d` in App.vue maps 3D `(x, z)` → SVG `(cx + z·k, cy + x·k)`
(k = 2 px/m, with lateral offsets exaggerated ×2.5 transit-map style so the six lanes
stay readable) and builds the band, all seven lane lines, the full-width finish line,
the staggered starts, tiny painted lane numbers, and the green break line from
`trackPoint`/`laneStaggers`/`laneNumbers`/`BREAK_LINE_S`. Loop paths use exact
circular arcs, and lane 1's guide path is at offset 0 (unaffected by the exaggeration),
so `getTotalLength` maps linearly to walked metres; the runner marker and progress
ring follow that invisible guide (`.track-line`, `stroke: none` — geometry only).

The track `<svg>` only exists in the DOM while that view is active (`v-if`), so its path
geometry (`pathLen`, read via `getTotalLength()` for the runner marker + progress ring)
has to be recomputed on _every_ mount, not just once in `onMounted` — the `watch(viewMode)`
handler does this. Skipping it means loading straight into a persisted `scenic` preference
leaves `pathLen` stuck at 0 forever, even after switching back to Track: marker frozen at
the SVG origin, progress ring invisible. Easy to reintroduce if this gets refactored —
verified by mounting the app with `localStorage['walkfit.view'] = 'scenic'` pre-set.

## Strava upload

Optional (#25) — hidden entirely unless both `VITE_STRAVA_CLIENT_ID` and
`VITE_STRAVA_PROXY_URL` are set at build time (see `.env.example`). WalkFit is otherwise a
static site with **no backend** (`deploy.yml` → GitHub Pages); Strava is the one exception
because its OAuth token endpoint requires `client_secret` for both the initial exchange and
every refresh — no PKCE, confirmed against Strava's own docs — and a secret can't live in a
browser bundle.

- `oauth-proxy/` — standalone Cloudflare Worker holding the OAuth secrets for ALL
  integrations: `/{provider}/token` + `/{provider}/refresh` routes (`strava`,
  `withings`; legacy `/token`/`/refresh` alias to strava), thin passthroughs to each
  provider's token endpoint with the secret injected server-side. See
  `oauth-proxy/README.md` for deploy steps and per-provider app registration.
- Data traffic does NOT go through the worker — `api.strava.com` (upload) and
  `wbsapi.withings.net` (measures) both send permissive CORS headers, so the client
  calls them directly with the bearer token. Don't add data routes to the worker; keep
  its surface to token routes only.
- `VITE_STRAVA_CLIENT_ID` / `VITE_WITHINGS_CLIENT_ID` are public (part of the authorize
  URL every browser sends) — fine in a repo Actions variable, not a secret. Set the vars
  in the deploy workflow's repo Settings → Secrets and variables → Actions → Variables.
- Registering a Strava API app requires an active Strava subscription, and every new app
  is capped at 10 connected athletes until Strava approves a review request. Both are
  Strava-side account/app-settings matters, not WalkFit code — the OAuth flow already
  supports any number of users up to whatever cap the registered app currently has (each
  person connects independently, gets their own token pair). See `oauth-proxy/README.md`.

## Treadmill BLE protocol (hard-won — do not "simplify" without device to test)

Connect over **BLE** (public address, advertises FTMS `0x1826` + vendor `0xfff0`). Classic
Bluetooth pairing only exposes audio profiles — dead end.

- **Start / stop** via FTMS Control Point `0x2ad9` (write): `00` request control, `07` start, `08 01`
  stop. Start triggers on-belt 3-2-1 countdown, then the belt simply moves — this device
  has NO safety key or other physical stop-guard.
- **Set speed** via vendor write char `0xfff2` (FTMS set-speed ignored by this firmware). Frame:
  `02 53 02 <speed> <xor> 03`, `speed` = km/h × 10, checksum = XOR of opcode..last payload byte.
  Range 1.0–6.0 km/h.
- **Telemetry** on vendor notify `0xfff1`. Three gotchas, all handled in `treadmill.ts`:
  1. **Speed writes ignored during 3-2-1 countdown** → enforce/retry target for
     bounded ~8s window (unbounded retry spams writes forever).
  2. FW **interleaves phantom `02 53 02` frame at exactly 2× real speed** (0.05 km/h
     units). Decode = take **minimum** speed reading over ~1.5s window. Never filter against
     commanded target — breaks ramp tracking.
  3. FW **doesn't stream running data unprompted**, and `02 53 01 03` "idle" frames fire even
     while running. So: **poll** `02 51 03 00` to `0xfff2` at ~1 Hz to elicit data, derive stopped
     from ~3s speed-frame staleness timeout (not from status frames).

`src/treadmill.ts` keeps small `state.log` debug ring (toggle via ⚙ settings "Debug panel").

## Conventions

- Vue 3 `<script setup lang="ts">`, Composition API, composables return typed `reactive`
  `state` + methods. TypeScript strict; keep conversions of protocol/BLE code types-only.
- No component library; hand-rolled CSS in `App.vue` (scoped) + `style.css`. Dark theme,
  `--accent` green. Prefer editing single `App.vue` over splitting components unless it grows.
- Speed always km/h; distances metres internally, formatted for display.
