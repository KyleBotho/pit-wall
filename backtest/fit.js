// Fit the simulation's settings on this season, walk-forward (npm run fit). Coordinate descent: each setting in
// turn tries a few values with the others held, keeping whichever gives the lowest CRPS of the projected points
// (CRPS rewards both a good mean and an honest spread). Prints the best values; copy them into engine.js (SIM /
// MODEL, marked "fitted") and re-run `npm run backtest`. Uses the same rounds and seeds for every trial (common
// random numbers), so differences are the settings', not the dice's.
// --save: also write the result to history/<season>/fit.json as a proposal (the weekly fit workflow), shown in the
// Sim lab's Model health panel; the owner decides, and a change goes into engine.js by hand.
// Held out, repeated (second review: fitting and judging on the same rounds flatters the fit; the reviews' deferred
// item: one split is one draw): each of the last FIT_FOLDS rounds (default 3) gets its own fit on the rounds before
// it only, and that fit is scored against the shipped settings on the round (paired, other seeds): `holdout` in
// fit.json, the mean gain over the folds with its standard error. That tests the fitting itself. The proposal is
// then fitted on every round; each of its changes says how many folds chose the same. Adopt only with a gain in the
// folds beyond ~2 SE and changes the folds agree on.
const fs = require("node:fs");
const path = require("node:path");
const W = require("./walk.js");
const { E } = W;
const SAVE = process.argv.includes("--save");

const N = +(process.env.FIT_N || 4000);
const PASSES = +(process.env.FIT_PASSES || 1);
const FOLDS = +(process.env.FIT_FOLDS ?? 3);
const MIN_TRAIN = 3; // rounds a fold's fit needs before its test round
const ALL = W.D.done.filter((g) => g >= 5);
const TESTS = ALL.slice(-FOLDS).filter((gd) => ALL.indexOf(gd) >= MIN_TRAIN);
// [object, key, candidate values]
const SPACE = [
  [E.MODEL, "paceShrink", [0.5, 0.6, 0.7, 0.8, 0.9, 1]],
  [E.SIM, "qSd", [0.12, 0.16, 0.2, 0.25, 0.3, 0.4]],
  [E.SIM, "rSd", [0.15, 0.2, 0.25, 0.3, 0.4, 0.5]],
  [E.SIM, "teamSd", [0, 0.05, 0.1, 0.15, 0.2]],
  [E.SIM, "drvSd", [0, 0.05, 0.08, 0.12, 0.16]],
  [E.SIM, "tau", [0.02, 0.03, 0.04, 0.05, 0.07, 0.1]],
  [E.SIM, "unc", [0, 0.5, 1, 1.5]],
  [E.SIM, "scNoise", [1, 1.2, 1.35, 1.6, 2]],
  [E.SIM, "incident", [0, 0.15, 0.3, 0.45]],
  [E.SIM, "oddsW", [0, 0.25, 0.5, 0.75, 1]],
  [E.SIM, "flDecay", [0.8, 1.1, 1.6, 2.2]],
  [E.SIM, "scPerDnf", [0.05, 0.1, 0.15, 0.25]],
  [E.MODEL, "prior", [0.5, 1, 1.5, 3, 5]],
  [E.MODEL, "gapCap", [2, 3, 4, 6]],
  [E.MODEL, "ovShrink", [3, 6, 12, 25, 1e6]],
  [E.SIM, "ovModel", [0, 1]],
  [E.SIM, "pitStops", [0, 1]],
];
const label = ([obj, key]) => `${obj === E.SIM ? "SIM" : "MODEL"}.${key}`;
const shipped = SPACE.map(([obj, key]) => obj[key]);
const setAll = (vals) => SPACE.forEach(([obj, key], i) => (obj[key] = vals[i]));
const fmt = (r) =>
  `CRPS ${r.crps.toFixed(3)}  MAE ${r.mae.toFixed(3)}  rho ${r.rho.toFixed(3)}  80% ${(100 * r.cover80).toFixed(1)}%  50% ${(100 * r.cover50).toFixed(1)}%  logQ ${r.lsQ.toFixed(3)}  logR ${r.lsR.toFixed(3)}`;
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Coordinate descent from the shipped settings on `rounds`: {start, best, vals}. Leaves the shipped settings set. */
function search(rounds, log) {
  setAll(shipped);
  const score = () => W.evaluate({ N, seed: 3, rounds });
  let best = score();
  const start = best;
  if (log) console.log(`start      ${fmt(best)}`);
  for (let pass = 0; pass < PASSES; pass++)
    for (const [obj, key, vals] of SPACE) {
      const keep = obj[key];
      let bestV = keep;
      for (const v of vals) {
        if (v === keep) continue;
        obj[key] = v;
        const r = score();
        if (r.crps < best.crps - 0.005) {
          best = r;
          bestV = v;
        }
      }
      obj[key] = bestV;
      if (log) console.log(`${key.padEnd(10)} ${String(bestV).padEnd(6)} ${fmt(best)}`);
    }
  const vals = SPACE.map(([obj, key]) => obj[key]);
  setAll(shipped);
  return { start, best, vals };
}

