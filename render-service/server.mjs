// Minimal HTTP wrapper around web3d/tools/render-plate.mjs.
//
// Stateless: POST /render {date, channel, look, sky, guide, size} -> PNG
// bytes, or a 422/500 explaining why render-plate.mjs refused. No queue, no
// retries — api/main.py's existing heavy-render semaphore already serializes
// expensive jobs before they reach this service; this just does the one
// thing, once per request.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 8090);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const WEB3D_DIR = path.resolve(HERE, "..", "web3d");
const DIST_DIR = path.join(WEB3D_DIR, "dist");
const RENDER_SCRIPT = path.join(WEB3D_DIR, "tools", "render-plate.mjs");
const CHROME_PATH = chromium.executablePath();

// The production build sets base: "/experience/" (it's served under that
// path by the Cloudflare Worker) — mirrored here so the built asset URLs in
// dist/index.html actually resolve. Served by THIS process directly rather
// than `vite preview`: preview's static serving 404'd on Chromium's real
// module-script requests (fine for a manual curl, consistently broken for
// the browser — never fully root-caused, likely a compression-negotiation
// path) and this app only ever loads one fixed URL, so a plain static file
// server removes an entire subprocess instead of chasing that further.
const BASE_PATH = "/experience/";
const PLATE_URL = `http://127.0.0.1:${PORT}${BASE_PATH}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
};

const LOOKS = new Set(["raw", "rhef"]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LAYER_KEYS = ["stars", "con", "art", "labels", "planets", "grid"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The app's texture/RHEF fetches are relative (`/api/...`, `/asset/...`) so
// they land same-origin on THIS server. Forward them to the real backend
// with a spoofed Origin/Referer — same trick web3d/vite.config.ts's dev
// proxy already uses, reimplemented here because this service has no vite
// server in front of it to do it for us.
const DEV_API = process.env.PLATE_DEV_API || "https://myheliograph.com";

async function proxyToOrigin(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const upstream = await fetch(DEV_API + req.url, {
    method: req.method,
    headers: {
      ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
      origin: DEV_API,
      referer: `${DEV_API}/`,
    },
    body,
  });
  const headers = Object.fromEntries(upstream.headers);
  delete headers["content-encoding"]; // fetch already decoded the body
  res.writeHead(upstream.status, headers);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function serveStatic(req, res) {
  let rel = req.url.slice(BASE_PATH.length).split("?")[0];
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const filePath = path.join(DIST_DIR, rel);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}

function validate(body) {
  const { date, time, channel, look = "raw", sky, guide, size } = body;
  if (!DATE_RE.test(date)) throw new Error("date must be YYYY-MM-DD");
  const ch = Number(channel);
  if (!Number.isInteger(ch) || ch < 0 || ch > 7) throw new Error("channel must be an integer 0-7");
  if (!LOOKS.has(look)) throw new Error("look must be 'raw' or 'rhef'");
  const sz = Number(size ?? 2048);
  if (!Number.isInteger(sz) || sz < 256 || sz > 4096) throw new Error("size must be an integer 256-4096");
  if (time != null && !TIME_RE.test(String(time))) throw new Error("time must be HH:MM");
  // The six sky layers, tri-state: true, false, or "not stated" (absent), so a
  // caller that does not care still gets the experience's own defaults. These
  // are what make an ordered dimensional print match the preview the visitor
  // approved — see the note in render-plate.mjs.
  const layers = {};
  for (const k of LAYER_KEYS) {
    if (body[k] == null) continue;
    layers[k] = body[k] === true || body[k] === 1 || body[k] === "1";
  }
  return {
    date,
    time: time == null ? null : String(time),
    channel: ch,
    look,
    sky: !!sky,
    guide: !!guide,
    size: sz,
    layers,
  };
}

async function render(params) {
  const outDir = await mkdtemp(path.join(tmpdir(), "plate-"));
  const env = {
    ...process.env,
    PLATE_CHROME_PATH: CHROME_PATH,
    PLATE_URL,
    PLATE_OUT: outDir,
    PLATE_SIZE: String(params.size),
    PLATE_DATE: params.date,
    PLATE_CHANNEL: String(params.channel),
    PLATE_LOOK: params.look,
    PLATE_SKY: params.sky ? "1" : "0",
    PLATE_GUIDE: params.guide ? "1" : "0",
  };
  if (params.time) env.PLATE_TIME = params.time;
  for (const [k, v] of Object.entries(params.layers)) {
    env[`PLATE_${k.toUpperCase()}`] = v ? "1" : "0";
  }
  try {
    const exitCode = await new Promise((resolve) => {
      const p = spawn("node", [RENDER_SCRIPT], { env, stdio: ["ignore", "inherit", "inherit"] });
      p.on("exit", resolve);
    });
    if (exitCode !== 0) {
      // render-plate.mjs exits 2 when it deliberately REFUSES to write a
      // plate (texture or RHEF frame never reached "ready") — that's a
      // data/timing problem, not a service bug, so callers see 422 and can
      // retry instead of treating it like a crash.
      throw Object.assign(new Error(`render-plate.mjs exited ${exitCode}`), {
        status: exitCode === 2 ? 422 : 500,
      });
    }
    const files = await readdir(outDir);
    const png = files.find((f) => f.endsWith(".png"));
    if (!png) throw Object.assign(new Error("render exited 0 but wrote no PNG"), { status: 500 });
    return await readFile(path.join(outDir, png));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "GET" && req.url.startsWith(BASE_PATH)) {
    await serveStatic(req, res);
    return;
  }
  if (req.url.startsWith("/api/") || req.url.startsWith("/asset/")) {
    await proxyToOrigin(req, res);
    return;
  }
  if (req.method !== "POST" || req.url !== "/render") {
    res.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const params = validate(body);
    console.log("[render] start", params);
    const png = await render(params);
    console.log("[render] done", params, `${png.length} bytes`);
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
    res.end(png);
  } catch (err) {
    const status = Number.isInteger(err.status) ? err.status : 400;
    console.error("[render] failed:", err.message);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => console.log(`render service listening on :${PORT}`));
