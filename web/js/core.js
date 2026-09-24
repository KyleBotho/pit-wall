/* Pit Wall page: shared data, DOM helpers and formatters. The page's scripts are plain (non-module) scripts that
   share one global scope, loaded in the order web/app.html lists them; refresh.py inlines them all. */
const DATA = /*__DATA__*/ null;
const CFG = DATA.cfg || { teams: {}, defaultTeam: { drivers: [], constructors: [] }, field: 22 };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const f1 = (x) => (x == null || isNaN(x) ? "—" : (Math.round(x * 10) / 10).toFixed(1));
const f0 = (x) => (x == null || isNaN(x) ? "—" : Math.round(x).toString());
const sgn = (x, d = 1) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d);
const money = (x) => "$" + x.toFixed(1) + "m";
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
const shortDate = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

// team colours and constructor codes from config/season.json
const TEAMS = Object.fromEntries(Object.entries(CFG.teams).filter(([k]) => !k.startsWith("_")));
const CHIPS = [
  ["x3", "X3", "x3 Boost"],
  ["limitless", "LL", "Limitless"],
  ["wildcard", "WC", "Wildcard"],
  ["noneg", "NN", "No Negative"],
  ["autopilot", "AP", "Autopilot"],
  ["finalfix", "FF", "Final Fix"],
];
const chipName = (k) => (CHIPS.find(([c]) => c === k) || [])[2] || "";
const chipShort = (k) => (CHIPS.find(([c]) => c === k) || [])[1] || "";

const byId = Object.fromEntries(DATA.assets.map((a) => [a.id, a]));
/* ---------- table alignment, the same in every table ----------
   Text left, numbers right, controls (buttons, toggles, mini charts) centred, number boxes right; each header follows its column. Decided
   per column from its cells (main.js re-runs it whenever a table's content changes), so no table needs its own
   alignment rules. A cell with a control and a name (Compare's team + ✎) counts as text. */
const AL_NUM = /^[#−+\-–]?\$?\d[\d.,]*[%mM×]?(?:[−+\-–/·][−+-]?\$?\d[\d.,]*[%mM×]?)*[✓?▲▼]?$/;
function alignTable(t) {
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
      c.classList.add("al-" + (kind[k] || "r"));
    }
}
const teamCode = (team) => (TEAMS[team] && TEAMS[team].code) || team;
const code = (a) => (a.kind === "D" ? a.tla : (TEAMS[a.team] && TEAMS[a.team].code) || a.tla);
const col = (a) => (TEAMS[a.team] && TEAMS[a.team].color) || "#888";
const isDriver = (id) => byId[id] && byId[id].kind === "D";
const sameTeam = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
const upcoming = DATA.schedule.filter((g) => !DATA.done.includes(g.gd));
const NEXT = upcoming[0] || null;
// After the last race there is nothing to forecast: the forecast views are hidden and the rest work from history.
const SEASON_OVER = !NEXT;
const FORECAST_VIEWS = ["calc", "assets", "prices", "practice", "grid"];
const Hind = Hindsight.create(DATA, Engine);
