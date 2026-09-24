// The page's saved-settings handling (web/js/state.js): migrations, a new season, defaults not shared.
// Loads the real page scripts into a sandbox with this season's data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT, loadData } = require("./helpers.js");

const D = loadData();
const opt = { skip: D ? false : "no cache/data.json" };

function page() {
  const store = {};
  const ctx = vm.createContext({
    Engine: require("../engine.js"),
    Hindsight: require("../hindsight.js"),
    localStorage: {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    structuredClone,
  });
  const src = (f) => fs.readFileSync(path.join(ROOT, "web", "js", f), "utf8");
  vm.runInContext(src("core.js").replace(/\/\*__DATA__\*\/\s*null/, JSON.stringify(D)), ctx);
  vm.runInContext(src("state.js"), ctx);
  // results come back through JSON: objects from the sandbox have its own prototypes
  return (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
}
const drivers = () => D.assets.filter((a) => a.kind === "D" && a.active).map((a) => a.id);
const cons = () => D.assets.filter((a) => a.kind === "C").map((a) => a.id);
const lineup = () => drivers().slice(0, 5).concat(cons().slice(0, 2));

test("defaults are fresh objects every time", opt, () => {
  const run = page();
  assert.equal(
    run("(() => { const a = defaults(); a.teams[0].name = 'x'; a.marks.q = 1; return defaults(); })()").teams[0].name,
    "Team 1",
  );
  assert.deepEqual(run("defaults().marks"), {});
});

test("an old single-team save is migrated to the current shape", opt, () => {
  const run = page();
  const saved = {
    v: D.season,
    team: lineup(),
    bank: 1.5,
    free: 1,
    valW: 0,
    sims: 5000,
    sims10k: true,
    hdCap: "team",
    active: 1,
  };
  const s = run(`loadState(${JSON.stringify(saved)})`);
  assert.equal(s.schema, run("SCHEMA"));
  assert.deepEqual(s.teams[0].team, lineup());
  assert.equal(s.teams[0].bank, 1.5);
  assert.equal(s.teams.length, 3);
  assert.equal(s.sims, 5000); // already moved to 10k once; the user's later choice stands
  assert.equal(s.xdp, false);
  assert.equal(s.valW, 1);
  assert.equal(s.maxPen, null);
  assert.equal(s.hdCap, "team:1");
  assert.ok(!("team" in s) && !("sims10k" in s) && !("v" in s));
  assert.equal(run(`loadState(${JSON.stringify({ ...saved, sims10k: false })})`).sims, 10000);
});

test("a new season keeps settings and team names, not line-ups", opt, () => {
  const run = page();
  const saved = {
    v: D.season - 1,
    schema: 3,
    halfLife: 6,
    heat: false,
    marks: { x: "lock" },
    adj: { y: 1 },
    teams: [{ name: "Mine", team: ["gone1", "gone2"], bank: 3 }],
  };
  const s = run(`loadState(${JSON.stringify(saved)})`);
  assert.equal(s.halfLife, 6);
  assert.equal(s.heat, false);
  assert.equal(s.teams[0].name, "Mine");
  assert.equal(s.teams[0].example, true);
  assert.deepEqual(s.marks, {});
  assert.deepEqual(s.adj, {});
  assert.equal(s.carriedFrom, D.season - 1);
});

test("assets that no longer exist are dropped", opt, () => {
  const run = page();
  const s = run(
    `loadState(${JSON.stringify({ v: D.season, schema: 3, teams: [{ name: "A", team: ["nope"].concat(lineup().slice(1)) }], pins: [{ ids: ["nope"] }], drafts: [{ name: "d", team: ["nope"] }] })})`,
  );
  assert.equal(s.teams[0].example, true, "an incomplete team falls back to the example");
  assert.deepEqual(s.pins, []);
  assert.deepEqual(s.drafts, []);
});
