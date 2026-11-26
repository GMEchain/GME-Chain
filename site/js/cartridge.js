// The hero's signature: a game cartridge in real 3D, lit, then drawn as terminal characters. GameStop sells games;
// GME CHAIN is the cartridge you plug in. Faces are shaded into a tiny offscreen canvas, one pixel per character
// cell: red holds the light level, green the material, blue the label art (a big "GME", mapped onto the label).
// It follows the pointer, pauses off screen and in background tabs, and draws one still frame for reduced motion.
const RAMP = " .,:;-=+*x%#";
const SHELL = 1, LABEL = 2, RIDGE = 3, EDGE = 4, CAP = 5;
const BASE = { [SHELL]: 0.1, [LABEL]: 0.3, [RIDGE]: 0.22, [EDGE]: 0.14, [CAP]: 0.16 };

// an axis-aligned box as 6 quads; each keeps its box centre so its normal can be pointed outwards
function box(out, [cx, cy, cz], [w, h, d], front, sides = SHELL) {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  const c = [cx, cy, cz];
  out.push(
    { p: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], c, mat: front, front: true },
    { p: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], c, mat: sides },
    { p: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], c, mat: sides },
    { p: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], c, mat: sides },
    { p: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], c, mat: sides },
    { p: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], c, mat: sides },
  );
}

function cartridge() {
  const f = [];
  box(f, [0, -0.17, 0], [1.8, 1.9, 0.42], SHELL);                 // body
  box(f, [0, 0.98, 0], [2.06, 0.46, 0.48], CAP, CAP);              // wider top, like a retro cart
  box(f, [0, 0.14, 0.226], [1.4, 1.16, 0.03], LABEL);              // label
  for (let i = 0; i < 7; i++) box(f, [-0.6 + i * 0.2, -0.86, 0.226], [0.09, 0.3, 0.05], RIDGE, RIDGE); // grip
  box(f, [0, -1.16, 0], [1.36, 0.14, 0.3], EDGE, EDGE);            // connector edge
  return f;
}

// the label art, drawn once into the blue channel
function labelArt() {
  const c = document.createElement("canvas");
  c.width = 240; c.height = 200;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, 240, 200);
  g.fillStyle = "#0000ff";
  g.font = '900 150px "Big Shoulders Display", Impact, "Arial Narrow", sans-serif';
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("GME", 120, 104);
  g.fillRect(24, 182, 192, 10);                                    // a stripe under the name
  g.beginPath(); g.moveTo(120, 6); g.lineTo(136, 26); g.lineTo(104, 26); g.closePath(); g.fill(); // ▲ insert this end
  return c;
}

