// Model health (npm run accuracy; refresh.py runs it after each fetch): how the model did on every round whose points
// are certified, written to history/<season>/accuracy.json for the Sim lab's Model health panel.
//   frozen   the projection the site showed at lock (history/<season>/projections) vs the certified points: what
//            users actually saw. From R15, the first round frozen.
//   walk     the walk-forward check (backtest section 6, the model as shipped): the data as it stood before each
//            round, projected with today's engine, scored with exact CRPS. Moves when the engine changes.
// Recomputed only when the engine, the evaluation or a certified round's points change (the key), so most builds
// skip it. N and seed as in section 6.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const W = require("./walk.js");
const { D, E, mean } = W;

const N = +(process.env.ACC_N || 3000);
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "history", String(D.season), "accuracy.json");
const FROM = 5; // walk-forward needs a few rounds of this season first (as section 6)

// F1 Fantasy certifies a race's points hours after it (MatchStatus 4); until then they can still change
const certified = D.done.filter((gd) => {
  const g = D.schedule.find((x) => x.gd === gd);
  return g && g.certified !== false;
});
const pts = (a, gd) => {
  const h = a.hist.find((x) => x && x.gd === gd);
  return h && h.active ? h.pts : null;
};
const key = crypto
  .createHash("sha1")
  .update(fs.readFileSync(path.join(ROOT, "engine.js")))
  .update(fs.readFileSync(path.join(__dirname, "walk.js")))
  .update(fs.readFileSync(__filename))
  .update(JSON.stringify(certified.map((gd) => [gd, D.assets.map((a) => pts(a, gd))])))
  .digest("hex")
  .slice(0, 12);

const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
if (old && old.key === key && !process.argv.includes("--force")) {
  console.log(`  model health: up to date (rounds to R${certified[certified.length - 1]})`);
  process.exit(0);
}

const r2 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100);

// the projection frozen at lock vs the certified points
function frozen(gd) {
  const f = path.join(ROOT, "history", String(D.season), "projections", `gd${String(gd).padStart(2, "0")}.json`);
  if (!fs.existsSync(f)) return null;
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  const rows = [];
  for (const [id, v] of Object.entries(p.assets)) {
    const a = D.assets.find((x) => x.id === id);
    const y = a && pts(a, gd);
    if (y == null) continue;
    rows.push({ id, name: a.kind === "D" ? a.tla : a.name, x: v.x, y, in50: y >= v.p25 && y <= v.p75 });
  }
  if (!rows.length) return null;
  const miss = rows
    .slice()
    .sort((a, b) => Math.abs(b.y - b.x) - Math.abs(a.y - a.x))
    .slice(0, 6)
    .map((r) => ({ name: r.name, x: r2(r.x), y: r.y }));
  return {
    n: rows.length,
    mae: r2(mean(rows.map((r) => Math.abs(r.x - r.y)))),
    bias: r2(mean(rows.map((r) => r.x - r.y))),
    rho: r2(
      E.spearman(
        rows.map((r) => r.x),
        rows.map((r) => r.y),
      ),
    ),
    in50: r2(rows.filter((r) => r.in50).length / rows.length),
    miss,
  };
}

const t0 = Date.now();
const rounds = certified.filter((gd) => gd >= FROM);
const ev = rounds.length ? W.evaluate({ N, rounds, decision: true }) : null;
const byRound = Object.fromEntries(((ev && ev.byRound) || []).map((b, i) => [b.gd, { ...b, team: ev.perRound[i] }]));
const out = {
  generated: new Date().toISOString().slice(0, 16) + "Z",
  key,
  N,
  rounds: certified.map((gd) => {
    const b = byRound[gd];
    return {
      gd,
      frozen: frozen(gd),
      walk: b ? { crps: r2(b.crps), mae: r2(b.mae), bias: r2(b.bias), rho: r2(b.rho), team: b.team } : null,
    };
  }),
  season: ev
    ? {
        from: FROM,
        crps: r2(ev.crps),
        mae: r2(ev.mae),
        maeD: r2(ev.maeD),
        maeC: r2(ev.maeC),
        bias: r2(ev.bias),
        rho: r2(ev.rho),
        cover80: r2(ev.cover80),
        cover50: r2(ev.cover50),
        team: ev.team,
        best: ev.best,
        baselines: Object.fromEntries(Object.entries(W.baselines()).map(([k, v]) => [k, r2(v)])),
      }
    : null,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(
  `  model health: R${rounds[0] ?? "-"}-R${certified[certified.length - 1]} walk-forward CRPS ${out.season?.crps}, MAE ${out.season?.mae} (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
);
