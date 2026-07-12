# WalkFit

Vue 3 + Vite web app to control a **Dreaver Motion One** walking treadmill (FitShow
`FS-BT-T4` OEM controller) from the browser over **Web Bluetooth**, with a virtual 1 km loop,
guided weight-loss trainings, and optional heart-rate display.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

Requires a Chromium browser (Web Bluetooth). `localhost` is a secure context (no HTTPS needed).
**On Linux, Chrome hides Web Bluetooth behind a flag:** enable
`chrome://flags/#enable-experimental-web-platform-features` and relaunch, or `navigator.bluetooth`
is `undefined`.

`.devcontainer/` (devpod/neovim) builds on `mcr.microsoft.com/devcontainers/base:debian` with
the Node 22 feature; neovim comes from the official release tarball in the Dockerfile (the
neovim-homebrew feature breaks with a zsh login shell and drags in Homebrew). Playwright
browsers install via postCreate. The Dockerfile renames
the stock `vscode` user to `dev` (uid 1000) so container-written files stay owned by the host
user. The host's BlueZ D-Bus socket is bind-mounted (Linux hosts only), so a Chromium inside
the container can use Web Bluetooth against real hardware. **Screenshot baselines must NOT be
regenerated inside the devcontainer** — Debian fonts differ from the CI image; use the docker
command below.

```bash
npm test           # Vitest (run once)
npm run test:watch
npm run lint       # ESLint (flat config, Vue-aware)
npm run format     # Prettier --write   (format:check in CI)
```

CI (`.github/workflows/ci.yml`) runs lint → format:check → test → build on PRs; the deploy
workflow gates on tests too. Tests: `src/protocol.test.js` (framing/checksum, phantom-2x speed
filter, telemetry + HR parsing), `src/trainings.test.js`, and `src/App.happy.test.js` (jsdom +
@vue/test-utils happy-path: wizard → walk/training flows). `test/setup.js` polyfills
`localStorage`; component test files opt into jsdom with a `// @vitest-environment jsdom` docblock.

Formatting is Prettier (no semicolons, single quotes, width 100). Note: Prettier splits long
inline template handlers across lines, which breaks multi-statement `@click="a; b"` — use a
method instead of inline multi-statement handlers.

**E2E / visual (Playwright):** `npm run e2e` (spec in `e2e/`, config `playwright.config.js`).
One smoke spec: loads the app, asserts the wizard + walk flow, and a `toHaveScreenshot`
baseline. Baselines (`e2e/*-snapshots/*.png`) are committed and MUST be generated in the same
container CI uses, or font differences fail the diff:

```bash
# regenerate baselines to match CI (Playwright pinned to 1.61.1)
docker run --rm -v "$PWD":/work -w /work -e CI=1 mcr.microsoft.com/playwright:v1.61.1-noble \
  bash -c "npm ci && npm run e2e:update"
```

The `E2E` workflow runs `npm run e2e` inside `mcr.microsoft.com/playwright:v1.61.1-noble`.
Keep the pinned Playwright version and the image tag in sync.

## Layout

- `src/protocol.js` — **pure, framework-free** protocol logic (framing/checksum, set-speed frame,
  telemetry parse, phantom-2x speed filter, HR parse). Unit-tested in `src/protocol.test.js`.
- `src/treadmill.js` — `useTreadmill()` composable: Web Bluetooth connection wiring around
  `protocol.js` (connect, start/stop, set speed, distance/time integration, auto-reconnect).
- `src/heartrate.js` — `useHeartRate()` composable: standard BLE Heart Rate Service (`0x180D`).
- `src/trainings.js` — training presets (segments of `{speed, minutes}`), `trainingStats`, `timeline`.
- `src/App.vue` — the whole UI (single component): loop, chart, controls, stats, trainings menu,
  settings, onboarding wizard.
- `src/main.js`, `src/style.css` — bootstrap + global styles/theme vars (`--accent`).

Treadmill and HR are two independent GATT devices; each needs its own user-gesture connect
the first time. Both composables expose `autoConnect()` (called on mount) which silently
reconnects to a previously-granted device via `navigator.bluetooth.getDevices()` (no picker),
with an 8s timeout so an off/out-of-range device doesn't hang the UI.

`localStorage` keys: `walkfit.treadmill.id`, `walkfit.hr.id` (remembered device ids),
`walkfit.maxhr`, `walkfit.debug`.

## Treadmill BLE protocol (hard-won — do not "simplify" without a device to test)

Connect over **BLE** (public address, advertises FTMS `0x1826` + vendor `0xfff0`). Classic
Bluetooth pairing only exposes audio profiles — a dead end.

- **Start / stop** via FTMS Control Point `0x2ad9` (write): `00` request control, `07` start, `08 01`
  stop. Start triggers an on-belt 3-2-1 countdown; the belt needs its safety key / a foot on it.
- **Set speed** via vendor write char `0xfff2` (FTMS set-speed is ignored by this firmware). Frame:
  `02 53 02 <speed> <xor> 03`, `speed` = km/h × 10, checksum = XOR of opcode..last payload byte.
  Range 1.0–6.0 km/h.
- **Telemetry** on vendor notify `0xfff1`. Three gotchas, all handled in `treadmill.js`:
  1. **Speed writes are ignored during the 3-2-1 countdown** → enforce/retry the target for a
     bounded ~8s window (unbounded retry spams writes forever).
  2. The FW **interleaves a phantom `02 53 02` frame at exactly 2× the real speed** (0.05 km/h
     units). Decode = take the **minimum** speed reading over a ~1.5s window. Never filter against
     the commanded target — that breaks ramp tracking.
  3. The FW **does not stream running data unprompted**, and `02 53 01 03` "idle" frames fire even
     while running. So: **poll** `02 51 03 00` to `0xfff2` at ~1 Hz to elicit data, derive stopped
     from a ~3s speed-frame staleness timeout (not from status frames).

`src/treadmill.js` keeps a small `state.log` debug ring (toggle via the ⚙ settings "Debug panel").

## Conventions

- Vue 3 `<script setup>`, Composition API, composables return a `reactive` `state` + methods.
- No component library; hand-rolled CSS in `App.vue` (scoped) + `style.css`. Dark theme,
  `--accent` green. Prefer editing the single `App.vue` over splitting components unless it grows.
- Speed is always km/h; distances metres internally, formatted for display.
