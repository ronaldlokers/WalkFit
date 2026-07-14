// Cloudflare Worker: the only piece of WalkFit that isn't a static client.
//
// OAuth token endpoints (Strava, Withings) require `client_secret` for both the initial
// authorization-code exchange AND every refresh (neither supports PKCE / public
// clients). A secret can't live in a browser bundle, so this worker holds them and does
// nothing else: thin passthroughs to each provider's token endpoint.
//
// Data traffic does NOT go through this worker — api.strava.com and wbsapi.withings.net
// both send permissive CORS headers, so the client calls them directly with the bearer
// access token it already has. Keep it that way; token routes only, per provider.
//
// Routes: /{provider}/token and /{provider}/refresh (providers: strava, withings).
// Legacy /token and /refresh alias to strava — the originally-deployed URL keeps
// working without touching the app's VITE_STRAVA_PROXY_URL.
//
// Deploy: `wrangler deploy` from this directory, after `wrangler secret put` for each
// provider you enable (see README). A provider's routes 404 until its secrets are set.
// Set ALLOWED_ORIGIN in wrangler.toml (or as a var) to the app's exact origin(s).

/**
 * @typedef {object} Env
 * @property {string} [ALLOWED_ORIGIN]
 * @property {string} [STRAVA_CLIENT_ID]
 * @property {string} [STRAVA_CLIENT_SECRET]
 * @property {string} [WITHINGS_CLIENT_ID]
 * @property {string} [WITHINGS_CLIENT_SECRET]
 *
 * @typedef {object} TokenBody
 * @property {string} [code]
 * @property {string} [refresh_token]
 * @property {string} [redirect_uri]
 *
 * @typedef {object} Provider
 * @property {string} tokenUrl
 * @property {(env: Env, grant: string, body: TokenBody) => Record<string, string | undefined>} params
 * @property {(env: Env) => boolean} enabled
 */

/** @type {Record<string, Provider>} */
const PROVIDERS = {
  strava: {
    tokenUrl: 'https://www.strava.com/oauth/token',
    // Strava: plain OAuth params, secrets from env.
    params(env, grant, body) {
      /** @type {Record<string, string | undefined>} */
      const p = {
        client_id: env.STRAVA_CLIENT_ID,
        client_secret: env.STRAVA_CLIENT_SECRET,
        grant_type: grant,
      }
      if (grant === 'authorization_code') p.code = body.code
      else p.refresh_token = body.refresh_token
      return p
    },
    enabled: (env) => !!(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET),
  },
  withings: {
    tokenUrl: 'https://wbsapi.withings.net/v2/oauth2',
    // Withings wraps OAuth in its own RPC style: action=requesttoken, and the
    // authorization-code exchange additionally requires the redirect_uri. The response
    // is a {status, body} envelope (status != 0 = error even on HTTP 200) — passed
    // through as-is; the client interprets it.
    params(env, grant, body) {
      /** @type {Record<string, string | undefined>} */
      const p = {
        action: 'requesttoken',
        client_id: env.WITHINGS_CLIENT_ID,
        client_secret: env.WITHINGS_CLIENT_SECRET,
        grant_type: grant,
      }
      if (grant === 'authorization_code') {
        p.code = body.code
        p.redirect_uri = body.redirect_uri
      } else {
        p.refresh_token = body.refresh_token
      }
      return p
    },
    enabled: (env) => !!(env.WITHINGS_CLIENT_ID && env.WITHINGS_CLIENT_SECRET),
  },
}

/** @param {Env} env */
function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** @param {Env} env  @param {string} origin */
function corsHeaders(env, origin) {
  const allowed = allowedOrigins(env)
  const allow = allowed.includes(origin) ? origin : allowed[0] || ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    Vary: 'Origin',
  }
}

/** @param {Provider} provider  @param {Env} env  @param {string} grant  @param {TokenBody} body */
async function exchangeToken(provider, env, grant, body) {
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // drop undefined values — URLSearchParams wants Record<string, string>
    body: new URLSearchParams(
      Object.fromEntries(
        Object.entries(provider.params(env, grant, body)).filter(
          /** @returns {e is [string, string]} */ (e) => e[1] !== undefined,
        ),
      ),
    ),
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

export default {
  /** @param {Request} request  @param {Env} env */
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''
    const headers = corsHeaders(env, origin)
    const json = (/** @type {unknown} */ data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...headers, 'content-type': 'application/json' },
      })

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers })
    }
    // Enforce the origin allowlist (#58): CORS headers only restrict what browsers may
    // READ — without this check any third-party page or script could use the worker
    // (and its client_secrets / provider rate quota) for its own token exchanges. A
    // non-browser caller can fake an Origin, but the secrets never leave the worker and
    // this stops drive-by browser abuse cold.
    if (!allowedOrigins(env).includes(origin)) {
      return json({ error: 'origin not allowed' }, 403)
    }

    // "/withings/token" -> ["withings", "token"]; legacy "/token" -> strava.
    const segs = new URL(request.url).pathname.split('/').filter(Boolean)
    const [providerId, route] = segs.length === 1 ? ['strava', segs[0]] : segs
    const provider = PROVIDERS[providerId]
    if (!provider || !provider.enabled(env) || segs.length > 2) {
      return json({ error: 'not found' }, 404)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'invalid JSON body' }, 400)
    }

    let result
    if (route === 'token' && body.code) {
      result = await exchangeToken(provider, env, 'authorization_code', body)
    } else if (route === 'refresh' && body.refresh_token) {
      result = await exchangeToken(provider, env, 'refresh_token', body)
    } else {
      return json({ error: 'not found' }, 404)
    }

    return json(result.data, result.ok ? 200 : result.status)
  },
}
