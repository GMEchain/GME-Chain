// Behaviour shared by every page: mobile menu, a header that hides while you scroll down, one-click copy,
// reveal-on-scroll, the particle wordmark in the footer and confetti after a transaction (window.gmeConfetti).
(() => {
  "use strict";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---------- mobile menu ----------
  const sheet = document.getElementById("sheet");
  const openBtn = document.querySelector("[data-menu]");
  function closeMenu() {
    if (!sheet || !sheet.classList.contains("open")) return;
    sheet.classList.remove("open");
    openBtn?.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
    openBtn?.focus();
  }
  openBtn?.addEventListener("click", () => {
    sheet.classList.add("open");
    openBtn.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    sheet.querySelector("a")?.focus();
  });
  document.querySelector("[data-menu-close]")?.addEventListener("click", closeMenu);
  sheet?.addEventListener("click", (e) => { if (e.target.closest("a")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  // ---------- header steps aside on the way down, returns on the way up ----------
  const top = document.querySelector("[data-top]");
  if (top) {
    let last = scrollY;
    addEventListener("scroll", () => {
      const y = scrollY;
      if (Math.abs(y - last) < 6) return;
      top.classList.toggle("hide", y > last && y > 320 && !top.contains(document.activeElement));
      last = y;
    }, { passive: true });
  }

  // ---------- copy ----------
  document.addEventListener("click", async (e) => {
    const b = e.target.closest?.("[data-copy]");
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
    b.classList.add("copied");
    setTimeout(() => b.classList.remove("copied"), 1400);
  });

  // ---------- reveal on scroll ----------
  const items = $$(".rv");
  if (reduced || !("IntersectionObserver" in window)) items.forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }), { rootMargin: "0px 0px -8% 0px" });
    items.forEach((el) => io.observe(el));
  }

  // ---------- footer wordmark as particle code: "GME chain" built from characters that scatter from the pointer ----------
  const wm = document.querySelector("[data-wordmark]");
  if (wm) {
    const ctx = wm.getContext("2d");
    let parts = [], W = 0, H = 0, cw = 7, ch = 12, raf = 0, on = false, px = -1e4, py = -1e4, last = 0;
    const build = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = wm.clientWidth || wm.parentElement.clientWidth;
      if (w < 80) return; // not laid out yet; the next resize builds it
      W = w; H = Math.round(W * 0.27);
      wm.style.height = H + "px"; wm.width = W * dpr; wm.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cw = W < 600 ? 5 : 7; ch = Math.round(cw * 1.7);
      const cols = Math.max(1, Math.floor(W / cw)), rows = Math.max(1, Math.floor(H / ch));
      const o = document.createElement("canvas"); o.width = cols; o.height = rows;
      const g = o.getContext("2d"); g.textBaseline = "alphabetic";
      const size = rows * 1.02;
      const fGme = `900 ${size}px "Big Shoulders Display", Impact, sans-serif`, fChain = `italic 400 ${size * 1.02}px "Instrument Serif", Georgia, serif`;
      g.font = fGme; const wGme = g.measureText("GME").width + cols * 0.012;
      g.font = fChain; const wChain = g.measureText("chain").width;
      const ox = Math.max(0, (cols - wGme - wChain) / 2); // centered
      g.font = fGme; g.fillStyle = "#f00"; g.fillText("GME", ox, rows * 0.9);
      g.font = fChain; g.fillStyle = "#0f0"; g.fillText("chain", ox + wGme, rows * 0.86);
      const d = g.getImageData(0, 0, cols, rows).data, old = parts;
      parts = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4, red = d[i] > 110, green = d[i + 1] > 110;
        if (!red && !green) continue;
        const hx = x * cw, hy = y * ch, p = old[parts.length];
        parts.push({ hx, hy, x: p ? p.x : Math.random() * W, y: p ? p.y : H + Math.random() * H, vx: 0, vy: 0, c: green ? 1 : 0, k: Math.random() });
      }
    };
    const GME = "GME$#", CH = "chain▲";
    const draw = (t) => {
      ctx.clearRect(0, 0, W, H);
      ctx.font = `600 ${ch * 0.95}px ui-monospace, Menlo, Consolas, monospace`; ctx.textBaseline = "top";
      const slot = Math.floor(t / 180);
      for (const p of parts) {
        if (!reduced) {
          const dx = p.x - px, dy = p.y - py, d2 = dx * dx + dy * dy;
          if (d2 < 6400) { const f = (6400 - d2) / 6400 * 2.4; const d = Math.sqrt(d2) || 1; p.vx += (dx / d) * f; p.vy += (dy / d) * f; }
          p.vx += (p.hx - p.x) * 0.045; p.vy += (p.hy - p.y) * 0.045; p.vx *= 0.82; p.vy *= 0.82; p.x += p.vx; p.y += p.vy;
        } else { p.x = p.hx; p.y = p.hy; }
        const set = p.c ? CH : GME, glyph = set[(Math.floor(p.k * 97) + slot) % set.length];
        ctx.fillStyle = p.c ? `rgba(255,45,45,${0.65 + p.k * 0.35})` : `rgba(235,235,240,${0.18 + p.k * 0.3})`;
        ctx.fillText(glyph, p.x, p.y);
      }
    };
    const loop = (t) => { raf = requestAnimationFrame(loop); if (t - last < 33) return; last = t; draw(t); };
    const start = () => { if (!raf && on && !document.hidden) raf = requestAnimationFrame(loop); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
      let tries = 0;
      const init = () => { build(); if (!W && tries++ < 60) requestAnimationFrame(init); else draw(0); };
      init();
      addEventListener("resize", () => { build(); draw(performance.now()); });
      wm.addEventListener("pointermove", (e) => { const r = wm.getBoundingClientRect(); px = e.clientX - r.left; py = e.clientY - r.top; });
      wm.addEventListener("pointerleave", () => { px = py = -1e4; });
      if (reduced) return;
      new IntersectionObserver(([e]) => { on = e.isIntersecting; on ? start() : stop(); }).observe(wm);
      document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
    });
  }

  // ---------- pixel confetti: window.gmeConfetti() after a successful transaction ----------
  window.gmeConfetti = () => {
    if (reduced) return;
    const c = document.createElement("canvas");
    c.className = "confetti";
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    document.body.append(c);
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    const colors = ["#FF2D2D", "#FFFFFF", "#FF2D2D", "#8F0D12", "#B8B8BC"];
    const bits = Array.from({ length: 140 }, () => ({
      x: innerWidth / 2 + (Math.random() - .5) * 160, y: innerHeight * .35,
      vx: (Math.random() - .5) * 14, vy: -Math.random() * 13 - 4,
      s: 6 + Math.floor(Math.random() * 3) * 3, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    const frame = (t) => {
      g.clearRect(0, 0, innerWidth, innerHeight);
      bits.forEach((b) => { b.vy += .45; b.x += b.vx; b.y += b.vy; b.vx *= .99; g.fillStyle = b.c; g.fillRect(Math.round(b.x), Math.round(b.y), b.s, b.s); });
      if (t - t0 < 2600) requestAnimationFrame(frame); else c.remove();
    };
    requestAnimationFrame(frame);
  };
})();
