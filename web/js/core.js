/* Pit Wall page: shared data, DOM helpers and formatters. The page's scripts are ES modules (entry: main.js), bundled
   by tools/bundle.js into the one script refresh.py inlines. Engine and Hindsight are classic scripts loaded before
   the bundle; the data is a JSON block refresh.py fills in. */
export const DATA = JSON.parse(document.getElementById("pw-data").textContent);
export const CFG = DATA.cfg || { teams: {}, defaultTeam: { drivers: [], constructors: [] }, field: 22 };
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export const f1 = (x) => (x == null || isNaN(x) ? "—" : (Math.round(x * 10) / 10).toFixed(1));
export const f0 = (x) => (x == null || isNaN(x) ? "—" : Math.round(x).toString());
export const sgn = (x, d = 1) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d);
export const money = (x) => "$" + x.toFixed(1) + "m";
export const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
export const shortDate = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

// team colours and constructor codes from config/season.json
const TEAMS = Object.fromEntries(Object.entries(CFG.teams).filter(([k]) => !k.startsWith("_")));
export const CHIPS = [
  ["x3", "X3", "x3 Boost"],
  ["limitless", "LL", "Limitless"],
  ["wildcard", "WC", "Wildcard"],
  ["noneg", "NN", "No Negative"],
  ["autopilot", "AP", "Autopilot"],
  ["finalfix", "FF", "Final Fix"],
];
export const chipName = (k) => (CHIPS.find(([c]) => c === k) || [])[2] || "";
export const chipShort = (k) => (CHIPS.find(([c]) => c === k) || [])[1] || "";

// A team's key (see teamKey): the first 16 hex digits of SHA-256("<F1 account guid>:<team number>"), the same as
// f1feeds.team_key in Python. Hashed so no account id is kept; null where WebCrypto isn't available (plain http).
const hash16 = async (text) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
export async function teamTk(guid, no) {
  if (!guid || no == null || !globalThis.crypto || !crypto.subtle) return null;
  return hash16(`${guid}:${no}`);
}
// An F1 account's key for Team Tracking: SHA-256 of its account guid, first 16 hex (f1feeds.account_key).
export async function accountKey(guid) {
  if (!guid || !globalThis.crypto || !crypto.subtle) return null;
  return hash16(String(guid));
}
export const byId = Object.fromEntries(DATA.assets.map((a) => [a.id, a]));
/* ---------- table alignment, the same in every table ----------
   Text left, numbers right, controls (buttons, toggles, mini charts) centred, number boxes right; each header follows its column. Decided
   per column from its cells (main.js re-runs it whenever a table's content changes), so no table needs its own
   alignment rules. A cell with a control and a name (Compare's team + ✎) counts as text. */
const AL_NUM = /^[#−+\-–]?\$?\d[\d.,]*[%mM×]?(?:[−+\-–/·][−+-]?\$?\d[\d.,]*[%mM×]?)*[✓?▲▼]?$/;
export function alignTable(t) {
  const head = t.tHead && t.tHead.rows[t.tHead.rows.length - 1];
  if (!head) return;
  const at = (r) => {
    let k = 0;
    return [...r.cells].map((c) => [(k += c.colSpan) - c.colSpan, c]);
  };
  const kind = {}; // column -> "l" | "c" | "r"
  for (const r of t.tBodies.length ? [...t.tBodies].flatMap((b) => [...b.rows]) : [])
    for (const [k, c] of at(r)) {
      if (c.colSpan > 1 || kind[k] === "l") continue;
      const ctl = c.querySelector("button, input:not([type=number]), select, svg, .dist"); // a number box is a number
      let txt = c.textContent;
      if (ctl) for (const b of c.querySelectorAll("button, output")) txt = txt.replace(b.textContent, "");
      txt = txt.replace(/\s+/g, "");
      if (txt && !/^[—–-]$/.test(txt) && !AL_NUM.test(txt)) kind[k] = "l";
      else if (ctl) kind[k] = "c";
      else if (txt && !kind[k]) kind[k] = "r";
    }
  for (const r of t.rows)
    for (const [k, c] of at(r)) {
      if (c.colSpan > 1) continue;
      c.classList.remove("al-l", "al-c", "al-r");
      c.classList.add("al-" + (kind[k] || (k ? "r" : "l"))); // no data yet: the first column is the label column
    }
}
export const teamCode = (team) => (TEAMS[team] && TEAMS[team].code) || team;
export const code = (a) => (a.kind === "D" ? a.tla : (TEAMS[a.team] && TEAMS[a.team].code) || a.tla);
export const col = (a) => (TEAMS[a.team] && TEAMS[a.team].color) || "#888";
export const isDriver = (id) => byId[id] && byId[id].kind === "D";
export const sameTeam = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
export const upcoming = DATA.schedule.filter((g) => !DATA.done.includes(g.gd));
export const NEXT = upcoming[0] || null;
// After the last race there is nothing to forecast: the forecast views are hidden and the rest work from history.
export const SEASON_OVER = !NEXT;
export const FORECAST_VIEWS = ["calc", "assets", "prices", "practice", "grid", "lab"];
export const Hind = Hindsight.create(DATA, Engine);
// How-it-works text as a small ⓘ popover, not a paragraph on the page (the user's rule, 2026-09-26: explanations sit
// in tooltips). html is trusted markup; "" gives nothing.
export const infoTip = (html) =>
  html
    ? `<details class="info"><summary aria-label="About this">i</summary><div class="infobox">${html}</div></details>`
    : "";