export function mountCartridge(canvas) {
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas");
  const octx = off.getContext("2d", { willReadFrequently: true });
  const faces = cartridge();
  let art = labelArt();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0, cols = 0, rows = 0, cw = 9, ch = 16, dpr = 1, font = "";
  let px = 0, py = 0, tx = 0, ty = 0, visible = true, raf = 0, last = 0;
  const particles = Array.from({ length: 26 }, () => ({ x: Math.random(), y: Math.random(), s: 0.02 + Math.random() * 0.05, c: ["▲", "$", "+", "▲", "A", "B", "▼"][Math.floor(Math.random() * 7)], a: 0.1 + Math.random() * 0.22 }));

  function size() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const fs = W < 520 ? 9 : 12;
    cw = fs * 0.62; ch = fs * 1.15;
    cols = Math.max(1, Math.floor(W / cw)); rows = Math.max(1, Math.floor(H / ch));
    off.width = cols; off.height = rows;
    font = `600 ${fs}px "JetBrains Mono", ui-monospace, monospace`;
  }

  function frame(t) {
    const time = reduced ? 0 : t / 1000;
    px += (tx - px) * 0.06; py += (ty - py) * 0.06;
    const yaw = -0.5 + Math.sin(time * 0.45) * 0.42 + px * 0.6;
    const pitch = -0.2 + Math.sin(time * 0.31) * 0.08 + py * 0.3;
    const roll = 0.1 + Math.sin(time * 0.6) * 0.035;
    const bob = Math.sin(time * 1.1) * 0.05;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const scale = Math.min(cols * cw, rows * ch) * 0.34;
    const rot = ([x, y, z]) => {
      const x0 = x * cr - y * sr, y0 = x * sr + y * cr;
      const x1 = x0 * cy - z * sy, z1 = x0 * sy + z * cy;
      return [x1, y0 * cp - z1 * sp + bob, y0 * sp + z1 * cp];
    };
    const proj = ([x, y, z]) => { const k = 5 / (5 - z); return [cols / 2 + (x * k * scale) / cw, rows / 2 - (y * k * scale) / ch]; };
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = "source-over";
    octx.fillStyle = "#000"; octx.fillRect(0, 0, cols, rows);
    const L = [-0.5, 0.65, 0.6], Ln = Math.hypot(...L);
    const drawn = [];
    for (const q of faces) {
      const P = q.p.map(rot), C = rot(q.c);
      const [a, b, c] = P;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const mx = (a[0] + c[0]) / 2 - C[0], my = (a[1] + c[1]) / 2 - C[1], mz = (a[2] + c[2]) / 2 - C[2];
      if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      if (nz <= 0.02) continue;
      drawn.push({ S: P.map(proj), nx, ny, nz, q, depth: P.reduce((s, v) => s + v[2], 0) / 4, decal: q.mat === LABEL || q.mat === RIDGE });
    }
    // the label and grip sit on the front face: paint them after the shell, so a large tilted face never covers them
    drawn.sort((p, q) => (p.decal - q.decal) || (p.depth - q.depth));
    for (const d of drawn) {
      const diff = Math.max(0, (d.nx * L[0] + d.ny * L[1] + d.nz * L[2]) / Ln);
      const spec = Math.pow(Math.max(0, d.nz * 0.75 + d.ny * 0.45 - d.nx * 0.3), 14);
      const b = Math.max(0, Math.min(1, BASE[d.q.mat] + diff * 0.55 + spec * 0.4));
      const path = () => { octx.beginPath(); d.S.forEach(([x, y], k) => (k ? octx.lineTo(x, y) : octx.moveTo(x, y))); octx.closePath(); };
      octx.globalCompositeOperation = "source-over";
      octx.fillStyle = `rgb(${Math.round(b * 255)},${d.q.mat * 40},0)`;
      path(); octx.fill();
      if (d.q.mat === LABEL && d.q.front) {
        // map the label art onto the label quad (affine: top-left, top-right, bottom-left corners)
        const [bl, br, tr, tl] = d.S;
        octx.save(); path(); octx.clip();
        octx.globalCompositeOperation = "lighter";
        octx.setTransform((tr[0] - tl[0]) / art.width, (tr[1] - tl[1]) / art.width, (bl[0] - tl[0]) / art.height, (bl[1] - tl[1]) / art.height, tl[0], tl[1]);
        octx.drawImage(art, 0, 0);
        octx.restore();
      }
    }
    const data = octx.getImageData(0, 0, cols, rows).data;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = font; ctx.textBaseline = "top";
    for (const p of particles) {
      if (!reduced) { p.y -= p.s * 0.016; if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); } }
      ctx.fillStyle = p.c === "▼" ? `rgba(255,77,141,${p.a})` : `rgba(255,45,45,${p.a})`;
      ctx.fillText(p.c, p.x * W, p.y * H);
    }
    const scan = reduced ? -10 : ((time * 0.22) % 1.3 - 0.15) * rows; // a price-feed sweep
    const lit = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && data[(y * cols + x) * 4] > 8;
    const buckets = new Map();
    const put = (style, chr, x, y) => { if (!buckets.has(style)) buckets.set(style, []); buckets.get(style).push(chr, x * cw, y * ch); };
    for (let y = 0; y < rows; y++) {
      const boost = Math.max(0, 1 - Math.abs(y - scan) / 2.5) * 0.28;
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        if (data[i] <= 8) continue;
        const mat = Math.round(data[i + 1] / 40);
        let b = data[i] / 255 + boost + (((x * 7 + y * 13) % 5) - 2) * 0.018;
        const edge = !lit(x - 1, y) || !lit(x + 1, y) || !lit(x, y - 1) || !lit(x, y + 1);
        if (mat === LABEL) {
          const ink = data[i + 2] > 110;
          if (ink) put("rgba(244,241,255,.97)", "#", x, y);
          else put(`rgba(255,45,45,${(0.18 + b * 0.3).toFixed(2)})`, ":", x, y);
          continue;
        }
        if (edge) { put("rgba(255,170,170,.95)", y === 0 || !lit(x, y - 1) || !lit(x, y + 1) ? "=" : "|", x, y); continue; }
        b = Math.max(0, Math.min(1, b));
        const lvl = Math.min(9, Math.floor(b * 10));
        put(`rgba(255,45,45,${(0.2 + (lvl / 9) * 0.75).toFixed(2)})`, RAMP[Math.min(RAMP.length - 1, Math.floor(b * RAMP.length))], x, y);
      }
    }
    for (const [style, list] of buckets) {
      ctx.fillStyle = style;
      for (let k = 0; k < list.length; k += 3) ctx.fillText(list[k], list[k + 1], list[k + 2]);
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < 33) return; // ~30 fps is plenty for characters
    last = t;
    frame(t);
  }
  const start = () => { if (!raf && visible && !document.hidden && !reduced) raf = requestAnimationFrame(loop); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };

  size();
  frame(performance.now());
  document.fonts?.ready.then(() => { art = labelArt(); size(); frame(performance.now()); });
  addEventListener("resize", () => { size(); frame(performance.now()); });
  addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2 + 200)));
    ty = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2 + 200)));
  }, { passive: true });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  start();
}
