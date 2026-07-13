# WalkFit

Vue 3 + Vite web app control **Dreaver Motion One** walking treadmill (FitShow
`FS-BT-T4` OEM controller) from browser over **Web Bluetooth**, virtual 400 m athletics-track
loop, guided weight-loss trainings, optional heart-rate display.

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
npm run lint       # ESLint (flat config, Vue-aware)
npm run format     # Prettier --write   (format:check in CI)
```

CI (`.github/workflows/ci.yml`) runs lint → format:check → test → build on PRs; deploy
workflow gates on tests too. Tests: `src/protocol.test.js` (framing/checksum, phantom-2x speed
filter, telemetry + HR parsing), `src/trainings.test.js`, `src/history.test.js`,
`src/App.happy.test.js` (jsdom + @vue/test-utils happy-path: wizard → walk/training flows),
and `src/App.hrAutopilot.test.js` (mocks both `treadmill.js`/`heartrate.js` composables to
drive `state.elapsed`/`bpm` directly — verifies nudge direction, the 20s rate limit, that it
stays silent while the belt isn't running, and that it ends itself on HR disconnect).
`test/setup.js` polyfills `localStorage`; component test files opt into jsdom with a
`// @vitest-environment jsdom` docblock.

Formatting Prettier (no semicolons, single quotes, width 100). Note: Prettier splits long
inline template handlers across lines, breaks multi-statement `@click="a; b"` — use
method instead of inline multi-statement handlers.

**E2E / visual (Playwright):** `npm run e2e` (spec in `e2e/`, config `playwright.config.js`).
One smoke spec: loads app, asserts wizard + walk flow, and `toHaveScreenshot`
baseline. Baselines (`e2e/*-snapshots/*.png`) committed, MUST get generated in same
container CI uses, else font differences fail diff:

```bash
# regenerate baselines to match CI (Playwright pinned to 1.61.1)
docker run --rm -v "$PWD":/work -w /work -e CI=1 mcr.microsoft.com/playwright:v1.61.1-noble \
  bash -c "npm ci && npm run e2e:update"
```

`E2E` workflow runs `npm run e2e` inside `mcr.microsoft.com/playwright:v1.61.1-noble`.
Keep pinned Playwright version and image tag in sync.

## Layout

- `src/protocol.js` — **pure, framework-free** protocol logic (framing/checksum, set-speed frame,
  telemetry parse, phantom-2x speed filter, HR parse). Unit-tested in `src/protocol.test.js`.
- `src/treadmill.js` — `useTreadmill()` composable: Web Bluetooth connection wiring around
  `protocol.js` (connect, start/stop, set speed, distance/time integration, auto-reconnect).
- `src/heartrate.js` — `useHeartRate()` composable: standard BLE Heart Rate Service (`0x180D`).
- `src/trainings.js` — training presets (segments of `{speed, minutes}`), `trainingStats`,
  `timeline`, `metForSpeed` (MET-based kcal estimate, also used for live session kcal).
- `src/history.js` — completed-session log persisted to `localStorage` (`walkfit.history`):
  `addSession`, `weeklyTotals` (ISO-week rollups), `currentStreak`. Unit-tested in
  `src/history.test.js`.
- `src/strava.js` — `useStrava()` composable: OAuth2 connect + per-session upload. See
  "Strava upload" below.
- `src/App.vue` — whole UI (single component): loop, chart, controls, stats, trainings menu,
  history view, settings, onboarding wizard.
- `src/main.js`, `src/style.css` — bootstrap + global styles/theme vars (`--accent`).

Treadmill and HR two independent GATT devices; each needs own user-gesture connect
first time. Both composables expose `autoConnect()` (called on mount) which silently
reconnects to previously-granted device via `navigator.bluetooth.getDevices()` (no picker),
with 8s timeout so off/out-of-range device doesn't hang UI.

Session logged to history when `state.running` goes true→false and covered at least
50 m (filters accidental starts) — fires both on explicit Stop and on belt's own
staleness-timeout auto-stop, so doesn't matter which one ends walk. If Strava connected,
same transition opens the upload-prompt popup.

`localStorage` keys: `walkfit.treadmill.id`, `walkfit.hr.id` (remembered device ids),
`walkfit.maxhr`, `walkfit.weight`, `walkfit.audio`, `walkfit.debug`, `walkfit.history`,
`walkfit.strava` (OAuth tokens), `walkfit.view` (`track` | `scenic`).

**HR-steered autopilot** — tap the HR badge (header, only visible once a sensor is
connected) to pick a target zone (Fat burn / Cardio / Hard); belt speed then nudges
±`HR_NUDGE_STEP` every `HR_ADJUST_INTERVAL` (20s) to hold bpm inside that zone's range.
Mutually exclusive with a preset training (`active`) — starting one clears the other.
Deliberately simple and safe: nudges only fire while `state.running` is true and no more
often than the 20s interval, so it can never race `treadmill.js`'s own ~8s
countdown-window speed-enforcement retry (20s always exceeds that window). `setSpeed()`
already clamps to `SPEED_MIN..SPEED_MAX` and snaps to the step grid, and `state.speed`
is already the phantom-2x-filtered reading — the autopilot adds no protocol-level logic
of its own, just decides _when_ to call `setSpeed()`. Ends itself if the HR sensor
disconnects mid-session (nothing left to steer by). `HR_ZONES` (zone names/colors/bpm%
thresholds) is shared between the live HR badge and this picker so they can't drift apart.

