# strava-proxy

Cloudflare Worker holding the Strava OAuth `client_secret`. WalkFit itself is a static
site with no backend (see `.github/workflows/deploy.yml` → GitHub Pages) — this worker
is the one exception, and it does as little as possible: two routes, both thin
passthroughs to `POST https://www.strava.com/oauth/token`. See the comment at the top
of `worker.js` for why activity upload does NOT need to go through here.

## Deploy

`wrangler` is pinned in the repo root `mise.toml` — `mise install` picks it up. Run
commands via `mise exec -- wrangler ...`, or `mise x -- wrangler ...` for short:

```bash
cd strava-proxy
mise exec -- wrangler login
mise exec -- wrangler secret put STRAVA_CLIENT_ID
mise exec -- wrangler secret put STRAVA_CLIENT_SECRET
```

Set `ALLOWED_ORIGIN` in `wrangler.toml` to the app's exact origin(s), comma-separated
(e.g. `http://localhost:5173,https://ronaldlokers.github.io`), then:

```bash
mise exec -- wrangler deploy
```

Note the deployed `*.workers.dev` URL — it's `VITE_STRAVA_PROXY_URL` (see repo root
`.env.example` and `CLAUDE.md`).

## Register the Strava API app

<https://www.strava.com/settings/api> → create an app. "Authorization Callback Domain"
must match the app's deployed host (e.g. `ronaldlokers.github.io`) — Strava checks this
against the `redirect_uri` sent in the authorize request. Copy the Client ID (public,
goes in `VITE_STRAVA_CLIENT_ID`) and Client Secret (goes only into
`wrangler secret put`, never into the app repo or its env files).
