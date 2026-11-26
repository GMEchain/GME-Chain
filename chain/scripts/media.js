// GME CHAIN media: images for launchpad tokens, stored by content hash.
//
//   POST /upload            body = the image bytes (PNG, JPEG or WebP, at most 300 KB)
//                           -> {"url": "https://gmechain.xyz/media/i/<sha256>.<ext>", "sha256": "..."}
//   GET  /i/<sha256>.<ext>  the image (immutable; the name is the SHA-256 of the bytes)
//   GET  /health
//
// The website resizes the picture to 256x256 in the browser before uploading. Files are named by the
// SHA-256 of their bytes, so the URL saved in a token's on-chain metadata pins the exact image: it can never
// be swapped later. Only real images are accepted (checked from the file's bytes, not its name), uploads are
// rate-limited per IP, and images are served with headers that stop browsers from treating them as anything else.
//
// Env: MEDIA_DIR (default /data/media), PUBLIC_BASE (default https://gmechain.xyz/media), PORT,
//      UPLOADS_PER_HOUR (per IP, default 30), MAX_TOTAL_MB (default 2000)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIR = process.env.MEDIA_DIR || "/data/media";
const BASE = (process.env.PUBLIC_BASE || "https://gmechain.xyz/media").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 8080);
const MAX_BYTES = 300 * 1024;
const PER_HOUR = Number(process.env.UPLOADS_PER_HOUR || 30);
const MAX_TOTAL = Number(process.env.MAX_TOTAL_MB || 2000) * 1024 * 1024;
fs.mkdirSync(DIR, { recursive: true });
const writable = () => { try { fs.accessSync(DIR, fs.constants.W_OK); return true; } catch { return false; } };
if (!writable()) console.error(`${DIR} is not writable by this user: uploads will fail`);

const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
/** Image type from the file's first bytes (magic numbers), or null. */
export function sniff(b) {
  if (b.length >= 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * The path of a stored image, built only from trusted parts: the name is the hex of exactly 32 bytes
 * re-encoded from the request, the extension comes from a fixed list, and the result must sit directly
 * inside DIR. Anything else gives null.
 */
const EXTS = { png: "png", jpg: "jpg", webp: "webp" };
function storedFile(hexName, ext) {
  const bytes = Buffer.from(String(hexName), "hex");
  const safeExt = Object.hasOwn(EXTS, ext) ? EXTS[ext] : null;
  if (bytes.length !== 32 || !safeExt) return null;
  const base = path.resolve(DIR);
  const file = path.resolve(base, `${bytes.toString("hex")}.${safeExt}`);
  return path.dirname(file) === base ? file : null;
}

let total = 0;
for (const f of fs.readdirSync(DIR)) { try { total += fs.statSync(path.join(DIR, f)).size; } catch { /* skip */ } }
const hits = new Map(); // ip -> timestamps in the last hour
const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const clientIp = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "https://media.local");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, writable: writable(), files: fs.readdirSync(DIR).length, totalMB: Math.round(total / 1048576) });

    const m = /^\/i\/([0-9a-f]{64})\.(png|jpg|webp)$/.exec(url.pathname);
    if ((req.method === "GET" || req.method === "HEAD") && m) {
      const file = storedFile(m[1], m[2]);
      if (!file || !fs.existsSync(file)) { res.writeHead(404, { "cache-control": "no-store" }); return res.end(); }
      res.writeHead(200, {
        "content-type": TYPES[m[2]],
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        // token logos are meant to be shown anywhere (wallets, explorers, listing sites)
        "cross-origin-resource-policy": "cross-origin",
        "access-control-allow-origin": "*",
      });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method !== "POST" || url.pathname !== "/upload") return json(res, 404, { error: "not found" });
    const ip = clientIp(req), now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
    if (recent.length >= PER_HOUR) return json(res, 429, { error: "Too many uploads from this network. Try again later." });
    if (Number(req.headers["content-length"] || 0) > MAX_BYTES) return json(res, 413, { error: "The image is too large (max 300 KB)." });

    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BYTES) return json(res, 413, { error: "The image is too large (max 300 KB)." }); chunks.push(c); }
    const buf = Buffer.concat(chunks);
    const ext = sniff(buf);
    if (!ext) return json(res, 415, { error: "Only PNG, JPEG or WebP images are accepted." });
    if (total + buf.length > MAX_TOTAL) return json(res, 507, { error: "Image storage is full. Try again later." });

    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const name = `${sha}.${ext}`, file = storedFile(sha, ext);
    if (!file) return json(res, 500, { error: "Upload failed. Try again." });
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf, { flag: "wx" });
      fs.renameSync(tmp, file);
      total += buf.length;
    }
    recent.push(now); hits.set(ip, recent);
    log("upload", { name, bytes: buf.length });
    return json(res, 200, { url: `${BASE}/i/${name}`, sha256: sha });
  } catch (e) {
    log("error", { err: e.message });
    return json(res, 500, { error: "Upload failed. Try again." });
  }
}).listen(PORT, () => log("media service started", { dir: DIR, base: BASE }));

// forget rate-limit entries older than an hour
setInterval(() => { const now = Date.now(); for (const [ip, ts] of hits) { const r = ts.filter((t) => now - t < 3600_000); if (r.length) hits.set(ip, r); else hits.delete(ip); } }, 600_000);
