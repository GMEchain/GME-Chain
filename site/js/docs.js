// Docs page: sidebar filter, scroll-spy for the current section, add-network button.
import { addNetwork, friendlyError } from "./wallet.js";
import { L3 } from "./config.js";

const links = [...document.querySelectorAll(".docs-side nav a")];
const byHash = (h) => (h && h.startsWith("#") ? document.getElementById(h.slice(1)) : null); // external links (like /roadmap/) have no section
const sections = links.map((a) => byHash(a.getAttribute("href"))).filter(Boolean);

// scroll-spy: the last section whose top has passed a line under the header
let ticking = false;
function spy() {
  ticking = false;
  const line = innerHeight * 0.28;
  let current = sections[0]?.id;
  for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s.id;
  links.forEach((a) => {
    const on = a.getAttribute("href") === `#${current}`;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current");
  });
}
addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
spy();

// contents toggle (shown on small screens by CSS)
(() => {
  const side = document.querySelector(".docs-side");
  if (!side) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "docs-toggle";
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = 'Contents <span aria-hidden="true">+</span>';
  side.prepend(btn);
  btn.addEventListener("click", () => { const open = side.classList.toggle("open"); btn.setAttribute("aria-expanded", String(open)); });
  side.querySelectorAll("nav a").forEach((a) => a.addEventListener("click", () => { side.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }));
})();

// filter: hide sidebar entries (and empty groups) that do not match
const filter = document.querySelector("[data-doc-filter]");
filter?.addEventListener("input", () => {
  const q = filter.value.trim().toLowerCase();
  document.querySelectorAll(".docs-side nav ul").forEach((ul) => {
    let shown = 0;
    ul.querySelectorAll("li").forEach((li) => {
      const id = li.querySelector("a").getAttribute("href");
      const text = (li.textContent + " " + (byHash(id)?.textContent || "")).toLowerCase();
      const hit = !q || text.includes(q);
      li.hidden = !hit;
      if (hit) shown++;
    });
    ul.hidden = shown === 0;
    const label = ul.previousElementSibling;
    if (label?.classList.contains("side-group")) label.hidden = shown === 0;
  });
});

// add network
document.querySelectorAll("[data-add-l3]").forEach((b) => b.addEventListener("click", async () => {
  const msg = document.querySelector("[data-add-msg]");
  try { await addNetwork(L3.id); if (msg) { msg.textContent = "GME CHAIN is in your wallet."; msg.dataset.kind = "ok"; } }
  catch (e) { if (msg) { msg.textContent = friendlyError(e); msg.dataset.kind = "bad"; } }
}));

// connect button in the header just opens the bridge, where wallets are used
document.querySelectorAll("[data-connect]").forEach((b) => b.addEventListener("click", () => { location.href = "../bridge/"; }));
