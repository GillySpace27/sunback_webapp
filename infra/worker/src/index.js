// myheliograph.com router Worker.
//
// Request flow (static assets are matched BEFORE this code runs — the
// Workers runtime serves anything present in public/ directly, so only
// non-static paths arrive here):
//
//   /asset/data/*, /asset/config/*  → 404. The origin's catch-all /asset
//       mount exposes its raw-FITS download cache (10-50 MB files) and
//       SunPy config publicly; nothing legitimate ever fetches them.
//   /asset/**  → R2 first (key = path minus "/asset/"). Miss → proxy to
//       the Fly origin: user HQ renders (hq_*.png) and previews are minted
//       at request time on the origin's disk, and the browser needs them
//       for display AND for checkout compositing, so origin fallback is
//       mandatory, not an optimization.
//   everything else (/api/**, /logs/stream, /shopify/*, /favicon.ico,
//       /docs, …) → transparent proxy to the Fly origin (fetch() streams
//       bodies both ways, so SSE and long polls pass through).
//
// The cron trigger runs the Printify stale-draft sweep via the origin's
// admin endpoint — see scheduled() at the bottom.

// Mirrors SecurityHeadersMiddleware in api/main.py: images are immutable
// (filenames are parameter-addressed), JSON manifests must revalidate so
// admin re-warms show up without a purge.
const IMMUTABLE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

const CONTENT_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  avif: "image/avif", json: "application/json",
};

function contentTypeFor(path) {
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function proxyToOrigin(request, env) {
  const url = new URL(request.url);
  const origin = new URL(env.ORIGIN);
  url.protocol = origin.protocol;
  url.host = origin.host;
  // Preserve method, headers, and body; the browser's Origin header passes
  // through untouched, so the origin's ALLOWED_ORIGINS gate keeps working.
  return fetch(new Request(url, request));
}

async function serveAsset(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith("/asset/data/") || path.startsWith("/asset/config/")) {
    return new Response("Not found", { status: 404 });
  }

  // R2 lookup only makes sense for reads.
  if (request.method === "GET" || request.method === "HEAD") {
    const key = decodeURIComponent(path.slice("/asset/".length));
    if (key) {
      const obj = await (request.method === "HEAD"
        ? env.BUCKET.head(key)
        : env.BUCKET.get(key));
      if (obj) {
        const headers = new Headers();
        headers.set("etag", obj.httpEtag);
        headers.set("content-type", contentTypeFor(key));
        headers.set(
          "cache-control",
          IMMUTABLE_EXT.test(key)
            ? "public, max-age=2592000, immutable"
            : "public, max-age=300, must-revalidate"
        );
        // Cheap conditional-get support for repeat visitors.
        const inm = request.headers.get("if-none-match");
        if (inm && inm === obj.httpEtag) {
          return new Response(null, { status: 304, headers });
        }
        if (request.method === "HEAD") {
          headers.set("content-length", String(obj.size));
          return new Response(null, { status: 200, headers });
        }
        return new Response(obj.body, { status: 200, headers });
      }
    }
  }

  // Not in R2 (or a write) → the origin may have it (dynamic renders).
  return proxyToOrigin(request, env);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/asset" || pathname.startsWith("/asset/")) {
      return serveAsset(request, env);
    }
    return proxyToOrigin(request, env);
  },

  async scheduled(_event, env, ctx) {
    // Reap abandoned [MOCKUP] Printify drafts. The held connection keeps
    // the scale-to-zero origin awake for the sweep's duration; the TTL
    // logic is idempotent so retries/overlaps converge.
    ctx.waitUntil(
      fetch(`${env.ORIGIN}/api/printify/admin/sweep_mockup_drafts`, {
        method: "POST",
        headers: { "X-Admin-Key": env.ADMIN_KEY || "" },
      }).then(async (r) => {
        console.log(`mockup sweep: ${r.status} ${await r.text()}`);
      }).catch((e) => console.log(`mockup sweep failed: ${e}`))
    );
  },
};
