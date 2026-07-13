# oauth-proxy

Cloudflare Worker holding the OAuth `client_secret`s for the services WalkFit connects
to (Strava upload, Withings weight sync). WalkFit itself is a static site with no
backend (see `.github/workflows/deploy.yml` → GitHub Pages) — this worker is the one
exception, and it does as little as possible: token routes per provider, all thin
passthroughs to the provider's token endpoint. See the comment at the top of
`worker.js` for why data traffic (activity upload, measure fetches) does NOT go
through here.

Routes: `/{provider}/token` + `/{provider}/refresh` for `strava` and `withings`;
legacy `/token` + `/refresh` alias to strava (they predate the provider routes). A
provider's routes 404 until its secrets are set.

**Migrating from the old `walkfit-strava-proxy` deployment:** this directory was
previously `strava-proxy/` with wrangler `name = "walkfit-strava-proxy"`; the name
determines the `*.workers.dev` URL, so the first deploy after the rename creates a NEW
worker at a new URL. Re-add the secrets (`wrangler secret put` is per-worker), point
`VITE_STRAVA_PROXY_URL` (and `VITE_WITHINGS_PROXY_URL`) at the new URL in the repo's
Actions variables, then delete the old worker in the Cloudflare dashboard. Users'
tokens are unaffected (they live in each browser's localStorage).

## Deploy

`wrangler` is pinned in the repo root `mise.toml` — `mise install` picks it up. Run
commands via `mise exec -- wrangler ...`, or `mise x -- wrangler ...` for short:

```bash
cd oauth-proxy
mise exec -- wrangler login
# per provider you enable:
mise exec -- wrangler secret put STRAVA_CLIENT_ID
mise exec -- wrangler secret put STRAVA_CLIENT_SECRET
mise exec -- wrangler secret put WITHINGS_CLIENT_ID
mise exec -- wrangler secret put WITHINGS_CLIENT_SECRET
```

Set `ALLOWED_ORIGIN` in `wrangler.toml` to the app's exact origin(s), comma-separated
(e.g. `http://localhost:5173,https://ronaldlokers.github.io`), then:

```bash
mise exec -- wrangler deploy
```

Note the deployed `*.workers.dev` URL — it's `VITE_STRAVA_PROXY_URL` and
`VITE_WITHINGS_PROXY_URL` (both point at this same worker; see repo root
`.env.example` and `CLAUDE.md`).

## Register the Strava API app

<https://www.strava.com/settings/api> → create an app. Requires an active Strava
subscription to register. "Authorization Callback Domain" must match the app's deployed
host (e.g. `ronaldlokers.github.io`) — Strava checks this against the `redirect_uri` sent
in the authorize request. Copy the Client ID (public, goes in `VITE_STRAVA_CLIENT_ID`) and
Client Secret (goes only into `wrangler secret put`, never into the app repo or its env
files).

**Athlete cap:** every new app starts in "single-player mode" — up to **10** connected
Strava accounts, 200 req/15min, no extra approval needed. WalkFit's OAuth flow (each
person does their own connect, gets their own token pair in their own browser storage)
already works for all 10 without any code change — this is a Strava-side app-settings
upgrade, not a WalkFit change. Past 10 athletes, Strava requires submitting the app for
review from the API Settings dashboard before more people can connect.

## Register the Withings API app

<https://developer.withings.com/> → developer dashboard → create an application
(public API integration). Registration is free. The **Callback URL must match the
app's URL exactly** (Withings validates the full `redirect_uri`, not just the domain) —
register both the deployed URL (e.g. `https://ronaldlokers.github.io/WalkFit/`) and
`http://localhost:5173/` for development. Copy the Client ID (public, goes in
`VITE_WITHINGS_CLIENT_ID`) and Client Secret (only into `wrangler secret put`).

Quirks the worker/client already handle, kept here for context:

- The token endpoint is Withings' RPC style: `action=requesttoken` on
  `POST https://wbsapi.withings.net/v2/oauth2`, and responses are a `{status, body}`
  envelope where `status != 0` means error even on HTTP 200.
- The **refresh token rotates on every refresh** — the client persists the new one
  immediately.
- The authorization-code exchange requires the `redirect_uri` again; the client sends
  it and the worker passes it through.
- Withings offers a **demo mode**: authorize with `mode=demo` on the authorize URL to
  get demo-account data — handy for testing the full flow without a real scale.