The main visual has two modes, toggled above it: the 400 m athletics **track** (default),
or a side-scrolling **scenic** walk. Both read the same `state.distance`/`state.speed` —
no separate tracking. The walker emoji is fixed on screen at `WALKER_X` (200); it's
mirrored via `transform: scaleX(-1)` (with `transform-box: fill-box`) — the 🚶 glyph faces
left by default, same direction the scenery scrolls, which reads as walking backward
otherwise. Lap count/lap-times carry over into scenic mode as a corner badge instead of
the track's big centered number.

Scenic uses a **world-position-in-metres model**, not a repeating scroll tile: each prop's
screen x is `WALKER_X + (worldM - state.distance) * pxPerMetre`, so "spawning" is really
just enumerating which fixed-size distance buckets are currently in view. `sceneHash(seed)`
is a cheap deterministic pseudo-random (sine-based) — the same bucket index always
resolves to the same prop/position/size, so the scene never jumps or differs between
re-renders despite not being a literal repeating pattern. `groundScenery` (trees, streetlight,
car, bird, dog, bin — `GROUND_PX_PER_M`/`GROUND_BUCKET_M`) and `clouds` (own slower
`CLOUD_PARALLAX` scale + wider buckets) are separate bucket systems. Depth is layered by
paint order: clouds → road/sidewalk/grass → `groundScenery.behind` → walker →
`groundScenery.front` → badge. Trees depth-swap into whichever group matches whether
their world position is still ahead of or already behind `state.distance`; streetlights
are always in `front` (closer to the path than the walker's lane). The foreground road
dash scrolls via `stroke-dashoffset` (not tile duplication — a plain dash pattern doesn't
need it) at a faster px/metre rate than the ground layer, for a depth-parallax read.

The track `<svg>` only exists in the DOM while that view is active (`v-if`), so its path
geometry (`pathLen`, read via `getTotalLength()` for the runner marker + progress ring)
has to be recomputed on _every_ mount, not just once in `onMounted` — the `watch(viewMode)`
handler does this. Skipping it means loading straight into a persisted `scenic` preference
leaves `pathLen` stuck at 0 forever, even after switching back to Track: marker frozen at
the SVG origin, progress ring invisible. Easy to reintroduce if this gets refactored —
verified by mounting the app with `localStorage['walkfit.view'] = 'scenic'` pre-set.

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

- `strava-proxy/` — standalone Cloudflare Worker, two routes (`/token`, `/refresh`), both
  thin passthroughs to `POST https://www.strava.com/oauth/token` with the secret injected
  server-side. See `strava-proxy/README.md` for deploy steps (register a Strava API app,
  `wrangler secret put`, `wrangler deploy`).
- Activity **upload** does NOT go through the worker — `api.strava.com` sends permissive
  CORS headers, so `src/strava.js` calls it directly from the browser with the bearer
  access token. Don't add an upload route to the worker; keep its surface to the two
  token routes only.
- `VITE_STRAVA_CLIENT_ID` is public (it's part of the authorize URL every browser sends) —
  fine in a repo Actions variable, not a secret. Set both vars in the deploy workflow's repo
  Settings → Secrets and variables → Actions → Variables.
- Registering a Strava API app requires an active Strava subscription, and every new app
  is capped at 10 connected athletes until Strava approves a review request. Both are
  Strava-side account/app-settings matters, not WalkFit code — the OAuth flow already
  supports any number of users up to whatever cap the registered app currently has (each
  person connects independently, gets their own token pair). See `strava-proxy/README.md`.

## Treadmill BLE protocol (hard-won — do not "simplify" without device to test)

Connect over **BLE** (public address, advertises FTMS `0x1826` + vendor `0xfff0`). Classic
Bluetooth pairing only exposes audio profiles — dead end.

- **Start / stop** via FTMS Control Point `0x2ad9` (write): `00` request control, `07` start, `08 01`
  stop. Start triggers on-belt 3-2-1 countdown; belt needs safety key / foot on it.
- **Set speed** via vendor write char `0xfff2` (FTMS set-speed ignored by this firmware). Frame:
  `02 53 02 <speed> <xor> 03`, `speed` = km/h × 10, checksum = XOR of opcode..last payload byte.
  Range 1.0–6.0 km/h.
- **Telemetry** on vendor notify `0xfff1`. Three gotchas, all handled in `treadmill.js`:
  1. **Speed writes ignored during 3-2-1 countdown** → enforce/retry target for
     bounded ~8s window (unbounded retry spams writes forever).
  2. FW **interleaves phantom `02 53 02` frame at exactly 2× real speed** (0.05 km/h
     units). Decode = take **minimum** speed reading over ~1.5s window. Never filter against
     commanded target — breaks ramp tracking.
  3. FW **doesn't stream running data unprompted**, and `02 53 01 03` "idle" frames fire even
     while running. So: **poll** `02 51 03 00` to `0xfff2` at ~1 Hz to elicit data, derive stopped
     from ~3s speed-frame staleness timeout (not from status frames).

`src/treadmill.js` keeps small `state.log` debug ring (toggle via ⚙ settings "Debug panel").

## Conventions

- Vue 3 `<script setup>`, Composition API, composables return `reactive` `state` + methods.
- No component library; hand-rolled CSS in `App.vue` (scoped) + `style.css`. Dark theme,
  `--accent` green. Prefer editing single `App.vue` over splitting components unless it grows.
- Speed always km/h; distances metres internally, formatted for display.
