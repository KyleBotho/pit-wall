/* ---------- state: everything the user sets, saved in this browser and (signed in) synced to the account ----------
   `state` is the one settings object. Its shape is versioned: SCHEMA is the current version and MIGRATIONS[n]
   turns a version-n object into version n+1. Everything read from localStorage or the account goes through
   loadState(): migrate, carry settings over from an older season, fill in defaults, drop what no longer fits. */
const KEY = "pitwall.v1";
const SCHEMA = 3;
const VIEWS = ["calc", "live", "league", "elite", "hind", "stats", "assets", "prices", "practice", "grid", "settings"];

// the example team a new browser starts with (config/season.json defaultTeam)
function defaultTeam() {
  const d = CFG.defaultTeam.drivers
    .map((t) => DATA.assets.find((a) => a.kind === "D" && a.active && a.tla === t))
    .filter(Boolean);
  const c = CFG.defaultTeam.constructors
    .map((n) => DATA.assets.find((a) => a.kind === "C" && a.team === n))
    .filter(Boolean);
  const ids = d.concat(c).map((a) => a.id);
  const cost = ids.reduce((s, i) => s + byId[i].price, 0);
  return { team: ids, bank: Math.max(0, Math.round((110 - cost) * 10) / 10) };
}
const newTeam = (name) => ({ name, free: 2, chipsUsed: {}, boost: "auto", example: true, ...defaultTeam() });
// A fresh default settings object every call, so nothing is shared by reference between loads.
const defaults = () => ({
  schema: SCHEMA,
  teams: [newTeam("Team 1"), newTeam("Team 2"), newTeam("Team 3")],
  active: 0,
  drafts: [],
  halfLife: Engine.DEFAULTS.halfLife,
  blend: Engine.DEFAULTS.blend,
  sims: Engine.DEFAULTS.sims,
  pw: Engine.DEFAULTS.pw,
  adj: {},
  marks: {},
  circuits: {},
  heat: true,
  horizon: 1,
  chip: "",
  valW: 1,
  xdp: false,
  maxPen: null,
  pins: [],
  xo: {},
  rivalCfg: {},
  syncKey: true,
  // the Calculator's Simulation preset: "sim" (Monte Carlo) or a past-performance one (classic, weighted, form, ppm)
  simPreset: "sim",
  simDecay: 0.9, // weighted: each older round counts this much of the next
  simWin: 5, // form: rounds averaged
  simW: {}, // per-round weights set by hand (gameday -> 0..1), on top of the preset's
  simOff: [], // scoring categories left out of the past-performance presets
  simSprint: null, // {gd, v}: the next race simulated as a sprint weekend (v) or not; null = the calendar
  view: SEASON_OVER ? "hind" : "calc",
  pane: "best",
  calcGrp: {}, // the Calculator's Settings sections: key -> open (true unless closed by the user)
  bmode: "best", // the Calculator's left pane: "best" (Best Teams) or "cmp" (Compare)
  sub: {}, // the view last open in each tool group (main.js GROUPS)
  kind: "D",
  raceIdx: 0,
  grid: "r",
  sort: { k: "x", d: -1 },
});

const MIGRATIONS = [
  // 0 -> 1: saved before multi-team support: that team becomes Team 1
  (s) => {
    if (!s.teams && s.team) {
      s.teams = [
        {
          name: "Team 1",
          team: s.team,
          bank: s.bank,
          free: s.free || 2,
          chipsUsed: s.chipsUsed || {},
          boost: s.boost || "auto",
          example: !!s.example,
        },
      ];
      for (const k of ["team", "bank", "free", "chipsUsed", "boost", "example"]) delete s[k];
    }
  },
  // 1 -> 2: 10,000 simulations became the default
  (s) => {
    if (!s.sims10k) s.sims = 10000;
    delete s.sims10k;
  },
  // 2 -> 3: calculator rework (price points became a toggle + slider, max transfers became a max penalty);
  // Hindsight's "team" budget became one button per team
  (s) => {
    if (s.xdp == null) {
      s.xdp = s.valW > 0;
      if (!s.valW) s.valW = 1;
    }
    if (s.maxPen === undefined) s.maxPen = null;
    delete s.maxT;
    if (s.hdCap === "team") s.hdCap = "team:" + (s.active | 0);
    if (s.pane === "team") s.pane = "best";
  },
];

// Settings that mean the same in any season. The rest (teams, marks, nudges, pins, filters on points...) refer to
// one season's assets, so a new season starts them fresh and keeps only the team names.
const CARRY = [
  "halfLife",
  "blend",
  "sims",
  "pw",
  "heat",
  "horizon",
  "valW",
  "xdp",
  "maxPen",
  "view",
  "pane",
  "bmode",
  "sub",
  "kind",
  "grid",
  "sort",
  "bcols",
  "bsort",
  "lgMode",
  "lgChips",
  "elMode",
  "stKind",
  "stMetric",
  "lvKind",
  "lvBy",
  "hdCap",
  "hdChip",
  "showN",
  "syncKey",
  "simPreset",
  "simDecay",
  "simWin",
  "simOff",
  "calcGrp",
];
function carryOver(old) {
  const s = defaults();
  for (const k of CARRY) if (old[k] !== undefined) s[k] = old[k];
  (old.teams || []).slice(0, 3).forEach((t, i) => t && t.name && (s.teams[i].name = t.name));
  s.carriedFrom = old.v;
  return s;
}

// saved settings (this browser's, or the account's) -> the current shape
function loadState(saved) {
  if (!saved || typeof saved !== "object") return defaults();
  let s = structuredClone(saved);
  for (let v = s.schema || 0; v < SCHEMA; v++) MIGRATIONS[v](s);
  s.schema = SCHEMA;
  if (s.v != null && s.v !== DATA.season) s = carryOver(s);
  delete s.v;
  s = Object.assign(defaults(), s);
  normalise(s);
  return s;
}
function normalise(s) {
  s.teams = (s.teams || []).slice(0, 3);
  while (s.teams.length < 3) s.teams.push(newTeam("Team " + (s.teams.length + 1)));
  for (const t of s.teams) {
    t.team = (t.team || []).filter((id) => byId[id]);
    if (t.team.length !== 7) Object.assign(t, defaultTeam(), { example: true });
    t.chipsUsed = t.chipsUsed || {};
    t.boost = t.boost || "auto";
  }
  s.drafts = (s.drafts || [])
    .filter((d) => d.team && d.team.filter((id) => byId[id]).length === 7)
    .map((d) => ({ bank: 0, free: 2, chipsUsed: {}, boost: "auto", ...d }));
  s.active = Math.min(2, Math.max(0, s.active | 0));
  if (s.calcStart && s.calcStart.type === "draft" && !s.drafts[s.calcStart.i]) s.calcStart = null;
  s.pins = (s.pins || []).filter((p) => p.ids && p.ids.every((id) => byId[id]));
  if (!s.sub || typeof s.sub !== "object") s.sub = {};
  if (s.view === "compare") Object.assign(s, { view: "calc", bmode: "cmp" }); // Compare moved into the Calculator
  if (s.view === "cal" || s.view === "model") s.view = "settings"; // both moved into Settings (2026-09-24)
  if (!VIEWS.includes(s.view) || (SEASON_OVER && FORECAST_VIEWS.includes(s.view)))
    s.view = SEASON_OVER ? "hind" : "calc";
}

let state = defaults();
try {
  state = loadState(JSON.parse(localStorage.getItem(KEY) || "null"));
} catch (e) {
  state = defaults();
}
const activeTeam = () => state.teams[state.active];
