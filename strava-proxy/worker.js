// Cloudflare Worker: the only piece of WalkFit that isn't a static client.
//
// Strava's OAuth token endpoint requires `client_secret` for both the initial
// authorization-code exchange AND every refresh (no PKCE / public-client support —
// confirmed against https://developers.strava.com/docs/authentication/). A secret
// can't live in a browser bundle, so this worker holds it and does nothing else:
// it's a thin passthrough to https://www.strava.com/oauth/token.
//
// Activity upload itself does NOT go through this worker — api.strava.com sends
// permissive CORS headers, so the client calls it directly with the bearer access
// token it already has. Keep it that way; don't add an /activity route here.
//
// Deploy: `wrangler deploy` from this directory, after `wrangler secret put
// STRAVA_CLIENT_ID` and `wrangler secret put STRAVA_CLIENT_SECRET`. Set
// ALLOWED_ORIGIN in wrangler.toml (or as a var) to the app's exact origin(s).

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const allow = allowed.includes(origin) ? origin : allowed[0] || ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    Vary: 'Origin',
  }
}

async function exchangeToken(env, params) {
  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    ...params,
  })
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''
    const headers = corsHeaders(env, origin)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers })
    }

    const url = new URL(request.url)
    let body
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
        status: 400,
        headers: { ...headers, 'content-type': 'application/json' },
      })
    }

    let result
    if (url.pathname === '/token' && body.code) {
      result = await exchangeToken(env, { code: body.code, grant_type: 'authorization_code' })
    } else if (url.pathname === '/refresh' && body.refresh_token) {
      result = await exchangeToken(env, {
        refresh_token: body.refresh_token,
        grant_type: 'refresh_token',
      })
    } else {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { ...headers, 'content-type': 'application/json' },
      })
    }

    return new Response(JSON.stringify(result.data), {
      status: result.ok ? 200 : result.status,
      headers: { ...headers, 'content-type': 'application/json' },
    })
  },
}
