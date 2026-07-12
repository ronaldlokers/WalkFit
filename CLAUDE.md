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
filter, telemetry + HR parsing), `src/trainings.test.js`, `src/history.test.js`, and
`src/App.happy.test.js` (jsdom +
@vue/test-utils happy-path: wizard → walk/training flows). `test/setup.js` polyfills
`localStorage`; component test files opt into jsdom with `// @vitest-environment jsdom` docblock.

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
- `src/App.vue` — whole UI (single component): loop, chart, controls, stats, trainings menu,
  history view, settings, onboarding wizard.
- `src/main.js`, `src/style.css` — bootstrap + global styles/theme vars (`--accent`).

Treadmill and HR two independent GATT devices; each needs own user-gesture connect
first time. Both composables expose `autoConnect()` (called on mount) which silently
reconnects to previously-granted device via `navigator.bluetooth.getDevices()` (no picker),
with 8s timeout so off/out-of-range device doesn't hang UI.

Session logged to history when `state.running` goes true→false and covered at least
50 m (filters accidental starts) — fires both on explicit Stop and on belt's own
staleness-timeout auto-stop, so doesn't matter which one ends walk.

`localStorage` keys: `walkfit.treadmill.id`, `walkfit.hr.id` (remembered device ids),
`walkfit.maxhr`, `walkfit.weight`, `walkfit.audio`, `walkfit.debug`, `walkfit.history`.

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