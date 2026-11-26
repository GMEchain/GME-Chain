// NYSE regular session (9:30 to 16:00 New York time) next to GME CHAIN, which never closes.
// Holidays follow the exchange's rules (observed dates included); early closes at 13:00 on the day after
// Thanksgiving and on Christmas Eve. Pre- and after-hours trading is not counted as open.
const TZ = "America/New_York";
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
const nyParts = (d) => Object.fromEntries(fmt.formatToParts(d).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
const key = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const nthWeekday = (y, m, wd, n) => { let d = 1; while (dow(y, m, d) !== wd) d++; return d + 7 * (n - 1); };
const lastWeekday = (y, m, wd) => { let d = new Date(Date.UTC(y, m, 0)).getUTCDate(); while (dow(y, m, d) !== wd) d--; return d; };
function easter(y) { // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
const shift = (y, m, d, days) => { const t = new Date(Date.UTC(y, m - 1, d + days)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };
const observed = (y, m, d) => { const w = dow(y, m, d); return w === 6 ? shift(y, m, d, -1) : w === 0 ? shift(y, m, d, 1) : [y, m, d]; };
const cache = {};
function calendar(y) {
  if (cache[y]) return cache[y];
  const hol = {};
  const add = (name, [yy, mm, dd]) => { if (yy === y) hol[key(yy, mm, dd)] = name; };
  if (dow(y, 1, 1) !== 6) add("New Year's Day", observed(y, 1, 1)); // a Saturday New Year is not moved to Friday
  add("Martin Luther King Jr. Day", [y, 1, nthWeekday(y, 1, 1, 3)]);
  add("Presidents' Day", [y, 2, nthWeekday(y, 2, 1, 3)]);
  const [em, ed] = easter(y); add("Good Friday", shift(y, em, ed, -2));
  add("Memorial Day", [y, 5, lastWeekday(y, 5, 1)]);
  add("Juneteenth", observed(y, 6, 19));
  add("Independence Day", observed(y, 7, 4));
  add("Labor Day", [y, 9, nthWeekday(y, 9, 1, 1)]);
  const tg = nthWeekday(y, 11, 4, 4); add("Thanksgiving", [y, 11, tg]);
  add("Christmas", observed(y, 12, 25));
  const early = {};
  early[key(...shift(y, 11, tg, 1))] = true;
  if (![0, 6].includes(dow(y, 12, 24)) && !hol[key(y, 12, 24)]) early[key(y, 12, 24)] = true;
  return (cache[y] = { hol, early });
}
// UTC instant of a New York wall-clock time (handles EST/EDT)
function nyToDate(y, m, d, h, mi) {
  let t = Date.UTC(y, m - 1, d, h + 5, mi); // EST guess
  if (Number(nyParts(new Date(t)).hour) !== h) t -= 3600_000; // EDT
  return new Date(t);
}
function session(y, m, d) {
  const { hol, early } = calendar(y), k = key(y, m, d), w = dow(y, m, d);
  if (w === 0 || w === 6) return { closed: "Weekend" };
  if (hol[k]) return { closed: hol[k] };
  return { open: nyToDate(y, m, d, 9, 30), close: nyToDate(y, m, d, early[k] ? 13 : 16, 0), early: !!early[k] };
}
export function nyseStatus(now = new Date()) {
  const p = nyParts(now), y = +p.year, m = +p.month, d = +p.day;
  const today = session(y, m, d);
  if (today.open && now >= today.open && now < today.close) return { open: true, until: today.close, early: today.early };
  const why = today.closed || (today.open && now < today.open ? "Pre-market" : "After hours");
  for (let i = 0, c = [y, m, d]; i < 10; i++) {
    const s = session(...c);
    if (s.open && s.open > now) return { open: false, why, next: s.open };
    c = shift(...c, 1);
  }
  return { open: false, why };
}
const span = (ms) => { const mins = Math.max(0, Math.round(ms / 60000)), h = Math.floor(mins / 60); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${mins % 60}m`; };
const dayName = (d) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);

export function mountMarketClock(root) {
  if (!root) return;
  const state = root.querySelector("[data-nyse-state]"), note = root.querySelector("[data-nyse-note]");
  const tick = () => {
    const s = nyseStatus();
    root.classList.toggle("is-open", s.open);
    state.textContent = s.open ? "Open" : "Closed";
    note.textContent = s.open
      ? `closes ${s.early ? "early " : ""}in ${span(s.until - Date.now())}`
      : `${s.why}${s.next ? ` · opens ${dayName(s.next)} 9:30 ET, in ${span(s.next - Date.now())}` : ""}`;
  };
  tick();
  setInterval(tick, 30_000);
}