/** Round gd's CRPS under the given settings, averaged over two seeds the search never used. */
function scoreOn(gd, vals) {
  setAll(vals);
  const c = W.mean([11, 12].map((seed) => W.evaluate({ N, seed, rounds: [gd] }).crps));
  setAll(shipped);
  return c;
}

const t0 = Date.now();
// the folds: each test round scored by a fit that never saw it
const folds = TESTS.map((gd) => {
  const train = ALL.slice(0, ALL.indexOf(gd));
  const fit = search(train, false);
  const a = scoreOn(gd, shipped),
    b = scoreOn(gd, fit.vals);
  const changes = SPACE.map((s, i) => ({ setting: label(s), fitted: fit.vals[i] })).filter(
    (c, i) => c.fitted !== shipped[i],
  );
  console.log(
    `fold R${gd} (fitted on R${train[0]}-R${train[train.length - 1]}): shipped ${a.toFixed(3)}, fitted ${b.toFixed(3)}` +
      ` (${b - a > 0 ? "+" : ""}${(b - a).toFixed(3)}); ${changes.map((c) => `${c.setting} ${c.fitted}`).join(", ") || "no changes"}`,
  );
  return { gd, train: [train[0], train[train.length - 1]], shipped: r3(a), fitted: r3(b), dCrps: r3(b - a), changes };
});
let holdout = null;
if (folds.length) {
  const d = folds.map((f) => f.dCrps);
  const m = W.mean(d),
    se = d.length > 1 ? Math.sqrt(d.reduce((t, x) => t + (x - m) ** 2, 0) / (d.length - 1) / d.length) : NaN;
  holdout = {
    rounds: folds.map((f) => f.gd),
    shipped: r3(W.mean(folds.map((f) => f.shipped))),
    fitted: r3(W.mean(folds.map((f) => f.fitted))),
    dCrps: r3(m),
    se: Number.isFinite(se) ? r3(se) : null,
    folds,
  };
  console.log(`held out R${holdout.rounds.join(", R")}: fitted - shipped CRPS ${m.toFixed(3)} ± ${se.toFixed(3)}\n`);
}
// the proposal: fitted on every round
const fit = search(ALL, true);
setAll(fit.vals);
console.log("\nbest settings:");
for (const s of SPACE) console.log(`  ${label(s)} = ${s[0][s[1]]}`);
const changes = SPACE.map((s, i) => ({
  setting: label(s),
  shipped: shipped[i],
  fitted: fit.vals[i],
  // how many folds' fits made the same change (a change only the full fit makes is fragile)
  folds: folds.filter((f) => f.changes.some((c) => c.setting === label(s) && c.fitted === fit.vals[i])).length,
})).filter((c) => c.shipped !== c.fitted);
for (const c of changes) console.log(`  ${c.setting}: chosen by ${c.folds} of ${folds.length} folds`);
if (SAVE) {
  const sum = (r) => ({
    crps: r3(r.crps),
    mae: r3(r.mae),
    rho: r3(r.rho),
    cover80: r3(r.cover80),
    cover50: r3(r.cover50),
  });
  const out = {
    generated: new Date().toISOString().slice(0, 16) + "Z",
    N,
    passes: PASSES,
    rounds: ALL,
    holdout,
    shipped: sum(fit.start),
    fitted: sum(fit.best),
    changes,
    minutes: Math.round((Date.now() - t0) / 6000) / 10,
  };
  const f = path.join(__dirname, "..", "history", String(W.D.season), "fit.json");
  fs.writeFileSync(f, JSON.stringify(out, null, 1) + "\n");
  console.log(`saved ${path.relative(path.join(__dirname, ".."), f)}`);
}
