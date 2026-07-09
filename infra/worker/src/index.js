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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/asset" || pathname.startsWith("/asset/")) {
      return serveAsset(request, env);
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
