# WalkFit

Vue.js app to control the Dreaver Motion One (FitShow FS-BT-T4) walking treadmill over
**Web Bluetooth**, with a virtual loop you travel around as you walk.

## Run

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` in **Chrome or Edge** (desktop or Android).
Web Bluetooth only works in Chromium browsers and in a secure context — `localhost` counts,
so no HTTPS is needed for local use.

> **On Linux**, Chrome/Chromium keeps Web Bluetooth behind a flag (it's on-by-default only on
> Windows/Mac/Android/ChromeOS). Enable `chrome://flags/#enable-experimental-web-platform-features`
> → **Enabled** → relaunch. If `navigator.bluetooth` is `undefined` in the console, this is why.
>
> **Brave** uses its own flag: `brave://flags/#brave-web-bluetooth-api` → **Enabled** → relaunch. To use it from a phone, serve over HTTPS (e.g.
`npm run build` + any static host with TLS, or a tunnel).

## Use

1. **Connect treadmill** — pick "Dreaver Motion One" in the browser prompt.
2. **Start** — keep the safety key clipped in and a foot ready; the belt beeps and counts
   3-2-1 before moving.
3. Set speed with the slider or ± buttons. Watch your runner lap the 1 km loop.
4. **Stop** halts the belt.

### Training

Tap **Training** (top right) for preset weight-loss walking sessions (steady fat-burn and
interval workouts, 20–45 min). Pick one to see its speed/time timeline, distance and estimated
calories, then **Start training** — the app drives the belt speed automatically through each
segment, and the chart under the loop becomes the session profile with a moving "you are here"
marker (amber) plus your actual speed (white) over the planned plan (green). Every session ends
with a fixed 1:45 cooldown at 1 km/h. **End** returns to free walking.

### Heart rate

Tap **♥ HR** to connect any standard BLE heart-rate source over the Bluetooth Heart Rate
Service (`0x180D`) — a chest strap, or a Garmin watch broadcasting HR.

On a **Garmin Forerunner 970**: enable heart-rate broadcast (controls menu → *Broadcast Heart
Rate*, or Settings → Sensors & Accessories → Wrist Heart Rate → *Broadcast During Activity* /
*Broadcast Now*). While broadcasting, the watch shows the broadcast icon; then hit **♥ HR** in
WalkFit and pick it. The app shows live bpm and a training zone; set your **Max HR** to tune the
zones (defaults to 190, remembered locally). The zones are Warm-up / **Fat burn** / Cardio /
Hard / Max — the green "Fat burn" band (60–70% max HR) is the sweet spot for weight loss.
It's a separate Bluetooth connection from the treadmill, so connect each independently.

## How it talks to the treadmill

Reverse-engineered protocol (`src/treadmill.js`):

- Connect over **BLE** (not classic Bluetooth — that only exposes audio).
- **Start/stop** via standard FTMS Control Point `0x2ad9`: `00` request control, `07` start,
  `08 01` stop.
- **Speed** via the FitShow vendor write characteristic `0xfff2` (FTMS set-speed is ignored
  by this firmware): frame `02 53 02 <km/h×10> <xor> 03`.
- **Telemetry** streams on vendor notify `0xfff1`: running data `02 51 03 <km/h×10> …`,
  status `02 53 01 <00=running/03=idle>`.

Distance/time are integrated client-side from the live speed, so the loop stays accurate
regardless of the device's own counters.
