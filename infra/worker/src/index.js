// myheliograph.com router Worker.
//
// Static frontend (public/) is served by Workers Static Assets BEFORE this
// code runs. Everything else lands here:
//
//   /asset/data/*, /asset/config/*  → 404. The origin's catch-all /asset
//       mount would otherwise expose its raw-FITS download cache and SunPy
//       config publicly; nothing legitimate fetches them.
//   /asset/**  → proxied to Fly and cached at Cloudflare's edge. Fly is NOT
//       behind Cloudflare, so unlike the old Render setup (orange-to-orange,
//       which forced every request to origin) the edge cache works here.
//       Immutable images cache 30d; only 2xx is cached, so a 404 for a
//       not-yet-rendered hq_*.png is never frozen in front of the real file.
//   /api/helioviewer_thumb?…  → proxied to Fly and edge-cached. The
//       wavelength-tile + gallery thumbnails are a fixed set of
//       (date, wavelength, scale, size) tuples shared by every visitor, so
//       caching by full URL turns 27 origin round-trips per landing (~3 MB,
//       and a cold-Fly wake on the first) into edge HITs for everyone after
//       the first. Deterministic historical frames → treat as immutable.
//   everything else (/api/**, /logs/stream, /shopify/*, /favicon.ico, …)
//       → transparent proxy to Fly (fetch streams bodies, so SSE + long
//       polls pass through).
//
// The cron trigger runs the Printify stale-draft sweep — see scheduled().

const IMMUTABLE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

function toOrigin(request, env, cf) {
  const origin = new URL(env.ORIGIN);
  const url = new URL(request.url);
  url.protocol = origin.protocol;
  url.host = origin.host;
  // Preserve method/headers/body; the browser Origin header passes through
  // untouched so the origin's ALLOWED_ORIGINS gate keeps working.
  return fetch(new Request(url, request), cf ? { cf } : undefined);
}

function serveAsset(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/asset/data/") || pathname.startsWith("/asset/config/")) {
    return new Response("Not found", { status: 404 });
  }
  // Only cache successful responses. ttl=0 on 4xx/5xx means a transient
  // origin error or a pre-generation 404 is never cached in front of the
  // real asset the origin mints seconds later.
  const cf = IMMUTABLE_EXT.test(pathname)
    ? { cacheEverything: true, cacheTtlByStatus: { "200-299": 2592000, "300-599": 0 } }
    : { cacheEverything: true, cacheTtlByStatus: { "200-299": 60, "300-599": 0 } };
  return toOrigin(request, env, cf);
}

// Explicit edge cache for the thumbnail proxy. Keyed by full URL (so each
// date/wavelength/scale/size caches on its own); the cached copy has
// Vary/Set-Cookie stripped and a 30-day immutable TTL. Only 2xx is stored, so
// a transient origin error or a pre-generation failure is never frozen.
async function cacheThumb(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  const resp = await toOrigin(request, env);
  if (resp.status >= 200 && resp.status < 300) {
    const headers = new Headers(resp.headers);
    headers.delete("Vary");
    headers.delete("Set-Cookie");
    headers.set("Cache-Control", "public, max-age=2592000, immutable");
    const cached = new Response(resp.clone().body, {
      status: resp.status, statusText: resp.statusText, headers,
    });
    ctx.waitUntil(cache.put(key, cached));
  }
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/asset" || pathname.startsWith("/asset/")) {
      return serveAsset(request, env);
    }
    // Edge-cache the deterministic thumbnail proxy (GET only). The `cf`
    // cache option can't cache this — the origin sends `Vary: Origin` (from
    // its CORS gate), and Cloudflare treats any Vary other than
    // Accept-Encoding as uncacheable. The image is identical regardless of
    // Origin, so we cache explicitly with Vary stripped. The origin's Origin
    // gate still runs on every MISS (we only reach it then).
    if (pathname === "/api/helioviewer_thumb" && request.method === "GET") {
      return cacheThumb(request, env, ctx);
    }
    return toOrigin(request, env);
  },

  async scheduled(_event, env, ctx) {
    // Reap abandoned [MOCKUP] Printify drafts. The held connection keeps
    // the scale-to-zero origin awake for the sweep; the TTL logic is
    // idempotent so retries/overlaps converge.
    ctx.waitUntil(
      fetch(`${env.ORIGIN}/api/printify/admin/sweep_mockup_drafts`, {
        method: "POST",
        headers: { "X-Admin-Key": env.ADMIN_KEY || "" },
      }).then(async (r) => console.log(`mockup sweep: ${r.status} ${await r.text()}`))
        .catch((e) => console.log(`mockup sweep failed: ${e}`))
    );
  },
};
